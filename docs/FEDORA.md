# Fedora notes

rdsh treats Fedora as a first-class Linux host. This page lists the packages
that matter, what the optional ones unlock, and where the DeepSeek Harness
Desktop application stands on Linux.

Tested on **Fedora 44 (KDE)** x86_64; the same applies to RHEL, CentOS Stream,
Rocky and AlmaLinux.

## Install

Prebuilt binary:

```sh
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

From source (the Fedora toolchain packages are enough):

```sh
sudo dnf install -y cargo gcc gcc-c++ make git
./install.sh            # add --as-dsh to shadow the dsh command
```

Native package:

```sh
sudo dnf install ./rdsh-<version>-1.x86_64.rpm
```

Download the `.rpm` from the
[latest release](https://github.com/jimoto-no-llm/rustdsh/releases/latest);
`<version>` is the tag without its leading `v`. The package installs
`/usr/bin/rdsh` plus the licence and README, and carries the same glibc build
as `rdsh-linux-x64.tar.gz`. On a host whose glibc is older than that build's,
use the musl archive or `install.sh` instead.

## Optional packages

| Package | Unlocks | Without it |
| --- | --- | --- |
| `zstd` | token unpacking in `rdsh sessions --tokens` | stored-bytes / 4 estimates |
| `bubblewrap` | the `--share-file` agent-tool sandbox and `features.agent_tool_sandbox` | the strict sandbox refuses to start |
| `nodejs` (22 or newer) | `rdsh-dashboard` | the Node dashboard is unavailable |
| `searxng` (own service or container) | `rdsh search-web` | local web search is unavailable |

`rdsh doctor` prints exactly which of these this host is missing, with the
command that installs them; `install.sh` prints the same list once after
installing. Both stay silent when nothing is missing, and neither fails on
non-rpm hosts.

```sh
sudo dnf install -y zstd bubblewrap
```

`install.sh` also checks what the install itself needs before it downloads or
builds anything: `curl`, `tar`, `gzip` and coreutils (`sha256sum`/`install`),
plus the Node.js 22+ / original `dsh` state and whether `PREFIX` is writable.
Each finding comes with the host's own command (`sudo dnf install -y ...` on
rpm hosts, the equivalent on Debian, Alpine, Arch and openSUSE) and, when the
chosen path cannot finish without a tool, the installer stops there instead of
failing halfway.

The release archives carry a glibc build and a static musl fallback. An rpm host
uses the glibc build, and the static fallback needs no package either, so
`musl-libc`/`musl-gcc` are never required to run a prebuilt binary; `--musl`
only selects the static archive explicitly. The installer prints which one it
chose after a release install.

## Desktop application

Upstream publishes, builds and launches the Desktop shell only for
`mac-arm64`, `mac-x64` and `win-x64`: `resolveDesktopBuildTarget` rejects
every other target, so on Fedora `pnpm run dev:desktop` and the `package:*`
scripts stop with `desktop build paths: unsupported target linux-x64`, and
the AppImage block in the electron-builder config is not reachable from those
targets. The equivalent surface on Fedora is the **Web profile**:

```sh
rdsh --profile web                  # the application the desktop shell wraps
PROFILE=web ./plugins/install.sh    # same plugins the shell would load
```

`rdsh desktop` still detects an extracted AppImage (`--appimage-extract`),
an unpacked tree (`DSH_DESKTOP_APP_DIR`) or an explicit command
(`DSH_DESKTOP_CLI`) if one becomes available; see
[DESKTOP-INTEGRATION.md](DESKTOP-INTEGRATION.md).

## Verify a Fedora install

```sh
rdsh doctor                 # paths, wrapper shadowing, auth, optional packages
rdsh --version && rdsh tokens README.md
```

From a source checkout:

```sh
cargo test --release
sh tests/regress.sh         # needs an original dsh: DSH_ORIG_BIN=/path/to/dsh
```

The regress suite drives the installed binary the way a user does and needs the
usual coreutils plus `diffutils` (for `cmp`); `sudo dnf install -y diffutils`
if a minimal install is missing it. Everything else it uses (zstd, node,
python3, tar, gzip) is already listed above or ships with Fedora.

CI builds and tests this repository inside a `fedora:latest` container, so
the package names on this page are exercised on every push. The isolated
install suite also runs `install/os-release-hints`, which fakes `ID=fedora` on
a Debian base so the rpm branch stays covered on hosts that are not Fedora.
