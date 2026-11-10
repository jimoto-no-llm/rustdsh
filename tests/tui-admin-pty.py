#!/usr/bin/env python3
"""PTY management + terminal proof using the isolated DSH HTTP/WS fixture.

Requires pyte and Node ws. No model, real settings, credentials, or shell commands
are used. The terminal Host is a protocol fixture; real-shell proof is separate.
Usage: python3 tests/tui-admin-pty.py /path/to/rdsh --ws-package PACKAGE_JSON
"""
import argparse
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path


def fixture_module():
    spec = importlib.util.spec_from_file_location("dsh_admin_pty_fixture", Path(__file__).with_name("dsh-tui-pty.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def paste(client, value):
    text = json.dumps(value, ensure_ascii=False)
    client.send("\x15\x1b[200~" + text + "\x1b[201~")


def prepare(client, action, args):
    client.command("/manage " + action)
    client.wait("DSH 管理")
    client.wait("Ctrl+S 確認")
    paste(client, args)
    client.send("\x13")
    client.wait("実行する")


def execute(client, action, args, status="complete"):
    prepare(client, action, args)
    client.send("\t\r")
    client.wait("状態: " + status)


def close_manage(client):
    client.dismiss("DSH 管理")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary")
    parser.add_argument("--ws-package", required=True)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    ws_package = str(Path(args.ws_package).resolve())
    fixture = fixture_module()
    with tempfile.TemporaryDirectory(prefix="rdsh-admin-pty-") as folder:
        root = Path(folder).resolve()
        (root / "dsh").mkdir()
        (root / "tmp").mkdir()
        (root / "mock-dsh.mjs").write_text("#!/usr/bin/env node\n" + fixture.MOCK)
        (root / "mock-dsh.mjs").chmod(0o755)
        (root / "attachment.txt").write_bytes(b"ADMIN_ATTACHMENT_BYTES")
        syntax = subprocess.run(["node", "--check", str(root / "mock-dsh.mjs")], capture_output=True, text=True)
        assert syntax.returncode == 0, syntax.stderr
        previous_tmp = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = str(root / "tmp")
        try:
            client = fixture.Client(root, binary, ws_package)
        finally:
            if previous_tmp is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = previous_tmp
        try:
            client.resize(140, 44)
            client.wait("DSH runtime")
            client.wait("待機中")
            # Catalog search and escape must not invoke the selected operation.
            client.command("/manage")
            client.wait("DSH 管理")
            client.send("settings/update")
            client.wait("settings/update")
            client.send("\x1b")
            client.wait_absent("DSH 管理")
            assert not fixture.rpc_rows(client.events(), "settings/update")

            # Explicit confirmation, not Ctrl+S alone, applies the mutation.
            value = {"ns": "fixture", "patch": {"label": "ADMIN_SETTING_UPDATED"}, "expectedRevision": 7}
            prepare(client, "settings/update", value)
            client.send("\r")
            client.wait("Ctrl+S 確認")
            assert not fixture.rpc_rows(client.events(), "settings/update"), "default confirmation approved mutation"
            client.send("\x13")
            client.wait("実行する")
            client.send("\t\r")
            client.wait("状態: complete")
            client.wait("ADMIN_SETTING_UPDATED")
            close_manage(client)
            # Redisplay reads Host state and the next revision, not local optimistic state.
            execute(client, "settings/describe", {})
            client.wait("ADMIN_SETTING_UPDATED")
            assert "FIXTURE_PRIVATE_SETTING" not in client.text()
            close_manage(client)
            execute(client, "settings/update", {**value, "patch": {"label": "MUST_NOT_APPLY"}}, "failed")
            client.wait("settings/revision-conflict")
            close_manage(client)
            assert len([r for r in client.events() if r["kind"] == "settings-updated"]) == 1

            # Secret input stays masked during editing, confirmation, and result rendering.
            prepare(client, "credentials/set", {"ref": "fixture-key", "value": "ADMIN_SECRET_NEVER_ECHO"})
            assert "ADMIN_SECRET_NEVER_ECHO" not in client.text()
            client.send("\t\r")
            client.wait("状態: complete")
            client.wait_wire(lambda rows: any(r["kind"] == "credential-stored" for r in rows))
            assert "ADMIN_SECRET_NEVER_ECHO" not in client.raw.decode("utf8", "replace")
            close_manage(client)

            # Binary transport is exact in both directions; fixtures live in this temp cwd.
            execute(client, "fileUploads/upload", {"agentId": "session-1", "request": {"name": "attachment.txt", "data": {"$file": "attachment.txt"}}})
            client.wait("fixture-receipt")
            close_manage(client)
            execute(client, "workspaceFiles/readBytes", {})
            client.wait("$artifact")
            artifacts = list((root / "tmp").glob("rdsh-tui-artifact-*/response.bin"))
            assert len(artifacts) == 1, "binary response did not create exactly one private artifact"
            assert artifacts[0].read_bytes() == bytes([0, 1, 255, 13, 10, 128])
            assert artifacts[0].stat().st_mode & 0o777 == 0o600
            close_manage(client)

            # Explicit RDSH HTTP manifest routes use the same authenticated Host cookie.
            execute(client, "GET /api/rdsh-context", {})
            client.wait("RDSH_HTTP_PROOF")
            close_manage(client)

            # Stateful stream output, client uplink, and explicit cancellation.
            execute(client, "fixture/watch", {}, "running")
            client.wait("ADMIN_STREAM_READY")
            client.send("i")
            client.wait("JSON入力")
            paste(client, {"proof": "ADMIN_UPLINK_PROOF"})
            client.send("\x13")
            client.wait("ADMIN_UPLINK_ACK")
            client.send("\x03")
            client.wait("状態: cancelled")
            close_manage(client)

            # VT screen, ordered input, resize, hide/reopen without a replacement shell.
            client.command("/terminal")
            client.wait("接続する")
            client.send("\r")
            client.wait_absent("接続する")
            assert not any(r["kind"] == "terminal-created" for r in client.events())
            client.command("/terminal")
            client.wait("接続する")
            client.send("\t\r")
            client.wait("FIXTURE_SHELL_READY")
            client.send("echo TERMINAL_ADMIN_E2E\r")
            client.wait("RESULT:TERMINAL_ADMIN_E2E")
            resized_before = len([r for r in client.events() if r["kind"] == "terminal-resized"])
            client.resize(104, 36)
            client.wait_wire(lambda rows: len([r for r in rows if r["kind"] == "terminal-resized"]) > resized_before)
            client.send("\x1d")
            client.wait_absent("DSH 端末")
            client.command("/terminal")
            client.wait("RESULT:TERMINAL_ADMIN_E2E")
            assert len([r for r in client.events() if r["kind"] == "terminal-created"]) == 1
            client.send("\x1d")
            client.wait_absent("DSH 端末")
            client.command("/quit")
            try:
                client.restored()
            except AssertionError as error:
                tail = [row for row in client.events()[-12:] if row["kind"] != "rpc"]
                raise AssertionError(f"{error}; exit={client.proc.poll()}; wire={tail}\n{client.text()}") from error
            rows = client.events()
            assert not [r for r in rows if r["kind"] == "assertion"]
            assert not fixture.rpc_rows(rows, "session/prompt"), "administrative commands became model prompts"
            assert any(r["kind"] == "terminal-closed" for r in rows), "owned terminal was not closed on exit"
            assert any(r["kind"] == "stream-cancel" for r in rows)
            raw = client.raw.decode("utf8", "replace")
            assert all(secret not in raw for secret in ("ADMIN_SECRET_NEVER_ECHO", "FIXTURE_PRIVATE_SETTING", "fixture-launch-token", "fixture-cookie"))
            print("PASS admin PTY: catalog, explicit confirmation, revision conflict, persisted redisplay, masked credential, exact binary upload/download, authenticated RDSH HTTP, stream/uplink/cancel, VT input/resize/reopen, owned terminal cleanup, raw-mode restoration")
        finally:
            client.close()


if __name__ == "__main__":
    main()
