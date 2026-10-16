#!/usr/bin/env python3
"""
smart_crop.py - decide how to frame one clip vertically (9:16): who is on
camera, who is talking, and whether to follow the speaker or show two people
in a split screen.

Usage:
    python3 smart_crop.py <video_path> --start 0 --end 30 \
        --width 1920 --height 1080 [--model face_detection_yunet.onnx]

--width/--height are the video's DISPLAY dimensions (after any rotation
flag is applied), which is what ffmpeg hands us when it decodes.

Prints one JSON object:
    {"layout": "single" | "split" | "facecam" | "screen" | "group",
     "keyframes": [{"t": 0.0, "cx": 0.31, "cut": true}, ...],
     "split": {"top":    {"keyframes": [...], "y": 0.12, "h": 0.62},
               "bottom": {"keyframes": [...], "y": 0.10, "h": 0.60}} | null,
     "facecam": {"cam": {"x": 0.01, "y": 0.69, "w": 0.24, "h": 0.29},
                 "found": "border" | "guess", "kind": "game" | "screen",
                 "face": [...], "faceY": 0.8, "content": [...]} | null,
     "group": [{"keyframes": [...], "faceY": 0.45, "faceH": 0.2}, ...] | null,
     "stats": {...}}

  layout    = what looks best: follow whoever talks, split screen, a
              facecam over gameplay or a screen, or 3-4 people in a grid
  keyframes = the crop that follows whoever talks
  split     = the two main people stacked (top = the one further left in
              the frame), whenever there are two - so the editor can switch
              to split screen even when it wasn't picked automatically
  facecam   = one person in a fixed box (a webcam over gameplay or a screen
              recording): the box, whether its edges were found in the
              picture or it's a guess around the face, what's around it
              (moving gameplay or a mostly still screen), the face's
              position in it, and a crop that follows the action outside it
  group     = 3-4 people on screen most of the time, left to right: where
              each one is, and how big their face is
  t   = seconds from --start;  cx = face center, normalized 0..1 across the
        frame width;  cut = jump there (true) or pan from the previous
        keyframe (false);  y/h = top and height of a split-screen crop as
        shares of the frame height; faceY/faceH = face center and height
        as shares of the frame height; cam = shares of the frame

How it works:
  1. ffmpeg decodes, rotates and downscales the frames (10 per second) and
     the audio, with the same input seeking as the final render.
  2. YuNet (OpenCV's face detector; bundled ONNX model) finds faces and their
     landmarks. Detections are linked into one track per person.
  3. While there is speech in the audio, mouth movement per person (change
     in the lip area minus overall head movement) says who is talking.
  4. A Viterbi pass picks who to show over time, with a cost per camera
     switch so a short "ja" from the other person doesn't cause a cut.
  5. Two people taking quick turns get a split screen instead.
  6. No faces (sports, gaming, nature) or only tiny ones (a facecam in a
     corner, a crowd far away): the crop follows where things move in the
     picture instead, like a camera operator - camera pans don't count, and
     it only moves when the action leaves the middle of the frame.
  7. One person who stays put: is there a box around them? Straight edges
     that are in the same place all the time and stop at the box's corners
     are a webcam overlay. Lots of motion around it means gameplay, little
     means a screen (slides, code, a website).
  8. Three or four people taking quick turns get a grid instead.

Without the YuNet model it falls back to OpenCV's Haar cascade: no
landmarks, so it simply follows the largest face.
"""
import argparse
import json
import subprocess
import sys
import tempfile

import cv2
import numpy as np

FPS = 10
DETECT_WIDTH = 640
MIN_FACE_SCORE = 0.6
# A person can go undetected this long (turning away, blinking out) and
# still be the same track; their box is interpolated across the gap.
MAX_GAP = 10  # frames
# Tracks seen for less than this, or much smaller than the main faces, are
# ignored (background people, posters, false detections).
MIN_TRACK_FRAMES = 6
MIN_FACE_AREA_RATIO = 0.2
# Viterbi: what a camera switch costs, against per-frame "not the one
# talking" costs of up to 1. Roughly: the other person has to clearly be
# the one talking for a few tenths of a second before the camera cuts.
SWITCH_COST = 2.5
# Mouth movement is averaged over this many frames.
SMOOTH_FRAMES = 5
# Mouth movement (relative to that face's resting level) below this is
# noise - compression flicker, a still image - not someone talking.
MIN_TALK = 1.0
# Camera pans (within one person) follow this fast (0..1 per frame).
PAN_ALPHA = 0.18
MIN_PAN_STEP = 0.01
MAX_KEYFRAMES = 80
# Split screen when two people are both on screen most of the time, both
# talk a fair share, and they take quick turns (a few, mostly short ones).
# Long turns look better as cuts to whoever is talking.
SPLIT_MIN_PRESENCE = 0.6
SPLIT_MIN_SHARE = 0.2
SPLIT_MIN_SWITCHES = 3
SPLIT_MAX_TURN_SECONDS = 4.0
# A split screen is offered (not picked) when both are in view this much.
SPLIT_OPTION_PRESENCE = 0.3
# Following motion instead of faces: frames are split into this many columns,
# pixel changes smaller than MOTION_NOISE are compression flicker, and the
# picture has to change at least MIN_MOTION (mean level) to count as action.
MOTION_BINS = 64
MOTION_NOISE = 12
MIN_MOTION = 0.6
# Faces smaller than this share of the frame height don't steer the crop
# (a facecam over gameplay, people far away); motion does.
TINY_FACE = 0.08
# The crop only follows when the action is further from its middle than
# this share of the crop's width, and then pans slowly.
MOTION_DEAD_ZONE = 0.25
MOTION_PAN_ALPHA = 0.08
# In a split-screen half the face takes up about this much of the height,
# without zooming in past half the frame height (it would get blurry).
SPLIT_FACE_HEIGHT = 0.3
SPLIT_MIN_CROP = 0.5
# Facecam: one person, on screen at least CAM_MIN_PRESENCE of the time,
# whose face is at most CAM_MAX_FACE of the frame height and moves around
# less than CAM_MAX_DRIFT (standard deviation, share of the frame).
CAM_MIN_PRESENCE = 0.5
CAM_MAX_FACE = 0.3
CAM_MAX_DRIFT = 0.04
# The box's edges are looked for in this many frames spread over the clip.
# A pixel is on an edge with a Sobel response of EDGE_MIN (of 1020), and on
# a lasting edge when it is in EDGE_PERSIST of those frames. Each side of
# the box has to be a lasting edge along CAM_SIDE_COVER of its length, and
# must not go on past the box's corners (at most CAM_MAX_BEYOND of a stretch).
CAM_SAMPLES = 30
EDGE_MIN = 40
EDGE_PERSIST = 0.7
CAM_SIDE_COVER = 0.75
CAM_MAX_BEYOND = 0.35
CAM_MAX_AREA = 0.4
# A webcam box is at most this many face widths wide and face heights tall.
CAM_MAX_WIDTH = 14
CAM_MAX_HEIGHT = 9
# Around the webcam: gameplay when the picture moves in at least this share
# of the frames, otherwise a screen (slides, code, a website) - if there is
# something to see: at least this share of the pixels around the box are on
# an edge (text, buttons, pictures). A box on a plain background isn't a
# webcam over a screen.
GAME_MOTION_SHARE = 0.4
SCREEN_MIN_DETAIL = 0.03
# Group: 3-4 people each on screen at least this share of the time, at
# least this far apart (share of the frame width).
GROUP_MIN_PRESENCE = 0.5
GROUP_MIN_GAP = 0.1
# ... picked automatically when at least three of them talk this share each.
GROUP_MIN_SHARE = 0.1


def run_ffmpeg_pipe(cmd, chunk):
    """Yield fixed-size chunks from an ffmpeg command's stdout."""
    errlog = tempfile.TemporaryFile()  # a stderr pipe could fill up and stall ffmpeg
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errlog)
    try:
        while True:
            buf = proc.stdout.read(chunk)
            if len(buf) < chunk:
                break
            yield buf
    finally:
        proc.stdout.close()
        code = proc.wait()
        errlog.seek(0)
        err = errlog.read().decode('utf-8', 'replace')
        errlog.close()
        if code not in (0, None) and code != -13:  # -13: we stopped reading early
            print(json.dumps({'warning': f'ffmpeg exited {code}: {err[-300:]}'}), file=sys.stderr)


def read_frames(args, det_w, det_h):
    cmd = [
        'ffmpeg', '-v', 'error',
        '-ss', str(args.start), '-t', str(max(0.1, args.end - args.start)),
        '-i', args.video_path, '-an', '-sn',
        '-vf', f'fps={FPS},scale={det_w}:{det_h}',
        '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1',
    ]
    size = det_w * det_h * 3
    for buf in run_ffmpeg_pipe(cmd, size):
        yield np.frombuffer(buf, dtype=np.uint8).reshape(det_h, det_w, 3)


def read_speech(args, frames):
    """Per video frame: is there speech (loud enough audio)? None if no audio."""
    rate = 16000
    cmd = [
        'ffmpeg', '-v', 'error',
        '-ss', str(args.start), '-t', str(max(0.1, args.end - args.start)),
        '-i', args.video_path, '-vn', '-sn', '-ac', '1', '-ar', str(rate),
        '-f', 's16le', 'pipe:1',
    ]
    hop = rate // FPS
    levels = []
    for buf in run_ffmpeg_pipe(cmd, hop * 2):
        samples = np.frombuffer(buf, dtype='<i2').astype(np.float32)
        levels.append(float(np.sqrt(np.mean(samples * samples))))
    if not levels:
        return None
    levels = np.array(levels[:frames] + [0.0] * max(0, frames - len(levels)))
    loud = np.percentile(levels, 90)
    if loud <= 0:
        return np.zeros(frames, dtype=bool)
    return levels >= 0.15 * loud


class Detector:
    def __init__(self, model, det_w, det_h):
        self.yunet = None
        if model:
            try:
                self.yunet = cv2.FaceDetectorYN.create(model, '', (det_w, det_h), MIN_FACE_SCORE, 0.3, 50)
            except Exception as err:  # noqa: BLE001
                print(json.dumps({'warning': f'YuNet unavailable, using Haar: {err}'}), file=sys.stderr)
        if self.yunet is None:
            self.haar = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        self.min_size = max(24, det_w // 24)

    def detect(self, frame, gray):
        """[(x, y, w, h, landmarks or None)] in detection-frame pixels."""
        if self.yunet is not None:
            _, faces = self.yunet.detect(frame)
            if faces is None:
                return []
            return [(f[0], f[1], f[2], f[3], f[4:14].reshape(5, 2)) for f in faces if f[14] >= MIN_FACE_SCORE]
        faces = self.haar.detectMultiScale(gray, 1.15, 5, minSize=(self.min_size, self.min_size))
        return [(float(x), float(y), float(w), float(h), None) for (x, y, w, h) in faces]


def camera_shift(prev, cur):
    """
    How far the whole picture moved between two frames (a panning or tilting
    camera): the median movement of up to 200 tracked points. Most points sit
    on the background, so a player or ball moving on its own doesn't count.
    """
    points = cv2.goodFeaturesToTrack(prev, maxCorners=200, qualityLevel=0.01, minDistance=8)
    if points is None or len(points) < 12:
        return 0.0, 0.0
    moved, status, _ = cv2.calcOpticalFlowPyrLK(prev, cur, points, None, winSize=(21, 21), maxLevel=3)
    ok = status.reshape(-1) == 1
    if ok.sum() < 12:
        return 0.0, 0.0
    delta = (moved - points).reshape(-1, 2)[ok]
    return float(np.median(delta[:, 0])), float(np.median(delta[:, 1]))


def motion_profile(prev, cur, edges, mask=None):
    """
    How much the picture changed in each column band since the last frame,
    after lining the frames up: a camera that pans or tilts moves everything,
    so that shift is taken out first (see camera_shift). Pixels in `mask`
    (a webcam box) don't count.
    """
    dx, dy = camera_shift(prev, cur)
    a = cv2.GaussianBlur(prev, (5, 5), 0).astype(np.float32)
    b = cv2.GaussianBlur(cur, (5, 5), 0).astype(np.float32)
    margin = 0
    if (abs(dx) > 0.5 or abs(dy) > 0.5) and abs(dx) < a.shape[1] / 4:
        shift = np.float32([[1, 0, dx], [0, 1, dy]])
        a = cv2.warpAffine(a, shift, (a.shape[1], a.shape[0]), borderMode=cv2.BORDER_REPLICATE)
        margin = int(np.ceil(abs(dx))) + 2
    diff = np.abs(b - a)
    diff[diff < MOTION_NOISE] = 0
    if margin:  # the strip the shift uncovered is made up
        if dx > 0:
            diff[:, :margin] = 0
        else:
            diff[:, -margin:] = 0
    if mask is not None:
        diff[mask] = 0
    columns = diff.sum(axis=0, dtype=np.float64)
    return np.add.reduceat(columns, edges[:-1]) / diff.shape[0]


def motion_positions(profiles, crop_share):
    """
    Per frame: the horizontal center (0..1) of where the action is, or None.
    Movement all over the picture (a camera pan, a cut) is taken off first,
    so only what moves against the background counts. Then the crop-wide
    window with the most movement wins.
    """
    window = max(1, int(round(crop_share * MOTION_BINS)))
    positions = []
    for bins in profiles:
        if bins is None:
            positions.append(None)
            continue
        local = np.clip(bins - np.median(bins), 0, None)
        if local.mean() < MIN_MOTION:
            positions.append(None)
            continue
        sums = np.convolve(local, np.ones(window), mode='valid')
        best = int(np.argmax(sums))
        part = local[best:best + window]
        center = best + (np.arange(part.size) * part).sum() / max(part.sum(), 1e-9)
        positions.append(float((center + 0.5) / MOTION_BINS))
    return positions


def follow_motion(positions, crop_share):
    """
    Keyframes that follow the action calmly: aim at where it is over each
    second, only move when it leaves the middle of the crop, and pan slowly.
    """
    frames = len(positions)
    known = [p for p in positions if p is not None]
    if not known:
        return [{'t': 0.0, 'cx': 0.5, 'cut': True}], False
    per_second = []
    for i in range(0, frames, FPS):
        chunk = [p for p in positions[i:i + FPS] if p is not None]
        per_second.append(float(np.median(chunk)) if chunk else None)
    target = next(p for p in per_second if p is not None)
    aims = []
    for p in per_second:
        if p is not None and abs(p - target) > MOTION_DEAD_ZONE * crop_share:
            target = p
        aims.extend([target] * FPS)
    aims = aims[:frames]

    keyframes = []
    current = aims[0]
    keyframes.append({'t': 0.0, 'cx': current, 'cut': True})
    for i in range(1, frames):
        # Calm most of the time, quicker when the action is about to leave the crop.
        gap = aims[i] - current
        alpha = MOTION_PAN_ALPHA * (1 + 3 * min(1.0, abs(gap) / crop_share))
        current += alpha * gap
        keyframes.append({'t': round(i / FPS, 2), 'cx': current, 'cut': False})
    return simplify(keyframes), True


def motion_pass(args, det_w, det_h, frames, mask=None):
    """A second pass over the frames: the motion profile of each one (None for the first)."""
    edges = np.linspace(0, det_w, MOTION_BINS + 1).astype(int)
    motion = []
    prev = None
    for frame in read_frames(args, det_w, det_h):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        motion.append(motion_profile(prev, gray, edges, mask) if prev is not None else None)
        prev = gray
    return motion[:frames] + [None] * max(0, frames - len(motion))


def action_share(motion):
    """Share of the frames where something moves (against the background)."""
    known = [p for p in motion if p is not None]
    if not known:
        return 0.0
    return sum(1 for p in known if p.mean() >= MIN_MOTION) / len(known)


def lasting_edges(samples):
    """
    Pixels on a vertical / horizontal edge in most of the sampled frames:
    what stays put while the picture changes (a webcam box, a HUD, a still
    background). Widened by a pixel so a soft edge still lines up.
    """
    vertical = np.zeros(samples[0].shape, np.float32)
    horizontal = np.zeros(samples[0].shape, np.float32)
    for gray in samples:
        gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
        gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
        vertical += cv2.dilate((gx >= EDGE_MIN).astype(np.uint8), np.ones((1, 3), np.uint8))
        horizontal += cv2.dilate((gy >= EDGE_MIN).astype(np.uint8), np.ones((3, 1), np.uint8))
    return vertical / len(samples) >= EDGE_PERSIST, horizontal / len(samples) >= EDGE_PERSIST


def run_through(line, a, b):
    """Length of the longest run of True in `line` (gaps of a pixel or two allowed) that overlaps a..b."""
    on = np.flatnonzero(line)
    if on.size == 0:
        return 0
    breaks = np.flatnonzero(np.diff(on) > 3)
    starts = np.concatenate(([on[0]], on[breaks + 1]))
    ends = np.concatenate((on[breaks], [on[-1]]))
    return max((int(e - s + 1) for s, e in zip(starts, ends) if e >= a and s <= b), default=0)


def line_candidates(edges, lo, hi, a, b, min_length, along_rows, limit=6):
    """
    The best places (indices in lo..hi) for a box side: lasting straight
    lines through a..b (the face's rows or columns), longest first.
    """
    size = edges.shape[1] if along_rows else edges.shape[0]
    lo, hi = max(1, int(lo)), min(size - 2, int(hi))
    lengths = {}
    for i in range(lo, hi + 1):
        length = run_through(edges[:, i] if along_rows else edges[i, :], a, b)
        if length >= min_length:
            lengths[i] = length
    picked = []
    for i in sorted(lengths, key=lambda i: -lengths[i]):
        if len(picked) >= limit:
            break
        if all(abs(i - j) > 3 for j in picked):
            picked.append(i)
    return picked


def find_cam_box(samples, face, det_w, det_h):
    """
    The webcam box around a face, from lasting straight edges: (x0, y0, x1,
    y1) in detection pixels, or None. A side can also be the frame's edge
    (a webcam in a corner), but at least two sides have to be found in the
    picture, and every side found has to stop at the box's corners - lines
    in the background (a shelf, a door, a browser's toolbar) go on past them.
    """
    vertical, horizontal = lasting_edges(samples)
    fcx, fcy, fw, fh = face
    fx0, fx1 = int(fcx - fw / 2), int(fcx + fw / 2)
    fy0, fy1 = int(fcy - fh / 2), int(fcy + fh / 2)
    # Vertical sides run past the face's rows, horizontal ones past its columns.
    lefts = line_candidates(vertical, fx0 - CAM_MAX_WIDTH * fw, fx0 - 0.1 * fw, fy0, fy1, 1.4 * fh, True) + [0]
    rights = line_candidates(vertical, fx1 + 0.1 * fw, fx1 + CAM_MAX_WIDTH * fw, fy0, fy1, 1.4 * fh, True) + [det_w]
    tops = line_candidates(horizontal, fy0 - 0.6 * CAM_MAX_HEIGHT * fh, fy0 - 0.1 * fh, fx0, fx1, 1.5 * fw, False) + [0]
    bottoms = line_candidates(horizontal, fy1 + 0.1 * fh, fy1 + CAM_MAX_HEIGHT * fh, fx0, fx1, 1.5 * fw, False) + [det_h]

    def cover(edges, at, a, b, along_rows):
        a, b = int(a) + 3, int(b) - 3
        if b - a < 4:
            return 0.0
        return float(edges[a:b, at].mean() if along_rows else edges[at, a:b].mean())

    def beyond(edges, at, a, b, size, along_rows):
        """How much a side's line goes on past its two ends (0 where the frame ends)."""
        ext = max(6, int(0.2 * (b - a)))
        parts = []
        if a > 0:
            parts.append(edges[max(0, a - ext):max(0, a - 3), at] if along_rows else edges[at, max(0, a - ext):max(0, a - 3)])
        if b < size:
            parts.append(edges[b + 3:b + ext, at] if along_rows else edges[at, b + 3:b + ext])
        parts = [p for p in parts if p.size >= 3]
        return max((float(p.mean()) for p in parts), default=0.0)

    def check(x0, y0, x1, y1):
        """The box's score, or None if it isn't a webcam box."""
        w, h = x1 - x0, y1 - y0
        if w < 1.5 * fw or w > CAM_MAX_WIDTH * fw or h < 1.4 * fh or h > CAM_MAX_HEIGHT * fh:
            return None
        if w * h > CAM_MAX_AREA * det_w * det_h:
            return None
        sides = []
        if x0 > 0:
            sides.append((cover(vertical, x0, y0, y1, True), beyond(vertical, x0, y0, y1, det_h, True)))
        if x1 < det_w:
            sides.append((cover(vertical, x1, y0, y1, True), beyond(vertical, x1, y0, y1, det_h, True)))
        if y0 > 0:
            sides.append((cover(horizontal, y0, x0, x1, False), beyond(horizontal, y0, x0, x1, det_w, False)))
        if y1 < det_h:
            sides.append((cover(horizontal, y1, x0, x1, False), beyond(horizontal, y1, x0, x1, det_w, False)))
        if len(sides) < 2 or any(c < CAM_SIDE_COVER or b > CAM_MAX_BEYOND for c, b in sides):
            return None
        return float(np.mean([c - b for c, b in sides])) + 0.1 * len(sides)

    best, best_key = None, None
    for x0 in lefts:
        for x1 in rights:
            for y0 in tops:
                for y1 in bottoms:
                    score = check(x0, y0, x1, y1)
                    if score is None:
                        continue
                    # The best edges win; about as good: the bigger box (lines
                    # in the room behind the person make smaller ones inside it).
                    key = (round(score, 1), (x1 - x0) * (y1 - y0))
                    if best_key is None or key > best_key:
                        best, best_key = (x0, y0, x1, y1), key
    if best is not None:
        # A frame around the webcam has two lines close together: take the
        # inner one, so none of the frame comes along.
        x0, y0, x1, y1 = best
        near_x, near_y = 0.08 * (x1 - x0), 0.08 * (y1 - y0)
        for x in sorted(c for c in lefts if x0 < c <= x0 + near_x):
            if check(x, y0, x1, y1) is not None:
                x0 = x
        for x in sorted((c for c in rights if x1 - near_x <= c < x1), reverse=True):
            if check(x0, y0, x, y1) is not None:
                x1 = x
        for y in sorted(c for c in tops if y0 < c <= y0 + near_y):
            if check(x0, y, x1, y1) is not None:
                y0 = y
        for y in sorted((c for c in bottoms if y1 - near_y <= c < y1), reverse=True):
            if check(x0, y0, x1, y) is not None:
                y1 = y
        best = (x0, y0, x1, y1)
    if best is None:
        return None
    # The lines sit on the box's edge: step inside it, so no sliver of what's
    # around it comes along.
    x0, y0, x1, y1 = best
    inset = 2
    return (
        x0 + inset if x0 > 0 else 0, y0 + inset if y0 > 0 else 0,
        x1 - inset if x1 < det_w else det_w, y1 - inset if y1 < det_h else det_h,
    )


def guess_cam_box(face, det_w, det_h):
    """No edges found: a box around the face and shoulders, against the frame's edge if it's near one."""
    fcx, fcy, fw, fh = face
    w = min(det_w, 3.0 * fw)
    h = min(det_h, 2.6 * fh)
    x0 = fcx - w / 2
    y0 = fcy - 0.42 * h
    near_x, near_y = 0.06 * det_w, 0.06 * det_h
    if x0 < near_x:
        x0 = 0
    elif det_w - (x0 + w) < near_x:
        x0 = det_w - w
    if y0 < near_y:
        y0 = 0
    elif det_h - (y0 + h) < near_y:
        y0 = det_h - h
    x0 = min(max(0.0, x0), det_w - w)
    y0 = min(max(0.0, y0), det_h - h)
    return (int(x0), int(y0), int(round(x0 + w)), int(round(y0 + h)))


def facecam_person(boxes, presence, det_w, det_h):
    """
    The track that could be someone's webcam: the only person on screen most
    of the time (anyone else is rarely there or much smaller), with a face
    that isn't too big and stays put. None if there's no such person.
    """
    if not boxes:
        return None
    order = sorted(range(len(boxes)), key=lambda t: -presence[t])
    main = order[0]
    if presence[main] < CAM_MIN_PRESENCE:
        return None
    present = [b for b in boxes[main] if b is not None]
    area = float(np.median([b[2] * b[3] for b in present]))
    for t in order[1:]:
        others = [b for b in boxes[t] if b is not None]
        if presence[t] >= 0.3 and float(np.median([b[2] * b[3] for b in others])) >= 0.25 * area:
            return None
    xs = np.array([b[0] for b in present]) / det_w
    ys = np.array([b[1] for b in present]) / det_h
    face_h = float(np.median([b[3] for b in present])) / det_h
    if face_h > CAM_MAX_FACE or max(xs.std(), ys.std()) > CAM_MAX_DRIFT:
        return None
    return main


def facecam_layout(boxes, person, samples, det_w, det_h):
    """The webcam box for `person` (found or guessed), in detection pixels, and how it was found."""
    present = [b for b in boxes[person] if b is not None]
    face = tuple(float(np.median([b[k] for b in present])) for k in range(4))
    found = find_cam_box(samples, face, det_w, det_h) if samples else None
    if found:
        return found, 'border', face
    return guess_cam_box(face, det_w, det_h), 'guess', face


def outside_detail(samples, cam):
    """Share of the pixels around the webcam box that are on an edge (something to see)."""
    x0, y0, x1, y1 = cam
    shares = []
    for gray in samples[::2]:
        gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
        gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
        edge = np.maximum(gx, gy) >= EDGE_MIN
        edge[y0:y1, x0:x1] = False
        outside = edge.size - (x1 - x0) * (y1 - y0)
        shares.append(edge.sum() / max(1, outside))
    return float(np.mean(shares)) if shares else 0.0


def cam_share(cam, det_w, det_h, src_w, src_h):
    """
    How much of a 9:16 frame's height the webcam gets by default: enough to
    show all of it across the width, within reason.
    """
    x0, y0, x1, y1 = cam
    aspect = ((x1 - x0) / det_w * src_w) / max(1e-6, (y1 - y0) / det_h * src_h)
    return min(0.45, max(0.28, (1080 / aspect) / 1920))


def mouth_movement(marks, prev, cur):
    """Change in the lip area since the previous frame, minus head movement."""
    if marks is None or prev is None:
        return None
    right_eye, left_eye, _, right_mouth, left_mouth = marks
    mouth_c = (right_mouth + left_mouth) / 2
    mouth_w = max(8.0, float(np.linalg.norm(left_mouth - right_mouth)))
    eyes_c = (right_eye + left_eye) / 2
    eyes_d = max(8.0, float(np.linalg.norm(left_eye - right_eye)))
    lips = region_change(
        prev, cur,
        mouth_c[0] - 0.8 * mouth_w, mouth_c[1] - 0.45 * mouth_w,
        mouth_c[0] + 0.8 * mouth_w, mouth_c[1] + 0.9 * mouth_w,
    )
    head = region_change(
        prev, cur,
        eyes_c[0] - 0.9 * eyes_d, eyes_c[1] - 0.35 * eyes_d,
        eyes_c[0] + 0.9 * eyes_d, eyes_c[1] + 0.35 * eyes_d,
    )
    if lips is None or head is None:
        return None
    return max(0.0, lips - 0.8 * head)


def link_tracks(detections):
    """Link per-frame detections into tracks: {frame: detection} per person."""
    tracks = []
    for i, faces in enumerate(detections):
        open_tracks = [t for t in tracks if i - t['last'] <= MAX_GAP]
        candidates = []
        for ti, t in enumerate(open_tracks):
            px, py, pw, ph = t['frames'][t['last']][:4]
            for fi, (x, y, w, h) in enumerate(f[:4] for f in faces):
                dist = np.hypot((x + w / 2) - (px + pw / 2), (y + h / 2) - (py + ph / 2))
                if dist < 0.7 * max(w, pw) and 0.5 < w / pw < 2.0:
                    candidates.append((dist / max(w, pw), ti, fi))
        used_t, used_f = set(), set()
        for _, ti, fi in sorted(candidates):
            if ti in used_t or fi in used_f:
                continue
            used_t.add(ti)
            used_f.add(fi)
            open_tracks[ti]['frames'][i] = faces[fi]
            open_tracks[ti]['last'] = i
        for fi, face in enumerate(faces):
            if fi not in used_f:
                tracks.append({'frames': {i: face}, 'last': i})
    return tracks


def merge_fragments(tracks, frame_w):
    """Join tracks of the same person split by a longer detection dropout."""
    tracks = sorted(tracks, key=lambda t: min(t['frames']))
    merged = []
    for t in tracks:
        first = min(t['frames'])
        fx, fy, fw, fh = t['frames'][first][:4]
        target = None
        for m in merged:
            last = max(m['frames'])
            if last >= first or first - last > 3 * FPS:
                continue
            lx, ly, lw, lh = m['frames'][last][:4]
            if abs((fx + fw / 2) - (lx + lw / 2)) < max(0.8 * max(fw, lw), 0.05 * frame_w):
                target = m
        if target is None:
            merged.append({'frames': dict(t['frames'])})
        else:
            target['frames'].update(t['frames'])
    return merged


def fill_track(track, frames):
    """Per frame: (cx, cy, w, h) with gaps up to MAX_GAP interpolated, else None."""
    seen = sorted(track['frames'])
    boxes = [None] * frames
    for a, b in zip(seen, seen[1:] + [None]):
        x, y, w, h = (float(v) for v in track['frames'][a][:4])
        boxes[a] = (x + w / 2, y + h / 2, w, h)
        if b is not None and b - a <= MAX_GAP:
            x2, y2, w2, h2 = (float(v) for v in track['frames'][b][:4])
            for k in range(a + 1, b):
                u = (k - a) / (b - a)
                boxes[k] = (
                    (1 - u) * (x + w / 2) + u * (x2 + w2 / 2),
                    (1 - u) * (y + h / 2) + u * (y2 + h2 / 2),
                    (1 - u) * w + u * w2,
                    (1 - u) * h + u * h2,
                )
    return boxes


def region_change(prev, cur, x0, y0, x1, y1):
    h, w = cur.shape
    x0, y0, x1, y1 = max(0, int(x0)), max(0, int(y0)), min(w, int(x1)), min(h, int(y1))
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None
    a = prev[y0:y1, x0:x1].astype(np.int16)
    b = cur[y0:y1, x0:x1].astype(np.int16)
    return float(np.mean(np.abs(b - a)))


def smooth(values):
    out = [None] * len(values)
    half = SMOOTH_FRAMES // 2
    for i in range(len(values)):
        window = [v for v in values[max(0, i - half):i + half + 1] if v is not None]
        if window:
            out[i] = sum(window) / len(window)
    return out


def choose_speakers(boxes, talk, speech, areas):
    """Viterbi over tracks: who to show in each frame."""
    frames = len(speech)
    k = len(boxes)
    biggest = max(areas) or 1.0
    inf = 1e9
    cost = np.zeros((frames, k))
    for i in range(frames):
        present = [boxes[t][i] is not None for t in range(k)]
        if not any(present):
            continue  # nobody visible: no preference, the camera holds
        scores = [talk[t][i] if present[t] and talk[t][i] is not None else 0.0 for t in range(k)]
        total = sum(scores)
        for t in range(k):
            if not present[t]:
                cost[i, t] = inf
                continue
            # Small, steady preference for bigger faces when nothing else decides.
            c = 0.02 * (1 - areas[t] / biggest)
            if speech[i] and max(scores) >= MIN_TALK:
                c += max(scores) / total - scores[t] / total
            cost[i, t] = c
    best = np.zeros((frames, k))
    back = np.zeros((frames, k), dtype=int)
    best[0] = cost[0]
    for i in range(1, frames):
        prev_min = int(np.argmin(best[i - 1]))
        for t in range(k):
            stay = best[i - 1, t]
            switch = best[i - 1, prev_min] + SWITCH_COST
            if stay <= switch:
                best[i, t], back[i, t] = stay + cost[i, t], t
            else:
                best[i, t], back[i, t] = switch + cost[i, t], prev_min
    path = [int(np.argmin(best[-1]))]
    for i in range(frames - 1, 0, -1):
        path.append(int(back[i, path[-1]]))
    return path[::-1]


def follow(positions, cuts_at=()):
    """Camera keyframes from per-frame target positions (cx, 0..1)."""
    keyframes = []
    current = None
    # Start where the first face is, not in the middle of the frame.
    last_known = next((cx for cx in positions if cx is not None), 0.5)
    for i, cx in enumerate(positions):
        if cx is None:
            cx = last_known
        last_known = cx
        t = round(i / FPS, 2)
        if current is None or i in cuts_at:
            current = cx
            keyframes.append({'t': t, 'cx': cx, 'cut': True})
            continue
        current += PAN_ALPHA * (cx - current)
        keyframes.append({'t': t, 'cx': current, 'cut': False})
    return simplify(keyframes)


def simplify(keyframes):
    step = MIN_PAN_STEP
    while True:
        kept = keyframes[:1]
        for kf in keyframes[1:]:
            if kf['cut'] or abs(kf['cx'] - kept[-1]['cx']) >= step:
                kept.append(kf)
        if len(kept) <= MAX_KEYFRAMES or step >= 0.5:
            break
        step *= 2
    if len(kept) > MAX_KEYFRAMES:
        stride = len(kept) / MAX_KEYFRAMES
        kept = [kept[int(i * stride)] for i in range(MAX_KEYFRAMES)]
    return [{'t': float(kf['t']), 'cx': round(float(kf['cx']), 4), 'cut': kf['cut']} for kf in kept]


def split_half(boxes, det_w, det_h):
    """Crop for one person in a split screen: pan with them, fixed zoom/height."""
    present = [b for b in boxes if b is not None]
    face_h = float(np.median([b[3] for b in present])) / det_h
    face_cy = float(np.median([b[1] for b in present])) / det_h
    h = min(1.0, max(SPLIT_MIN_CROP, face_h / SPLIT_FACE_HEIGHT))
    y = min(1.0 - h, max(0.0, face_cy - 0.45 * h))
    positions = [b[0] / det_w if b is not None else None for b in boxes]
    return {'keyframes': follow(positions), 'y': round(y, 4), 'h': round(h, 4)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('video_path')
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--width', type=int, required=True)
    parser.add_argument('--height', type=int, required=True)
    parser.add_argument('--model', default=None)
    args = parser.parse_args()

    det_w = min(DETECT_WIDTH, args.width)
    det_h = max(2, int(round(args.height * det_w / args.width / 2.0)) * 2)
    detector = Detector(args.model, det_w, det_h)

    # Each detection: (x, y, w, h, landmarks, mouth movement since last frame).
    detections = []
    # A few frames spread over the clip, to look for a webcam box's edges in.
    samples = []
    sample_every = max(1, int(round((args.end - args.start) * FPS / CAM_SAMPLES)))
    prev = None
    try:
        for frame in read_frames(args, det_w, det_h):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if len(detections) % sample_every == 0:
                samples.append(gray)
            detections.append([
                (x, y, w, h, marks, mouth_movement(marks, prev, gray))
                for (x, y, w, h, marks) in detector.detect(frame, gray)
            ])
            prev = gray
    except Exception as err:  # noqa: BLE001 - report any failure as JSON
        print(json.dumps({'error': str(err)}), file=sys.stderr)
        return 1
    frames = len(detections)
    if frames == 0:
        print(json.dumps({'error': 'ffmpeg returned no frames'}), file=sys.stderr)
        return 1

    tracks = merge_fragments(link_tracks(detections), det_w)
    tracks = [t for t in tracks if len(t['frames']) >= MIN_TRACK_FRAMES]
    if tracks:
        areas = [float(np.median([f[2] * f[3] for f in t['frames'].values()])) for t in tracks]
        keep = [i for i, a in enumerate(areas) if a >= MIN_FACE_AREA_RATIO * max(areas)]
        tracks = [tracks[i] for i in keep]
    boxes = [fill_track(t, frames) for t in tracks]
    presence = [sum(1 for b in bx if b is not None) / frames for bx in boxes]

    # One person who stays put: a webcam over gameplay or a screen?
    facecam = None
    cam = None
    person = facecam_person(boxes, presence, det_w, det_h)
    if person is not None:
        cam, found, face = facecam_layout(boxes, person, samples, det_w, det_h)
        facecam = {
            'cam': {
                'x': round(cam[0] / det_w, 4), 'y': round(cam[1] / det_h, 4),
                'w': round((cam[2] - cam[0]) / det_w, 4), 'h': round((cam[3] - cam[1]) / det_h, 4),
            },
            'found': found,
            'face': follow([b[0] / det_w if b is not None else None for b in boxes[person]]),
            'faceY': round(face[1] / det_h, 4),
        }

    # No faces, or only tiny ones that aren't people on screen all along (a
    # crowd far away) or are someone's webcam: follow the action instead.
    crop_share = min(1.0, max(0.1, (args.height * 9 / 16) / args.width))
    regulars = [t for t in range(len(tracks)) if presence[t] >= GROUP_MIN_PRESENCE]
    tiny = bool(tracks) and max(
        float(np.median([f[3] for f in t['frames'].values()])) for t in tracks
    ) < TINY_FACE * det_h and (not regulars or person is not None)
    motion = None
    # A webcam guessed around a big face is most likely just someone talking:
    # no need to look for action around it.
    look_around = facecam is not None and (facecam['found'] == 'border' or face[3] / det_h <= 0.15)
    if not tracks or tiny or look_around:
        # A second pass over the frames, only for clips that need it. What
        # moves inside a webcam box (the person) isn't the action.
        mask = None
        if cam is not None:
            mask = np.zeros((det_h, det_w), dtype=bool)
            mask[cam[1]:cam[3], cam[0]:cam[2]] = True
        motion = motion_pass(args, det_w, det_h, frames, mask)
    if facecam and motion is not None:
        # The gameplay under the webcam in a 9:16 frame: its crop follows the action.
        share = cam_share(cam, det_w, det_h, args.width, args.height)
        content_share = min(1.0, max(0.1, (args.height * 1080 / (1920 * (1 - share))) / args.width))
        facecam['content'] = follow_motion(motion_positions(motion, content_share), content_share)[0]
        facecam['kind'] = 'game' if action_share(motion) >= GAME_MOTION_SHARE else 'screen'
    elif facecam:
        facecam['content'] = [{'t': 0.0, 'cx': 0.5, 'cut': True}]
        facecam['kind'] = 'screen'
    # Picked automatically only when the box's edges were found, and there's
    # gameplay or a screen with something on it around it.
    cam_layout = None
    if facecam and facecam['found'] == 'border':
        if facecam['kind'] == 'game':
            cam_layout = 'facecam'
        elif outside_detail(samples, cam) >= SCREEN_MIN_DETAIL:
            cam_layout = 'screen'

    if not tracks or tiny:
        keyframes, moving = follow_motion(motion_positions(motion, crop_share), crop_share)
        if moving or not tracks:
            print(json.dumps({
                'layout': cam_layout or 'single', 'keyframes': keyframes, 'split': None,
                'facecam': facecam, 'group': None,
                'stats': {'tracks': len(tracks), 'mode': 'motion' if moving else 'center',
                          'action': round(action_share(motion), 2)},
            }))
            return 0

    speech = read_speech(args, frames)
    if speech is None:
        speech = np.zeros(frames, dtype=bool)
    areas = [float(np.median([f[2] * f[3] for f in t['frames'].values()])) for t in tracks]
    talk = []
    for t in tracks:
        movement = [None] * frames
        for i, face in t['frames'].items():
            movement[i] = face[5]
        known = [m for m in movement if m is not None]
        # Each face against its own resting level, so a sharper or closer
        # face doesn't look like it's talking more.
        rest = float(np.percentile(known, 30)) if known else 0.0
        talk.append(smooth([None if m is None else m / (rest + 1.0) for m in movement]))

    path = choose_speakers(boxes, talk, speech, areas)
    switches = [i for i in range(1, frames) if path[i] != path[i - 1]]
    speech_frames = [i for i in range(frames) if speech[i]]
    shares = [
        sum(1 for i in speech_frames if path[i] == t) / max(1, len(speech_frames)) for t in range(len(tracks))
    ]
    stats = {
        'tracks': len(tracks),
        'switches': len(switches),
        'shares': [round(s, 2) for s in shares],
        'presence': [round(p, 2) for p in presence],
        'detector': 'yunet' if detector.yunet is not None else 'haar',
        'mode': 'faces',
    }
    if motion is not None:
        stats['action'] = round(action_share(motion), 2)
    # How long each stretch on one person lasts (the first and last are cut
    # off by the clip edges, so leave them out when there are enough).
    edges = [0] + switches + [frames]
    turns = [(edges[j + 1] - edges[j]) / FPS for j in range(len(edges) - 1)]
    inner = turns[1:-1] if len(turns) >= 5 else turns
    typical_turn = float(np.median(inner))
    stats['typical_turn'] = round(typical_turn, 1)
    median_x = [float(np.nanmedian([x[0] for x in bx if x])) if any(bx) else 0.0 for bx in boxes]

    layout = cam_layout or 'single'
    split = None
    main_two = sorted(range(len(tracks)), key=lambda t: -presence[t])[:2]
    if len(main_two) == 2:
        a, b = main_two
        between = sum(1 for i in switches if {path[i], path[i - 1]} == {a, b})
        apart = abs(median_x[a] - median_x[b])
        if min(presence[a], presence[b]) >= SPLIT_OPTION_PRESENCE and apart >= 0.2 * det_w:
            left, right = sorted((a, b), key=lambda t: median_x[t])
            split = {
                'top': split_half(boxes[left], det_w, det_h),
                'bottom': split_half(boxes[right], det_w, det_h),
            }
            if (
                layout == 'single'
                and min(presence[a], presence[b]) >= SPLIT_MIN_PRESENCE
                and min(shares[a], shares[b]) >= SPLIT_MIN_SHARE
                and between >= SPLIT_MIN_SWITCHES
                and typical_turn <= SPLIT_MAX_TURN_SECONDS
            ):
                layout = 'split'

    # 3-4 people on screen most of the time: a grid, left to right.
    group = None
    if 3 <= len(regulars) <= 4:
        regulars.sort(key=lambda t: median_x[t])
        gaps = [median_x[b] - median_x[a] for a, b in zip(regulars, regulars[1:])]
        if min(gaps) >= GROUP_MIN_GAP * det_w:
            group = []
            for t in regulars:
                present = [b for b in boxes[t] if b is not None]
                group.append({
                    'keyframes': follow([b[0] / det_w if b is not None else None for b in boxes[t]]),
                    'faceY': round(float(np.median([b[1] for b in present])) / det_h, 4),
                    'faceH': round(float(np.median([b[3] for b in present])) / det_h, 4),
                })
            talkers = [t for t in regulars if shares[t] >= GROUP_MIN_SHARE]
            if (
                layout in ('single', 'split')
                and len(talkers) >= 3
                and len(switches) >= SPLIT_MIN_SWITCHES + 1
                and typical_turn <= SPLIT_MAX_TURN_SECONDS
            ):
                layout = 'group'

    positions = [
        boxes[path[i]][i][0] / det_w if boxes[path[i]][i] is not None else None for i in range(frames)
    ]
    print(json.dumps({
        'layout': layout,
        'keyframes': follow(positions, set(switches)),
        'split': split,
        'facecam': facecam,
        'group': group,
        'stats': stats,
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
