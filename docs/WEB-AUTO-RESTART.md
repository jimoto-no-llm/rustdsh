# Web service recovery on Linux

An existing systemd user service can keep the dsh Web GUI running, including
when its launcher is rdsh. Install the supplied drop-in on the service that
already owns the Web GUI port. This does not create a second Web server or
change the launch command, authentication, or browser behavior.

From the repository root, for an existing `dsh-web.service`:

```sh
mkdir -p ~/.config/systemd/user/dsh-web.service.d
install -m 644 systemd/web-auto-restart.conf \
  ~/.config/systemd/user/dsh-web.service.d/auto-restart.conf
systemctl --user daemon-reload
systemctl --user enable dsh-web.service
systemctl --user start dsh-web.service
systemctl --user show dsh-web.service \
  -p ActiveState -p SubState -p Restart -p RestartUSec \
  -p StartLimitIntervalUSec -p OOMPolicy
```

If your existing service is named `rdsh-web.service`, substitute that name in
the commands and drop-in directory. `rdsh serve` is a separate status dashboard;
apply the drop-in to its existing service if that is the service to recover.

The new restart policy takes effect after `daemon-reload`, including for an
already running service; the installation does not interrupt active requests.
An unexpected process exit, including exit status 0, triggers a restart after
five seconds. Repeated failures continue to retry. If the OOM killer terminates
a child, systemd stops the service group before restarting it. This requires
systemd 243 or later and working OOM event tracking for the service cgroup.

`systemctl --user stop dsh-web.service` intentionally stops it and does not
restart it. Enabling the service starts it when the user's systemd manager
starts. Surviving logout requires an independently configured user manager
lifetime (for example, lingering); this drop-in does not change login policy.

Check `NRestarts` and the service state to confirm recovery without exposing
authentication URLs or conversation contents:

```sh
systemctl --user show dsh-web.service -p ActiveState -p SubState -p NRestarts
```

A service may rotate its authentication token on restart. Use its existing
browser opener or private launch URL mechanism to reconnect. Automatic restart
restores availability; it does not replay an interrupted model request.

## Restarting from inside the Web GUI

A tool running inside dsh must not run `systemctl stop` on its own service
followed by an install and `systemctl start`. Stopping the service also stops
its tools, so the remaining commands never run. `Restart=always` deliberately
does not undo that explicit stop.

Complete any package installation first, then hand off the restart to an
independent transient systemd service:

```sh
sh scripts/restart-web-service.sh dsh-web.service
```

For use outside this checkout, install the helper:

```sh
mkdir -p ~/.local/bin
install -m 755 scripts/restart-web-service.sh ~/.local/bin/rdsh-web-restart
rdsh-web-restart dsh-web.service
```

The helper returns after the restart job is accepted, without waiting for the
Web GUI to become ready. Reconnect using the service's existing browser opener
or private launch URL mechanism and verify the service state. If an installation
requires the Web service to be stopped, run the entire maintenance operation
from an external terminal instead of a tool inside that service.

## 日本語

既存の `dsh-web.service`（rdsh経由の起動も含みます）に上記の設定を追加すると、
異常終了・予期しない正常終了・メモリ不足による終了から5秒後に再起動します。
失敗が続いても再試行します。手動の `systemctl --user stop` では停止を維持します。
`rdsh-web.service` など別の名前を使っている場合は、設定先とコマンドの名前を
置き換えてください。既存の起動コマンドや認証設定はそのまま使います。

再起動で認証トークンが変わる場合は、既存のブラウザー起動機能などで再接続します。
処理中だったモデルへの依頼は自動で再送しません。

dsh内のツールから自分のサービスを停止すると、そのツールも終了するため、
後続の起動コマンドには到達しません。パッケージの導入を先に終えてから、
`rdsh-web-restart dsh-web.service` で独立したサービスへ再起動を引き渡します。
停止中に導入作業が必要な場合は、外部の端末で作業してください。
