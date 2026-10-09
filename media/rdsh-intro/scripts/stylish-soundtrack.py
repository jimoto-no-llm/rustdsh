"""Original 120 BPM soundtrack with frame-aligned transition accents."""
from pathlib import Path
import wave
import numpy as np

RATE, DURATION = 48000, 52
rng = np.random.default_rng(42)
track = np.zeros(RATE * DURATION, dtype=np.float64)
beat = .5


def add(start, samples):
    first = round(start * RATE)
    if first >= len(track):
        return
    count = min(len(samples), len(track) - first)
    track[first:first + count] += samples[:count]


def note(start, midi, duration, gain, pad=False):
    t = np.arange(round(duration * RATE)) / RATE
    freq = 440 * 2 ** ((midi - 69) / 12)
    if pad:
        sound = (np.sin(2 * np.pi * freq * t) + .35 * np.sin(2 * np.pi * freq * 1.003 * t) + .18 * np.sin(2 * np.pi * freq * 2 * t))
        env = np.minimum(1, t / .4) * np.minimum(1, (duration - t) / .7)
    else:
        sound = np.sin(2 * np.pi * freq * t) + .2 * np.sin(4 * np.pi * freq * t)
        env = (1 - np.exp(-t * 250)) * np.exp(-t * 6) * np.minimum(1, (duration - t) / .08)
    add(start, sound * env * gain)


chords = [(50, 57, 61, 66), (47, 54, 59, 62), (43, 50, 55, 59), (45, 52, 57, 61)]
for bar in range(25):
    start = 2 + bar * 2
    chord = chords[(bar // 2) % 4]
    for pitch in chord:
        note(start, pitch, 2.8, .013, pad=True)
    note(start, chord[0] - 12, 1.4, .038)
    for step in range(8):
        note(start + step * .25, chord[(step + bar) % 4] + 12, .7, .032 if step % 2 == 0 else .02)
    for step in range(4):
        at = start + step * beat
        t = np.arange(round(.24 * RATE)) / RATE
        if step % 2 == 0:
            kick = np.sin(2 * np.pi * (42 * t + 3 * (1 - np.exp(-t * 22)))) * np.exp(-t * 23)
            add(at, kick * .064)
        noise = rng.uniform(-1, 1, round(.045 * RATE))
        noise = np.diff(noise, prepend=0)
        add(at, noise * np.exp(-np.arange(len(noise)) / RATE * 170) * .007)

# Air sweeps support the actual cuts; all synthesis is local and deterministic.
for at in [2, 6, 9, 15, 19, 22, 30, 33, 40, 46]:
    t = np.arange(round(.65 * RATE)) / RATE
    noise = rng.normal(0, 1, len(t))
    noise = np.convolve(noise, np.ones(11) / 11, mode='same')
    envelope = np.sin(np.pi * t / .65) ** 2
    add(max(0, at - .35), noise * envelope * .026)

time = np.arange(len(track)) / RATE
track *= np.minimum(1, time / 1.7) * np.minimum(1, (DURATION - time) / 2.4)
track = np.tanh(track * 1.5)
left = track
right = track * .95 + np.concatenate([np.zeros(480), track[:-480]]) * .05
stereo = np.column_stack([left, right])
target = Path(__file__).resolve().parent.parent / 'public' / 'stylish-soundtrack.wav'
with wave.open(str(target), 'wb') as out:
    out.setnchannels(2); out.setsampwidth(2); out.setframerate(RATE)
    out.writeframes((np.clip(stereo, -1, 1) * 32767).astype('<i2').tobytes())
print(f'{DURATION}s / 120 BPM / peak {20*np.log10(np.max(np.abs(stereo))):.1f} dBFS')
