#!/usr/bin/env python3
"""Exercise localized setup prompts in a real POSIX terminal without credentials."""
import errno
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
binary = Path(os.environ.get('RDSH_E2E_BIN', str(repo / 'target/release/rdsh'))).resolve()
output = Path(os.environ.get('RDSH_E2E_OUTPUT', str(repo / 'target/cli-tty')))
output.mkdir(parents=True, exist_ok=True)
cases = []
for language, paste, save in [
    ('en', 'paste DEEPSEEK_API_KEY here', 'save DEEPSEEK_API_KEY from the environment'),
    ('zh-CN', '在此粘贴 DEEPSEEK_API_KEY', '将环境中的 DEEPSEEK_API_KEY 保存到凭据中'),
    ('ja', 'DEEPSEEK_API_KEY を貼り付けてください', '環境変数 DEEPSEEK_API_KEY を認証情報に保存しますか'),
]:
    for mode, expected, answer in [('paste', paste, b'\n'), ('save', save, b'n\n')]:
        with tempfile.TemporaryDirectory(prefix='rdsh-cli-tty-') as home:
            env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP') if key in os.environ}
            env.update(HOME=home, USERPROFILE=home, DSH_HOME=home,
                       XDG_CONFIG_HOME=home+'/config', XDG_DATA_HOME=home+'/data', XDG_CACHE_HOME=home+'/cache', LANG='C')
            if mode == 'save':
                env['DEEPSEEK_API_KEY'] = 'fixture-key'
            master, slave = pty.openpty()
            child = subprocess.Popen([str(binary), '--language', language, 'setup'], env=env, cwd=home,
                                     stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            transcript = b''
            answered = False
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    ready, _, _ = select.select([master], [], [], 0.05)
                    if ready:
                        try:
                            chunk = os.read(master, 65536)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            chunk = b''
                        transcript += chunk
                        if not answered and expected in transcript.decode('utf8', errors='replace'):
                            os.write(master, answer)
                            answered = True
                        if not chunk:
                            break
                    elif child.poll() is not None:
                        break
                assert answered, f'{language}/{mode}: localized prompt not observed'
                assert child.wait(timeout=3) == 0, f'{language}/{mode}: setup did not finish'
                text = transcript.decode('utf8')
                assert 'fixture-key' not in text
                assert not (Path(home)/'.credentials.yaml').exists()
                cases.append({'language': language, 'mode': mode, 'prompt': expected, 'exit': 0, 'credentials_written': False})
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                os.close(master)
report = {'result': 'PASS', 'scope': 'actual POSIX PTY, no provider/model calls, no credentials entered or stored', 'cases': cases}
(output/'cli-tty-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'result': 'PASS', 'cases': len(cases), 'output': str(output)}, ensure_ascii=False))
