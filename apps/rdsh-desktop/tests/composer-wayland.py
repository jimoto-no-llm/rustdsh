#!/usr/bin/env python3
"""Real Wayland composer regression; needs X11-backed Weston, xdotool and wl-clipboard.

Set DISPLAY, WAYLAND_DISPLAY and XDG_RUNTIME_DIR.
Set RDSH_DESKTOP_DSH and RDSH_BIN to the installed test harness and rdsh.
The test creates and removes its own isolated HOME/DSH_HOME and stops its host.
No provider credentials or model calls are required. Run against a fixed-size
1440x1000 Weston output; --x/--y select a point inside the composer.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--x', type=int, default=700)
    parser.add_argument('--y', type=int, default=900)
    parser.add_argument('--verify-send', action='store_true',
                        help='also submit Enter and verify the exact prompt in the isolated DSH session')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = []

    def run(*command, **kwargs):
        return subprocess.run(command, check=True, capture_output=True, timeout=5, **kwargs)

    def keys(*names):
        run('xdotool', 'key', '--clearmodifiers', '--delay', '40', *names)

    def type_text(text):
        run('xdotool', 'type', '--clearmodifiers', '--delay', '15', '--', text)

    def reset(text):
        keys('ctrl+a', 'BackSpace')
        type_text(text)

    def paste(text):
        # wl-copy forks a clipboard owner; pipes inherited by that owner would
        # keep communicate() waiting after the launcher has already exited.
        subprocess.run(['wl-copy', '--type', 'text/plain;charset=utf-8'],
                       input=text.encode(), check=True, timeout=5,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        keys('ctrl+v')

    def screenshot(name):
        folder = output / name
        folder.mkdir(exist_ok=True)
        previous = set(folder.glob('*.png'))
        run('weston-screenshooter', cwd=folder)
        images = list(set(folder.glob('*.png')) - previous)
        if not images:
            raise AssertionError('Weston did not produce a screenshot')
        return str(images[-1].relative_to(output))

    def verify(name, expected):
        actual = None
        # Clipboard transfer is asynchronous; wait for the observed editor value.
        for _ in range(12):
            keys('ctrl+a', 'ctrl+c')
            actual = run('wl-paste', '--no-newline').stdout.decode()
            if actual == expected:
                break
            time.sleep(0.1)
        keys('End')
        result = dict(case=name, expected=expected, actual=actual,
                      passed=actual == expected, screenshot=screenshot(name))
        results.append(result)
        (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        assert result['passed'], json.dumps(result, ensure_ascii=False)

    profile = tempfile.TemporaryDirectory(prefix='composer-profile-', dir=output)
    desktop_env = os.environ.copy()
    desktop_env.pop('RDSH_DESKTOP_ORIGIN', None)
    desktop_env.update(HOME=profile.name, USERPROFILE=profile.name,
                       DSH_HOME=str(Path(profile.name) / 'dsh'),
                       XDG_CONFIG_HOME=str(Path(profile.name) / 'config'),
                       XDG_CACHE_HOME=str(Path(profile.name) / 'cache'),
                       XDG_DATA_HOME=str(Path(profile.name) / 'data'))
    with (output / 'app.log').open('w') as log:
        child = None
        try:
            subprocess.run([str(args.binary.resolve()), '--new-session'], env=desktop_env,
                           check=True, capture_output=True, timeout=120)
            child = subprocess.Popen([str(args.binary.resolve())], stdin=subprocess.DEVNULL,
                                     env=desktop_env, stdout=log, stderr=log, start_new_session=True)
            time.sleep(4)
            if child.poll() is not None:
                raise AssertionError('Desktop exited before keyboard input; inspect app.log')
            run('xdotool', 'mousemove', str(args.x), str(args.y), 'click', '1')
            reset('abc123'); verify('ascii', 'abc123')
            reset('bookkeeper 111 aaa'); verify('repeated-characters', 'bookkeeper 111 aaa')
            reset('ABC_xyz-+=!?123'); verify('shift-and-symbols', 'ABC_xyz-+=!?123')
            reset('abc'); keys('Left', 'Left'); type_text('X'); verify('insert-at-caret', 'aXbc')
            reset('abcd'); keys('BackSpace'); verify('backspace', 'abc')
            reset('abcd'); keys('Home', 'Right', 'Delete'); verify('delete', 'acd')
            reset('replace me'); keys('ctrl+a'); type_text('Z'); verify('replace-selection', 'Z')
            reset('Copy-me-123'); keys('ctrl+a', 'ctrl+x'); type_text('prefix:'); keys('ctrl+v')
            verify('cut-and-paste', 'prefix:Copy-me-123')
            reset('line1'); keys('shift+Return'); type_text('line2'); verify('newline', 'line1\nline2')
            keys('ctrl+a'); paste('日本語🙂 café\n2行目'); verify('unicode-paste', '日本語🙂 café\n2行目')
            keys('ctrl+a'); paste('A🙂B'); keys('End', 'Left', 'BackSpace'); verify('unicode-backspace', 'AB')
            keys('ctrl+a'); paste('A\r\nB\0'); verify('paste-sanitization', 'A\nB')
            if args.verify_send:
                marker = 'SEND_PIPELINE_abc123'
                reset(marker)
                keys('Return')
                persisted = False
                for _ in range(10):
                    dump = subprocess.run([str(args.binary.resolve()), '--dump-session'],
                                          env=desktop_env, capture_output=True, timeout=20)
                    if dump.returncode == 0:
                        value = json.loads(dump.stdout)
                        turns = value.get('projections', {}).get('values', {}).get('turnOutline', [])
                        persisted = any(turn.get('prompt') == marker for turn in turns)
                        (output / 'send-readback.json').write_text(
                            json.dumps(value, ensure_ascii=False, indent=2))
                        if persisted:
                            break
                    time.sleep(0.2)
                results.append(dict(case='enter-to-real-host', marker=marker, passed=persisted))
                (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
                assert persisted, 'Enter did not persist the exact prompt in the isolated DSH session'
        finally:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            subprocess.run([str(args.binary.resolve()), '--stop-host'], env=desktop_env,
                           capture_output=True, timeout=15)
            profile.cleanup()


if __name__ == '__main__':
    main()
