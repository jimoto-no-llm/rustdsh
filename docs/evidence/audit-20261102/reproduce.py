#!/usr/bin/env python3
"""Linux-only bounded reproductions; no network, credentials or repository writes."""
from pathlib import Path
import os
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[3]
BASELINE = 'b060ccf70187d0ea18155015adebf26640972598'

def baseline_source(name):
    return subprocess.check_output(['git', '-C', str(REPO), 'show', f'{BASELINE}:{name}'], text=True)

with tempfile.TemporaryDirectory(prefix='rdsh-audit-') as temporary:
    root = Path(temporary)
    (root/'exec_trust.rs').write_text(baseline_source('src/exec_trust.rs'))
    source = root / 'trust.rs'
    source.write_text('''extern crate self as libc;
unsafe extern "C" { pub fn geteuid() -> u32; }
mod executable { pub fn is_executable(p: &std::path::Path)->bool { p.is_file() } }
#[path = "''' + str(root/'exec_trust.rs') + '''"] mod exec_trust;
fn main(){let p=std::path::PathBuf::from(std::env::args().nth(1).unwrap()); println!("{:?}",exec_trust::untrusted_reason(&p));}
''')
    subprocess.run(['rustc', '--edition=2021', '-Awarnings', str(source), '-o', str(root/'trust')], check=True)
    shared = root/'shared'
    shared.mkdir()
    shared.chmod(0o777)
    tools = shared/'tools'
    tools.mkdir(mode=0o755)
    executable = tools/'git'
    executable.write_text('#!/bin/sh\nexit 0\n')
    executable.chmod(0o755)
    print('Writable ancestor accepted: ', end='', flush=True)
    subprocess.run([str(root/'trust'), str(executable)], check=True)
    tools.rename(shared/'original')
    tools.mkdir(mode=0o755)
    executable.write_text('#!/bin/sh\necho replacement\n')
    executable.chmod(0o755)
    print('Replaced directory accepted: ', end='', flush=True)
    subprocess.run([str(root/'trust'), str(executable)], check=True)
    module = baseline_source('src/dsh_env.rs')
    start = module.index('pub(crate) fn run_bounded_capture(')
    end = module.index('\n/// First non-empty', start)
    payload = 'import os,time\nif os.fork()==0:\n time.sleep(2)\nos._exit(0)'
    import json
    source = root/'capture.rs'
    source.write_text('use std::time::{Duration,Instant};\n'+module[start:end]+'''
fn main(){
let threads=||std::fs::read_dir("/proc/self/task").unwrap().count();
println!("threads before: {}",threads());
for _ in 0..3 {let mut c=std::process::Command::new("python3"); c.args(["-c", ''' + json.dumps(payload) + ''']); let _=run_bounded_capture(c,4096,Duration::from_millis(50));}
println!("threads after timed-out probes: {}",threads());
std::thread::sleep(Duration::from_secs(3));
println!("threads after descendants exit: {}",threads());
}
''')
    subprocess.run(['rustc', '--edition=2021', str(source), '-o', str(root/'capture')], check=True)
    subprocess.run([str(root/'capture')], check=True)
