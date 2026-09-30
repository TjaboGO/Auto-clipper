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
    {"layout": "single" | "split",
     "keyframes": [{"t": 0.0, "cx": 0.31, "cut": true}, ...],
     "split": {"top":    {"keyframes": [...], "y": 0.12, "h": 0.62},
               "bottom": {"keyframes": [...], "y": 0.10, "h": 0.60}} | null,
     "stats": {...}}

  layout    = what looks best: follow whoever talks, or split screen
  keyframes = the crop that follows whoever talks
  split     = the two main people stacked (top = the one further left in
              the frame), whenever there are two - so the editor can switch
              to split screen even when it wasn't picked automatically
  t   = seconds from --start;  cx = face center, normalized 0..1 across the
        frame width;  cut = jump there (true) or pan from the previous
        keyframe (false);  y/h = top and height of a split-screen crop as
        shares of the frame height

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


def motion_profile(prev, cur, edges):
    """
    How much the picture changed in each column band since the last frame,
    after lining the frames up: a camera that pans or tilts moves everything,
    so that shift is taken out first (see camera_shift).
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
    prev = None
    try:
        for frame in read_frames(args, det_w, det_h):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
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
    # No faces, or only tiny ones: follow the action instead.
    crop_share = min(1.0, max(0.1, (args.height * 9 / 16) / args.width))
    tiny = bool(tracks) and max(
        float(np.median([f[3] for f in t['frames'].values()])) for t in tracks
    ) < TINY_FACE * det_h
    if not tracks or tiny:
        # A second pass over the frames, only for clips that need it.
        edges = np.linspace(0, det_w, MOTION_BINS + 1).astype(int)
        motion = []
        prev = None
        for frame in read_frames(args, det_w, det_h):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            motion.append(motion_profile(prev, gray, edges) if prev is not None else None)
            prev = gray
        keyframes, moving = follow_motion(motion_positions(motion[:frames], crop_share), crop_share)
        if moving or not tracks:
            print(json.dumps({'layout': 'single', 'keyframes': keyframes, 'split': None,
                              'stats': {'tracks': len(tracks), 'mode': 'motion' if moving else 'center'}}))
            return 0

    speech = read_speech(args, frames)
    if speech is None:
        speech = np.zeros(frames, dtype=bool)
    boxes = [fill_track(t, frames) for t in tracks]
    areas = [float(np.median([f[2] * f[3] for f in t['frames'].values()])) for t in tracks]
    talk = []
    for t in tracks:
        motion = [None] * frames
        for i, face in t['frames'].items():
            motion[i] = face[5]
        known = [m for m in motion if m is not None]
        # Each face against its own resting level, so a sharper or closer
        # face doesn't look like it's talking more.
        rest = float(np.percentile(known, 30)) if known else 0.0
        talk.append(smooth([None if m is None else m / (rest + 1.0) for m in motion]))

    path = choose_speakers(boxes, talk, speech, areas)
    switches = [i for i in range(1, frames) if path[i] != path[i - 1]]
    speech_frames = [i for i in range(frames) if speech[i]]
    shares = [
        sum(1 for i in speech_frames if path[i] == t) / max(1, len(speech_frames)) for t in range(len(tracks))
    ]
    presence = [sum(1 for b in bx if b is not None) / frames for bx in boxes]
    stats = {
        'tracks': len(tracks),
        'switches': len(switches),
        'shares': [round(s, 2) for s in shares],
        'presence': [round(p, 2) for p in presence],
        'detector': 'yunet' if detector.yunet is not None else 'haar',
        'mode': 'faces',
    }

    layout = 'single'
    split = None
    main_two = sorted(range(len(tracks)), key=lambda t: -presence[t])[:2]
    if len(main_two) == 2:
        a, b = main_two
        between = sum(1 for i in switches if {path[i], path[i - 1]} == {a, b})
        # How long each stretch on one person lasts (the first and last are
        # cut off by the clip edges, so leave them out when there are enough).
        edges = [0] + switches + [frames]
        turns = [(edges[j + 1] - edges[j]) / FPS for j in range(len(edges) - 1)]
        inner = turns[1:-1] if len(turns) >= 5 else turns
        typical_turn = float(np.median(inner))
        stats['typical_turn'] = round(typical_turn, 1)
        apart = abs(np.nanmedian([x[0] for x in boxes[a] if x]) - np.nanmedian([x[0] for x in boxes[b] if x]))
        if min(presence[a], presence[b]) >= SPLIT_OPTION_PRESENCE and apart >= 0.2 * det_w:
            left, right = sorted((a, b), key=lambda t: np.nanmedian([x[0] for x in boxes[t] if x]))
            split = {
                'top': split_half(boxes[left], det_w, det_h),
                'bottom': split_half(boxes[right], det_w, det_h),
            }
            if (
                min(presence[a], presence[b]) >= SPLIT_MIN_PRESENCE
                and min(shares[a], shares[b]) >= SPLIT_MIN_SHARE
                and between >= SPLIT_MIN_SWITCHES
                and typical_turn <= SPLIT_MAX_TURN_SECONDS
            ):
                layout = 'split'

    positions = [
        boxes[path[i]][i][0] / det_w if boxes[path[i]][i] is not None else None for i in range(frames)
    ]
    print(json.dumps({
        'layout': layout,
        'keyframes': follow(positions, set(switches)),
        'split': split,
        'stats': stats,
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
