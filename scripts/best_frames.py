#!/usr/bin/env python3
"""
The best moments of a clip for a cover image: a big, sharp, well lit face.

Usage: best_frames.py VIDEO --start S --end E [--model yunet.onnx] [--count 4]
Prints {"frames": [{"t": seconds, "score": ...}, ...]} best first, spread
over the clip so the picks aren't four nearly identical frames.

Scoring: the face's share of the frame, boosted by how sharp it is (the
variance of the Laplacian, capped so a noisy frame can't win on that alone)
and lowered when the picture is very dark or blown out. Frames without a
face can still be picked, far behind. The idea (face area times capped
sharpness, then picks spread over the video) is from OpenShorts' thumbnail
frame picker; this is our own version. See THIRD_PARTY_NOTICES.md.
"""
import argparse
import json
import subprocess
import sys
import tempfile

import cv2
import numpy as np

from smart_crop import SCENE_MIN_SCORE, scene_frame, scene_score

FPS = 4
WIDTH = 640
MIN_FACE_SCORE = 0.7
SHARPNESS_CAP = 500.0
NO_FACE_WEIGHT = 0.02
MIN_GAP_SHARE = 0.08


def read_frames(path, start, end, width, height):
    cmd = [
        'ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(max(0.1, end - start)),
        '-i', path, '-an', '-sn', '-vf', f'fps={FPS},scale={width}:{height}',
        '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1',
    ]
    size = width * height * 3
    errlog = tempfile.TemporaryFile()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errlog)
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
    finally:
        proc.stdout.close()
        proc.wait()
        errlog.close()


def probe_size(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
         '-of', 'csv=p=0', path],
        capture_output=True, text=True, check=True,
    ).stdout.strip().split(',')
    return int(out[0]), int(out[1])


def light_factor(gray):
    """1 for a normally lit picture, lower when it's very dark or blown out."""
    mean = float(gray.mean())
    if mean < 40:
        return max(0.2, mean / 40)
    if mean > 215:
        return max(0.2, (255 - mean) / 40)
    return 1.0


def score_frame(frame, detector):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    faces = []
    if detector is not None:
        _, found = detector.detect(frame)
        if found is not None:
            faces = [f for f in found if f[14] >= MIN_FACE_SCORE]
    if faces:
        x, y, fw, fh = (int(round(v)) for v in max(faces, key=lambda f: f[2] * f[3])[:4])
        x0, y0, x1, y1 = max(0, x), max(0, y), min(w, x + fw), min(h, y + fh)
        region = gray[y0:y1, x0:x1] if x1 - x0 > 8 and y1 - y0 > 8 else gray
        sharp = float(cv2.Laplacian(region, cv2.CV_64F).var())
        area = (fw * fh) / float(w * h)
        return area * (1.0 + min(sharp, SHARPNESS_CAP) / SHARPNESS_CAP) * light_factor(gray), True
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return NO_FACE_WEIGHT * (1.0 + min(sharp, SHARPNESS_CAP) / SHARPNESS_CAP) * light_factor(gray), False


def pick_spread(scored, count, length):
    """The best frames, at least MIN_GAP_SHARE of the clip apart."""
    gap = max(1.0, MIN_GAP_SHARE * length)
    picked = []
    for t, score, face in sorted(scored, key=lambda s: -s[1]):
        if all(abs(t - p[0]) >= gap for p in picked):
            picked.append((t, score, face))
        if len(picked) >= count:
            break
    return picked


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('video')
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--model', default=None)
    parser.add_argument('--count', type=int, default=4)
    args = parser.parse_args()

    src_w, src_h = probe_size(args.video)
    width = min(WIDTH, src_w)
    height = max(2, int(round(src_h * width / src_w / 2.0)) * 2)
    detector = None
    if args.model:
        try:
            detector = cv2.FaceDetectorYN.create(args.model, '', (width, height), MIN_FACE_SCORE, 0.3, 50)
        except Exception as err:  # noqa: BLE001
            print(json.dumps({'warning': f'YuNet unavailable: {err}'}), file=sys.stderr)

    scored = []
    changes = []
    prev = None
    for i, frame in enumerate(read_frames(args.video, args.start, args.end, width, height)):
        small = scene_frame(frame)
        changes.append(0.0 if prev is None else scene_score(prev, small))
        prev = small
        score, face = score_frame(frame, detector)
        scored.append((args.start + i / FPS, score, face))
    if not scored:
        print(json.dumps({'error': 'ffmpeg returned no frames'}), file=sys.stderr)
        return 1
    # Not right at a scene cut: the frame next to one is often half the old
    # shot, and a quarter second either way lands in a different picture.
    at_cut = [
        changes[i] >= SCENE_MIN_SCORE or (i + 1 < len(changes) and changes[i + 1] >= SCENE_MIN_SCORE)
        for i in range(len(scored))
    ]
    steady = [s for s, cut in zip(scored, at_cut) if not cut]
    scored = steady or scored
    picks = pick_spread(scored, max(1, args.count), args.end - args.start)
    print(json.dumps({'frames': [{'t': round(t, 2), 'score': round(s, 5), 'face': f} for t, s, f in picks]}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
