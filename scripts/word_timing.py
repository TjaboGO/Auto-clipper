#!/usr/bin/env python3
"""
word_timing.py - listen to each rendered clip with faster-whisper and report
when every word is actually said, so the captions can highlight each word
on time instead of splitting Gemini's sentence-level timestamps evenly.

Usage:
    python3 word_timing.py request.json

request.json:
    {"model": "small", "models_dir": "/app/storage/models",
     "clips": [{"id": "clip_1", "audio": "/path/timing_1.wav"}, ...]}

Prints one JSON object to stdout:
    {"model": "small", "language": "sv",
     "clips": [{"id": "clip_1", "words": [{"w": "Okej", "s": 0.12, "e": 0.45, "p": 0.93}, ...]},
               {"id": "clip_2", "error": "..."}]}

  w = the word as heard, s/e = start/end in seconds from the start of that
  clip's audio file, p = recognizer confidence (0..1)

The model is loaded once for all clips and downloaded into models_dir the
first time. If it can't be loaded, prints {"error": "..."} to stderr and
exits with code 1 - the app then falls back to estimated word timing.
"""
import json
import os
import sys

os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

# Reuse the first confidently detected language for the remaining clips, so
# a short clip with little speech can't flip to a different language.
LANGUAGE_CONFIDENCE = 0.7


def cpu_threads() -> int:
    try:
        count = len(os.sched_getaffinity(0))
    except AttributeError:
        count = os.cpu_count() or 1
    return max(1, min(8, count))


def transcribe_words(model, audio_path, language):
    segments, info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        # Only the timing matters, so keep decoding cheap: greedy, no
        # temperature fallback, no conditioning on earlier text (which also
        # avoids repetition loops).
        beam_size=1,
        best_of=1,
        temperature=0.0,
        condition_on_previous_text=False,
        # Skip silence/music; also sharpens word edges next to pauses.
        vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 500},
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if not text or word.end <= word.start:
                continue
            words.append({
                'w': text,
                's': round(word.start, 3),
                'e': round(word.end, 3),
                'p': round(word.probability, 3),
            })
    return words, info


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({'error': 'usage: word_timing.py request.json'}), file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding='utf-8') as fh:
        request = json.load(fh)

    model_name = request.get('model') or 'small'
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            model_name,
            device='cpu',
            compute_type='int8',
            cpu_threads=cpu_threads(),
            download_root=request.get('models_dir'),
        )
    except Exception as err:  # noqa: BLE001 - any failure means "no exact timing"
        print(json.dumps({'error': f'{type(err).__name__}: {err}'}), file=sys.stderr)
        return 1

    language = None
    results = []
    for clip in request.get('clips', []):
        try:
            words, info = transcribe_words(model, clip['audio'], language)
            if language is None and (info.language_probability or 0) >= LANGUAGE_CONFIDENCE:
                language = info.language
            results.append({'id': clip['id'], 'words': words})
        except Exception as err:  # noqa: BLE001 - one bad clip shouldn't sink the rest
            results.append({'id': clip.get('id'), 'error': f'{type(err).__name__}: {err}'})

    print(json.dumps({'model': model_name, 'language': language, 'clips': results}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
