#!/usr/bin/env python3
"""
smart_crop.py - track the main face across a time window of a video and emit
JSON keyframes for a dynamic vertical (9:16) crop, so the crop follows
whoever is on camera instead of a dumb centered crop.

Usage:
    python3 smart_crop.py <video_path> --start 0 --end 30 \
        --width 1920 --height 1080 [--interval 0.25]

--width/--height are the video's DISPLAY dimensions (after any rotation
flag is applied), which is what ffmpeg hands us when it decodes.

Prints a single JSON array to stdout:
    [{"t": 0.0, "cx": 0.53, "cut": true}, {"t": 4.25, "cx": 0.55, "cut": false}, ...]

  t   = seconds, RELATIVE to --start (0 == the start of the requested window)
  cx  = horizontal center of the tracked face, normalized 0..1 across the
        frame width (0.5 == dead center)
  cut = true: jump straight to cx at t (someone else took over the frame, or
        the source cut to another shot). false: pan smoothly from the
        previous keyframe to this one.

Frames are decoded, rotated and downscaled by ffmpeg (same input seeking as
the final render, so the timelines match) and piped in as raw grayscale.
Only needs ffmpeg plus opencv-python(-headless), using the Haar cascade that
ships inside the opencv wheel, so no extra model download is required.
"""
import argparse
import json
import subprocess
import sys
import tempfile

import cv2
import numpy as np

# Detection runs on frames this wide: much faster than full resolution, and
# faces in talking-head/podcast footage stay well above the minimum size.
DETECT_WIDTH = 640
# A face this far (normalized) from the current camera position is treated as
# "someone else" rather than the same person moving a bit.
JUMP_DISTANCE = 0.18
# Consecutive samples that must agree on a new position before the camera
# cuts to it, so one false detection can't yank the camera around.
CONFIRM_SAMPLES = 2
# How quickly the camera follows small movements (0..1, higher = faster).
PAN_ALPHA = 0.35
# When picking who to follow, stick with the face nearest the camera unless
# another face is clearly bigger (keeps two similar faces from flip-flopping).
STICKY_AREA_RATIO = 0.6
# Pan keyframes that move less than this are dropped to keep the ffmpeg
# expression short. Cuts are always kept.
MIN_PAN_STEP = 0.01
MAX_KEYFRAMES = 80


def read_samples(args, detector):
    det_w = min(DETECT_WIDTH, args.width)
    det_h = max(2, int(round(args.height * det_w / args.width / 2.0)) * 2)
    fps = 1.0 / args.interval
    cmd = [
        'ffmpeg', '-v', 'error',
        '-ss', str(args.start), '-t', str(max(0.1, args.end - args.start)),
        '-i', args.video_path,
        '-an', '-sn',
        '-vf', f'fps={fps},scale={det_w}:{det_h}',
        '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
    ]
    frame_bytes = det_w * det_h
    min_size = max(24, det_w // 24)
    samples = []
    # stderr goes to a temp file: a pipe we only read at the end could fill
    # up on a damaged file and stall ffmpeg.
    errlog = tempfile.TemporaryFile()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errlog)
    try:
        index = 0
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            gray = np.frombuffer(buf, dtype=np.uint8).reshape(det_h, det_w)
            faces = detector.detectMultiScale(
                gray, scaleFactor=1.15, minNeighbors=5, minSize=(min_size, min_size)
            )
            # (normalized center x, area) per detected face
            boxes = [((x + w / 2.0) / det_w, w * h) for (x, y, w, h) in faces]
            samples.append((round(index * args.interval, 3), boxes))
            index += 1
    finally:
        proc.stdout.close()
        code = proc.wait()
        errlog.seek(0)
        stderr = errlog.read().decode('utf-8', 'replace')
        errlog.close()
    if code != 0 and not samples:
        raise RuntimeError(f'ffmpeg failed to decode frames: {stderr[-500:]}')
    return samples


def pick_face(boxes, current):
    """Choose which detected face the camera should follow in one frame."""
    if not boxes:
        return None
    largest = max(boxes, key=lambda b: b[1])
    if current is not None:
        near = [b for b in boxes if abs(b[0] - current) < JUMP_DISTANCE]
        if near:
            nearest = min(near, key=lambda b: abs(b[0] - current))
            if nearest[1] >= STICKY_AREA_RATIO * largest[1]:
                return nearest[0]
    return largest[0]


def track(samples):
    keyframes = []
    current = None
    pending = []  # consecutive far-away detections: (t, cx)
    for t, boxes in samples:
        cx = pick_face(boxes, current)
        if cx is None:
            continue
        if current is None:
            # First face found: start the whole clip there instead of
            # starting centered and jumping once someone is detected.
            current = cx
            keyframes.append({'t': 0.0, 'cx': cx, 'cut': True})
            continue
        if abs(cx - current) < JUMP_DISTANCE:
            pending = []
            current += PAN_ALPHA * (cx - current)
            keyframes.append({'t': t, 'cx': current, 'cut': False})
            continue
        if pending and abs(cx - pending[-1][1]) >= JUMP_DISTANCE:
            pending = []
        pending.append((t, cx))
        if len(pending) >= CONFIRM_SAMPLES:
            current = sum(p[1] for p in pending) / len(pending)
            # Cut at the first sample that saw the new position, not the one
            # that confirmed it, so the cut lines up with the actual change.
            keyframes.append({'t': pending[0][0], 'cx': current, 'cut': True})
            pending = []
    return keyframes


def simplify(keyframes, min_step):
    if not keyframes:
        return keyframes
    kept = [keyframes[0]]
    for kf in keyframes[1:]:
        if kf['cut'] or abs(kf['cx'] - kept[-1]['cx']) >= min_step:
            kept.append(kf)
    return kept


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('video_path')
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--width', type=int, required=True)
    parser.add_argument('--height', type=int, required=True)
    parser.add_argument('--interval', type=float, default=0.25)
    args = parser.parse_args()

    detector = cv2.CascadeClassifier(
        cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    )
    try:
        samples = read_samples(args, detector)
    except Exception as err:  # noqa: BLE001 - report any failure as JSON
        print(json.dumps({'error': str(err)}), file=sys.stderr)
        return 1

    keyframes = track(samples)
    if not keyframes:
        print(json.dumps([{'t': 0.0, 'cx': 0.5, 'cut': True}]))
        return 0

    step = MIN_PAN_STEP
    simplified = simplify(keyframes, step)
    while len(simplified) > MAX_KEYFRAMES and step < 0.5:
        step *= 2
        simplified = simplify(keyframes, step)
    if len(simplified) > MAX_KEYFRAMES:
        stride = len(simplified) / MAX_KEYFRAMES
        simplified = [simplified[int(i * stride)] for i in range(MAX_KEYFRAMES)]

    print(json.dumps([
        {'t': kf['t'], 'cx': round(kf['cx'], 4), 'cut': kf['cut']} for kf in simplified
    ]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
