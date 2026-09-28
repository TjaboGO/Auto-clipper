#!/usr/bin/env python3
"""
smart_crop.py - sample face positions across a time window of a video and
emit JSON keyframes for a dynamic vertical (9:16) crop, so the crop follows
whoever is on camera instead of a dumb centered crop.

Usage:
    python3 smart_crop.py <video_path> --start 0 --end 30 --interval 0.5

Prints a single JSON array to stdout:
    [{"t": 0.0, "cx": 0.53}, ...]

  t  = seconds, RELATIVE to --start (0 == the start of the requested window)
  cx = horizontal center of the detected face, normalized 0..1 across the
       frame width (0.5 == dead center)

Only depends on opencv-python(-headless) and uses the Haar cascade that
ships inside the opencv wheel, so no extra model download is required.
"""
import argparse
import json
import sys

import cv2


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('video_path')
    parser.add_argument('--start', type=float, default=0.0)
    parser.add_argument('--end', type=float, default=None)
    parser.add_argument('--interval', type=float, default=0.5)
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.video_path)
    if not cap.isOpened():
        print(json.dumps({'error': f'could not open {args.video_path}'}), file=sys.stderr)
        return 1

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    src_duration = (frame_count / fps) if fps > 0 else 0.0
    end = args.end if args.end is not None else src_duration
    end = min(end, src_duration) if src_duration > 0 else end

    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    detector = cv2.CascadeClassifier(cascade_path)

    raw = []
    last_cx = 0.5
    t = args.start
    # Safety cap so a bad --end can't spin this forever.
    max_samples = 4000
    samples = 0
    while t < end and samples < max_samples:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if ok and frame is not None:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            h, w = gray.shape[:2]
            faces = detector.detectMultiScale(
                gray, scaleFactor=1.2, minNeighbors=5, minSize=(60, 60)
            )
            if len(faces) > 0:
                # Largest detected face = most likely the active speaker.
                fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
                last_cx = (fx + fw / 2.0) / w
        raw.append({'t': round(t - args.start, 2), 'cx': round(last_cx, 4)})
        t += args.interval
        samples += 1

    cap.release()

    if not raw:
        print(json.dumps([{'t': 0.0, 'cx': 0.5}]))
        return 0

    # Exponential smoothing so the crop pans instead of jittering every frame.
    smoothed = []
    ema = None
    alpha = 0.35
    for kf in raw:
        ema = kf['cx'] if ema is None else (alpha * kf['cx'] + (1 - alpha) * ema)
        smoothed.append({'t': kf['t'], 'cx': round(ema, 4)})

    # Collapse near-identical consecutive keyframes to keep the downstream
    # ffmpeg expression short (a static talking-head shot should collapse to
    # ~1 keyframe, not hundreds).
    simplified = [smoothed[0]]
    for kf in smoothed[1:]:
        if abs(kf['cx'] - simplified[-1]['cx']) < 0.015:
            continue
        simplified.append(kf)

    # Hard cap: if something still produced a huge number of keyframes,
    # stride down to a sane count rather than risk an unwieldy filter expr.
    max_keyframes = 40
    if len(simplified) > max_keyframes:
        stride = len(simplified) / max_keyframes
        simplified = [simplified[int(i * stride)] for i in range(max_keyframes)]

    print(json.dumps(simplified))
    return 0


if __name__ == '__main__':
    sys.exit(main())
