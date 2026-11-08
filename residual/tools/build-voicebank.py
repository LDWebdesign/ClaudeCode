#!/usr/bin/env python3
"""
Renders the spirit-box vocabulary into src/audio/voicebank.bin.

Every entry in src/spiritbox/vocabulary.json is spoken by one or two of several offline
synthesizers (MBROLA diphone voices through eSpeak NG, Festival HTS / diphone voices, and a
few eSpeak whisper/croak variants), with varied rate and pitch. Clips are trimmed, band-limited,
resampled to 8 kHz and IMA-ADPCM encoded. The app degrades them further at runtime through its
radio chain, so the source only needs to be intelligible, not clean.

To use real recorded voices instead, drop WAV files named <entry>.<anything>.wav into a folder
and pass --recordings <folder>; those replace synthesized takes for matching entries.

Requires: espeak-ng, mbrola + mbrola-us1/us2/us3/en1, festival + festvox-us-slt-hts +
festvox-kallpc16k, ffmpeg, numpy.
"""
import argparse
import hashlib
import json
import os
import random
import struct
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
VOCAB = ROOT / "src" / "spiritbox" / "vocabulary.json"
OUT = ROOT / "src" / "audio" / "voicebank.bin"
RATE = 8000

# id -> (engine, voice, base params). Kept as small integers in the bank header.
VOICES = [
    ("espeak", "mb-us1", {"s": 150, "p": 50}),  # 0 female
    ("espeak", "mb-us2", {"s": 150, "p": 45}),  # 1 male
    ("espeak", "mb-us3", {"s": 145, "p": 40}),  # 2 male, lower
    ("espeak", "mb-en1", {"s": 140, "p": 45}),  # 3 male, British
    ("festival", "voice_cmu_us_slt_arctic_hts", {}),  # 4 female, smoother
    ("festival", "voice_kal_diphone", {}),  # 5 male
    ("espeak", "en-us+whisper", {"s": 135, "p": 40}),  # 6 whisper
    ("espeak", "en+croak", {"s": 130, "p": 30}),  # 7 croak
]
COMMON = [0, 1, 2, 3, 4, 5]


def takes_for(entry, rng):
    kind = entry.get("k", "word")
    if kind in ("radio", "filler", "number"):
        n = 1
    elif kind == "name":
        n = 1 if rng.random() < 0.6 else 2
    else:
        n = 2 if rng.random() < 0.7 else 1
    voices = rng.sample(COMMON, n)
    # A small share of evocative entries also get a whispered or croaked take.
    if entry["c"] >= 2 and kind not in ("radio", "filler") and rng.random() < 0.16:
        voices[-1] = 6 if rng.random() < 0.7 else 7
    return voices


def synth(text, voice_id, rng, tmp):
    engine, voice, base = VOICES[voice_id]
    wav = Path(tmp) / f"{hashlib.md5((text + str(voice_id) + str(rng.random())).encode()).hexdigest()}.wav"
    if engine == "espeak":
        speed = int(base["s"] * rng.uniform(0.85, 1.12))
        pitch = int(max(0, min(99, base["p"] + rng.uniform(-14, 14))))
        cmd = ["espeak-ng", "-v", voice, "-s", str(speed), "-p", str(pitch), "-w", str(wav), text]
        subprocess.run(cmd, check=True, capture_output=True)
    else:
        stretch = rng.uniform(0.92, 1.18)
        scm = f"({voice}) (Parameter.set 'Duration_Stretch {stretch:.2f})"
        subprocess.run(["text2wave", "-eval", scm, "-o", str(wav)], input=text.encode(), check=True, capture_output=True)
    return wav


def to_pcm(path):
    """Trim both ends, band-limit to a radio voice band, resample to 8 kHz mono int16."""
    trim = "silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.02"
    af = f"highpass=f=140,lowpass=f=3500,{trim},areverse,{trim},areverse"
    res = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-af", af, "-ar", str(RATE), "-ac", "1", "-f", "s16le", "-"],
        check=True,
        capture_output=True,
    )
    pcm = np.frombuffer(res.stdout, dtype=np.int16).astype(np.float32)
    if pcm.size < RATE * 0.06:
        return None
    peak = np.max(np.abs(pcm)) or 1.0
    pcm = pcm * (0.92 * 32767 / peak)
    # 6 ms fades so slices never click
    f = min(48, pcm.size // 4)
    ramp = np.linspace(0, 1, f, dtype=np.float32)
    pcm[:f] *= ramp
    pcm[-f:] *= ramp[::-1]
    return np.clip(pcm, -32768, 32767).astype(np.int16)


STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
]
INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]


def adpcm_encode(samples):
    """Standard IMA ADPCM, 4 bits per sample, low nibble first. Starts at predictor 0 / index 0."""
    pred, idx = 0, 0
    out = bytearray((len(samples) + 1) // 2)
    for i, s in enumerate(samples.tolist()):
        step = STEP[idx]
        diff = s - pred
        code = 0
        if diff < 0:
            code = 8
            diff = -diff
        delta = step >> 3
        if diff >= step:
            code |= 4
            diff -= step
            delta += step
        if diff >= step >> 1:
            code |= 2
            diff -= step >> 1
            delta += step >> 1
        if diff >= step >> 2:
            code |= 1
            delta += step >> 2
        pred = pred - delta if code & 8 else pred + delta
        pred = max(-32768, min(32767, pred))
        idx = max(0, min(88, idx + INDEX[code]))
        if i & 1:
            out[i >> 1] |= code << 4
        else:
            out[i >> 1] = code
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recordings", type=Path, help="folder of real recordings named <entry>.*.wav")
    ap.add_argument("--seed", type=int, default=1871)
    args = ap.parse_args()

    vocab = json.loads(VOCAB.read_text())
    rng = random.Random(args.seed)
    jobs = []
    for i, entry in enumerate(vocab):
        for v in takes_for(entry, rng):
            jobs.append((i, v, random.Random(rng.random())))

    recordings = {}
    if args.recordings:
        for wav in sorted(args.recordings.glob("*.wav")):
            recordings.setdefault(wav.name.split(".")[0].lower(), []).append(wav)

    with tempfile.TemporaryDirectory() as tmp:

        def render(job):
            i, v, r = job
            text = vocab[i].get("s", vocab[i]["w"])
            try:
                return i, v, to_pcm(synth(text, v, r, tmp))
            except subprocess.CalledProcessError as err:
                print(f"  ! {text!r} voice {v}: {err.stderr.decode()[:120]}", file=sys.stderr)
                return i, v, None

        with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
            rendered = list(pool.map(render, jobs))

        for key, files in recordings.items():
            matches = [i for i, e in enumerate(vocab) if e["w"].lower() == key]
            if not matches:
                continue
            rendered = [r for r in rendered if r[0] != matches[0]]
            for f in files:
                rendered.append((matches[0], 255, to_pcm(f)))

    clips, blobs, offset = [], [], 0
    for i, v, pcm in rendered:
        if pcm is None:
            continue
        data = adpcm_encode(pcm)
        clips.append([i, v, offset, int(pcm.size)])
        blobs.append(data)
        offset += len(data)

    missing = sorted({vocab[i]["w"] for i in range(len(vocab))} - {vocab[c[0]]["w"] for c in clips})
    if missing:
        print("  ! no usable take for:", ", ".join(missing), file=sys.stderr)

    header = json.dumps({"rate": RATE, "codec": "ima-adpcm", "clips": clips}, separators=(",", ":")).encode()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "wb") as fh:
        fh.write(b"RVB1")
        fh.write(struct.pack("<I", len(header)))
        fh.write(header)
        for b in blobs:
            fh.write(b)
    seconds = sum(c[3] for c in clips) / RATE
    print(f"{len(clips)} takes, {seconds:.0f}s of audio, {OUT.stat().st_size / 1024:.0f} KB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
