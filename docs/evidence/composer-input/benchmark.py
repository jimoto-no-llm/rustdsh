#!/usr/bin/env python3
"""Measure OS keyboard-to-clipboard round trips on an already running 1440x1000 Weston.

Needs DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, RDSH_BIN, RDSH_DESKTOP_DSH,
xdotool and wl-clipboard. No model calls. Before retains duplicate insertion.
This includes injected key delay and clipboard transfer, not pure handler time.
"""
import argparse,json,os,signal,statistics,subprocess,tempfile,time
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--before',type=Path,required=True);p.add_argument('--after',type=Path,required=True)
p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
report={'scope':'100 physical ASCII key events at 1ms injected delay; OS input plus clipboard; software Vulkan in VM; before inserts 200 chars, after 100; no speedup claim','results':{}}
def call(*args,**kwargs):return subprocess.run(args,check=True,capture_output=True,timeout=10,**kwargs)
def keys(*args):call('xdotool','key','--clearmodifiers','--delay','10',*args)
for label,binary in [('before',a.before),('after',a.after)]:
 with tempfile.TemporaryDirectory(prefix='composer-bench-') as profile:
  env=os.environ.copy();env.pop('RDSH_DESKTOP_ORIGIN',None)
  env.update(HOME=profile,USERPROFILE=profile,DSH_HOME=profile+'/dsh',XDG_CONFIG_HOME=profile+'/config',XDG_CACHE_HOME=profile+'/cache',XDG_DATA_HOME=profile+'/data')
  child=None;samples=[]
  with (a.output/(label+'.log')).open('w') as log:
   try:
    subprocess.run([str(binary),'--new-session'],env=env,check=True,capture_output=True,timeout=120)
    child=subprocess.Popen([str(binary)],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    time.sleep(4);assert child.poll() is None
    call('xdotool','mousemove','700','900','click','1')
    for i in range(10):
     text=str(i)+'abcdefghijklmnopqrstuvwxyz0123456789'*3;text=text[:100]
     expected=''.join(c*2 for c in text) if label=='before' else text
     keys('ctrl+a','BackSpace')
     subprocess.run(['wl-copy'],input=b'BENCH_SENTINEL',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=5)
     start=time.perf_counter()
     call('xdotool','type','--clearmodifiers','--delay','1','--',text)
     actual=''
     for _ in range(100):
      keys('ctrl+a','ctrl+c');actual=call('wl-paste','--no-newline').stdout.decode()
      if actual==expected:break
      time.sleep(.01)
     ms=(time.perf_counter()-start)*1000;assert actual==expected,(label,i,actual)
     if i>=2:samples.append(ms)
    report['results'][label]={'samples':len(samples),'median_ms':round(statistics.median(samples),3),'min_ms':round(min(samples),3),'max_ms':round(max(samples),3),'all_values_matched':True}
   finally:
    if child is not None and child.poll() is None:
     os.killpg(child.pid,signal.SIGTERM)
     try:child.wait(timeout=5)
     except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
    subprocess.run([str(binary),'--stop-host'],env=env,capture_output=True,timeout=15)
(a.output/'results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
