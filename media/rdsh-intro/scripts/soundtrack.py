"""Generate an original, quiet 64-second electronic backing track. No samples."""
from pathlib import Path
import math
import random
import wave
import array

RATE = 48000
DURATION = 64
track = array.array('f', [0.0]) * (RATE * DURATION)
rng = random.Random(19)


def tone(start, length, frequency, volume, harmonics=False):
    first = int(start * RATE)
    count = min(int(length * RATE), len(track) - first)
    for i in range(count):
        t = i / RATE
        envelope = min(1.0, t / 0.04) * math.exp(-t * 2.5 / length)
        envelope *= min(1.0, (length - t) / 0.12)
        sample = math.sin(2 * math.pi * frequency * t)
        if harmonics:
            sample += 0.18 * math.sin(4 * math.pi * frequency * t)
        track[first + i] += sample * envelope * volume


def midi(note):
    return 440 * 2 ** ((note - 69) / 12)


# A restrained D minor / Bb / F / C progression at 100 BPM.
chords = [(50, 57, 62, 65), (46, 53, 58, 62), (53, 60, 65, 69), (48, 55, 60, 64)]
beat = 0.6
for bar in range(27):
    start = bar * 4 * beat
    chord = chords[(bar // 2) % len(chords)]
    if start >= DURATION:
        break
    for note in chord:
        tone(start, min(3.6, DURATION - start), midi(note), 0.011)
    for step in range(8):
        at = start + step * beat / 2
        if at < DURATION:
            tone(at, min(0.8, DURATION - at), midi(chord[(step + bar) % 4] + 12), 0.012)
    for step in (0, 2):
        at = start + step * beat
        if at >= DURATION:
            continue
        first = int(at * RATE)
        for i in range(min(int(0.19 * RATE), len(track) - first)):
            t = i / RATE
            phase = 2 * math.pi * (44 * t + 3.3 * (1 - math.exp(-t * 24)))
            track[first + i] += math.sin(phase) * math.exp(-t * 25) * 0.035
    for step in range(4):
        at = start + step * beat
        if at >= DURATION:
            continue
        first = int(at * RATE)
        for i in range(min(int(0.04 * RATE), len(track) - first)):
            track[first + i] += rng.uniform(-1, 1) * math.exp(-i / RATE * 150) * 0.006

pcm = array.array('h')
peak = 0.0
for i, sample in enumerate(track):
    at = i / RATE
    fade = min(1.0, at / 2, (DURATION - at) / 3)
    value = math.tanh(sample) * fade * 2.5
    peak = max(peak, abs(value))
    pcm.append(round(value * 32767))
target = Path(__file__).resolve().parent.parent / 'public' / 'soundtrack.wav'
with wave.open(str(target), 'wb') as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(RATE)
    out.writeframes(pcm.tobytes())
print(f'Generated {DURATION}s soundtrack, peak {20 * math.log10(peak):.1f} dBFS')
