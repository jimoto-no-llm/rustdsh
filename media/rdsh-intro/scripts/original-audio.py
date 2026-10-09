"""Edit the licensed music bed and add original frame-timed mechanical UI sounds."""
from pathlib import Path
import json
import subprocess
import wave
import numpy as np

root=Path(__file__).resolve().parent.parent
rate,duration=48000,44
rng=np.random.default_rng(314)
effects=np.zeros((rate*duration,2))
events=[]

def place(at,samples,level=.6,pan=0.,kind='key'):
    start=round(at*rate)
    count=min(len(samples),len(effects)-start)
    signal=samples[:count]*level
    effects[start:start+count,0]+=signal*(.8-pan*.2)
    effects[start:start+count,1]+=signal*(.8+pan*.2)
    events.append({'seconds':round(at,4),'kind':kind})

def key(at,strong=False):
    t=np.arange(round(.075*rate))/rate
    n=rng.normal(0,1,len(t))
    smooth=np.convolve(n,np.ones(5)/5,mode='same')
    attack=(1-np.exp(-t*2500))
    mechanical=.20*smooth*np.exp(-t*160)+.045*np.sin(2*np.pi*930*t)*np.exp(-t*88)+.028*np.sin(2*np.pi*340*t)*np.exp(-t*54)
    delayed=np.roll(smooth,round(.006*rate))*.035*np.exp(-t*135)
    place(at,(mechanical+delayed)*attack,1.1 if strong else .57,rng.uniform(-.2,.2),'enter' if strong else 'key')

# Match the actual typed characters, then the result reveal.
for frame in [48,63,79,94]: key(frame/60)
for begin,end,count in [(293,374,len('rdsh search TODO --dir .')),(483,556,len('rdsh tokens README.md'))]:
    for frame in np.linspace(begin+2,end,count): key(frame/60)
for frame in [390,569,1263,1730]: key(frame/60,True)

# Saved state: a soft two-part latch, not a notification melody.
for at,freq,gain in [(29.25,650,.038),(29.31,470,.026)]:
    t=np.arange(round(.15*rate))/rate
    body=np.sin(2*np.pi*freq*t)*(1-np.exp(-t*900))*np.exp(-t*44)
    place(at,body,gain/.038,kind='save')
key(38.3,True)

def wav(path,data):
    with wave.open(str(path),'wb') as out:
        out.setnchannels(2);out.setsampwidth(2);out.setframerate(rate)
        out.writeframes((np.clip(data,-1,1)*32767).astype('<i2').tobytes())

wav(root/'public/original-operations.wav',effects)
subprocess.run(['ffmpeg','-v','error','-ss','24','-i',str(root/'public/chill-wave-source.mp3'),'-t','44','-ar',str(rate),'-ac','2','-af','loudnorm=I=-23:TP=-6:LRA=8,afade=t=in:st=0:d=0.8,afade=t=out:st=40.7:d=3.3','-y',str(root/'out/original-music-bed.wav')],check=True)
with wave.open(str(root/'out/original-music-bed.wav'),'rb') as src:
    bed=np.frombuffer(src.readframes(src.getnframes()),dtype='<i2').reshape(-1,2).astype(float)/32768
bed=bed[:len(effects)]
if len(bed)<len(effects): bed=np.pad(bed,((0,len(effects)-len(bed)),(0,0)))
mixed=bed+effects
peak=np.max(np.abs(mixed))
assert peak<.89,peak
wav(root/'public/original-mix.wav',mixed)
(root/'out/original-audio-events.json').write_text(json.dumps({'music_excerpt_seconds':[24,68],'duration_seconds':44,'music_target_lufs':-23,'peak_dbfs':round(20*np.log10(peak),2),'events':events},indent=2)+'\n')
print(f'44s music edit + {len(events)} timed UI sounds; peak {20*np.log10(peak):.2f} dBFS')
