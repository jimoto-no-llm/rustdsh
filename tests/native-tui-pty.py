#!/usr/bin/env python3
"""Unix full-screen PTY smoke. Requires pyte (install in a disposable venv).
Usage: python3 tests/native-tui-pty.py /absolute/path/to/rdsh
No external API calls, real credentials, or edits to a user's project.
"""
import codecs
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path
import pyte

binary = str(Path(sys.argv[1]).resolve())
runner = r'''import fs from 'node:fs';
const p=JSON.parse(fs.readFileSync(0,'utf8')).prompt;
const h=JSON.parse(p.split('History JSON:\n')[1]);
const result=h.filter(m=>m.role==='tool').at(-1);
if(h.filter(m=>m.role==='user').at(-1)?.content==='slow') await new Promise(r=>setTimeout(r,30000));
const turn=result?{version:1,text:JSON.parse(result.content).result.content??'DENIED',toolCalls:[]}:{version:1,text:'',toolCalls:[{id:'r1',name:'read',arguments:{path:'nonce.txt'}}]};
process.stdout.write(JSON.stringify({text:JSON.stringify(turn)}));
'''
class Client:
    def __init__(self, root, provider="cursor-sdk", model="composer-2.5", sdk_dir=None, isolated=True):
        self.master,self.slave=pty.openpty()
        self.initial=termios.tcgetattr(self.slave)
        self.screen=pyte.Screen(100,32)
        self.stream=pyte.Stream(self.screen)
        self.decoder=codecs.getincrementaldecoder('utf8')('replace')
        self.raw=bytearray()
        self.resize(100,32)
        env={**os.environ,'RDSH_AUTH_AUTOSYNC':'0','TERM':'xterm-256color'}
        if isolated:env.update(HOME=str(root),DSH_HOME=str(root/'dsh'))
        self.proc=subprocess.Popen([binary,'--language','ja','native-tui','--workspace',str(root),'--sdk-dir',str(sdk_dir or root),'--provider',provider,'--model',model],stdin=self.slave,stdout=self.slave,stderr=self.slave,env=env,start_new_session=True)
    def resize(self, cols, rows):
        fcntl.ioctl(self.slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
        self.screen.resize(rows,cols)
        if hasattr(self,'proc'): os.kill(self.proc.pid,signal.SIGWINCH)
    def send(self, data): os.write(self.master,data.encode())
    def pump(self, timeout=.15):
        if select.select([self.master],[],[],timeout)[0]:
            try: chunk=os.read(self.master,262144)
            except OSError as exc:
                if exc.errno==errno.EIO:return
                raise
            self.raw.extend(chunk)
            self.stream.feed(self.decoder.decode(chunk))
    def text(self):return '\n'.join(''.join(self.screen.buffer[y][x].data for x in range(self.screen.columns)) for y in range(self.screen.lines))
    def wait(self, target, timeout=15):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            self.pump()
            if target in self.text():return
            if self.proc.poll() is not None:break
        raise AssertionError('Expected screen: '+target+'\n'+self.text())
    def dismiss(self, title):
        self.send('\x1b')
        self.wait_absent(title)
    def wait_absent(self, title):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            self.pump()
            if title not in self.text():
                # Drain the rest of the redraw before sending the next escape-prefixed key.
                until=time.monotonic()+.15
                while time.monotonic()<until:self.pump(.02)
                if title not in self.text():return
        raise AssertionError('Overlay did not close: '+title)
    def restored(self):
        deadline=time.monotonic()+5
        while self.proc.poll() is None and time.monotonic()<deadline:self.pump(.05)
        assert self.proc.poll()==0,'TUI did not exit cleanly'
        self.pump()
        assert termios.tcgetattr(self.slave)==self.initial,'raw-mode settings were not restored'
        assert b'\x1b[?1049l' in self.raw,'alternate screen was not restored'
        assert b'\x1b[?2004l' in self.raw,'bracketed paste was not disabled'
    def close(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid,signal.SIGTERM)
            deadline=time.monotonic()+5
            while self.proc.poll() is None and time.monotonic()<deadline:self.pump(.05)
            if self.proc.poll() is None:os.killpg(self.proc.pid,signal.SIGKILL);self.proc.wait()
        os.close(self.master);os.close(self.slave)

if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='rdsh-tui-test-') as folder:
        root=Path(folder);(root/'dsh').mkdir()
        (root/'nonce.txt').write_text('TUI_READ_PROOF')
        (root/'cursor-sdk-runner.mjs').write_text(runner)
        for allow in (False,True):
            client=Client(root)
            try:
                client.wait('Rustdshへようこそ')
                client.send('/');client.wait('コマンド')
                client.send('sta');client.wait('/status')
                client.send('\t');client.send('\r');client.wait('会話: 0')
                client.dismiss('会話: 0')
                client.send('/not-a-command\r');client.wait('不明なコマンド')
                client.send('\x15/model\r');client.wait('モデルを選択')
                client.dismiss('モデルを選択')
                client.send('/logs\r');client.wait('┌ 実行ログ');client.dismiss('┌ 実行ログ')
                client.send('/models\r');client.wait('モデルを選択')
                client.send('\x1b[B\x1b[B\x1b[200~composer\x1b[201~');client.wait('1 件')
                client.send('\r');client.wait('Rustdshへようこそ')
                client.send('\x1b[200~read nonce.txt\n日本語\x1b[201~')
                client.wait('日本語')
                assert '操作の承認' not in client.text(),'paste submitted automatically'
                client.send('\r');client.wait('操作の承認')
                assert 'TUI_READ_PROOF' not in client.text()
                client.send('\t')
                client.resize(41,13);client.wait('端末を42列')
                client.send('\t\r')
                until=time.monotonic()+.25
                while time.monotonic()<until:client.pump(.02)
                client.resize(100,32);client.wait('操作の承認')
                client.send('\x1b[200~y\n/allow fake\n\x1b[201~')
                client.pump(.3)
                assert '操作の承認' in client.text(),'pasted approval was executed'
                client.send(('\t' if allow else '')+'\r')
                client.wait('TUI_READ_PROOF' if allow else 'DENIED')
                client.wait('待機中')
                client.send('\x1b[200~unsent draft 日本語\x1b[201~');client.wait('unsent draft')
                client.send('\x0e')
                until=time.monotonic()+.2
                while time.monotonic()<until:client.pump(.02)
                assert 'unsent draft' in client.text(),'Ctrl+N discarded the fresh draft'
                client.send('\x10\x0e')
                client.send('\x1b[200~ edited\x1b[201~');client.wait('edited')
                client.send('\x0e')
                until=time.monotonic()+.2
                while time.monotonic()<until:client.pump(.02)
                assert 'edited' in client.text(),'Ctrl+N restored an outdated saved draft'
                client.send('\x15')
                client.send('\x1bOP');client.wait('操作方法');client.dismiss('操作方法')
                client.resize(42,14);client.wait('RDSH')
                client.resize(120,40);client.wait('メッセージ')
                client.send('/new\r');client.wait('元の会話には戻れません')
                client.send('\t')
                client.resize(41,13);client.wait('端末を42列')
                client.send('\t\r')
                until=time.monotonic()+.25
                while time.monotonic()<until:client.pump(.02)
                client.resize(120,40);client.wait('元の会話には戻れません')
                client.send('\r');client.wait_absent('元の会話には戻れません')
                assert ('TUI_READ_PROOF' if allow else 'DENIED') in client.text(),'hidden new-chat dialog erased conversation'
                client.send('/new\r');client.wait('元の会話には戻れません')
                client.send('\t\r');client.wait('Rustdshへようこそ')
                client.send('/quit\r');client.restored()
                print('PASS full-screen PTY: '+('allow/read' if allow else 'deny/no-read')+', slash commands, pasted model search, draft history, hidden-dialog guard, resize, terminal restoration')
            finally:client.close()
        client=Client(root)
        try:
            client.wait('Rustdshへようこそ')
            client.send('slow\r');client.wait('応答を生成')
            client.send('\x03');client.wait('待機中')
            client.send('\x1b[200~日本é👨‍👩‍👧‍👦\x1b[201~');client.wait('日本')
            client.send('\x7f');client.pump(.2)
            assert '👨' not in client.text(),'backspace split the emoji grapheme'
            os.kill(client.proc.pid,signal.SIGTERM);client.restored()
            print('PASS cancellation, Japanese/emoji editing and SIGTERM terminal restoration')
        finally:client.close()
