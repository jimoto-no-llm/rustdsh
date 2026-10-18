# Third-party licenses and notices

`rdsh` is MIT-licensed; see [LICENSE](LICENSE). It launches and supervises
DeepSeek Harness (`dsh`) rather than vendoring it, so the notices below record
which third-party software this repository uses, with which terms.

## Upstream DeepSeek Harness (`dsh`)

The upstream runtime is installed separately (npm or a package manager) and
keeps its own license. The `@deepseek-ai/*` packages this repository pins
declare MIT at those versions:

| Package | Pinned version | License |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `0.2.0-rc.2` | MIT |
| `@deepseek-ai/dsh-tool-bash` | `0.2.0-rc.2` | MIT |
| `@deepseek-ai/dsh-subagent` | `0.2.0-rc.2` | MIT |
| `@deepseek-ai/dsh-workflow-ptc` | `0.2.0-rc.2` | MIT |
| `@deepseek-ai/dsh-mcp-client` | `0.2.0-rc.2` | MIT |
| `@deepseek-ai/cordis` | `4.0.4` | MIT |

Other packages in that scope are published under their own terms and their
license is not fixed across versions: check the package you install. The
Credits section of [README.md](README.md#credits) lists the third-party DSH
plugins this repository adapts or recommends, with each author and license.

## Rust crate dependencies

Every crate reachable from `Cargo.lock`, dev-dependencies included, is
permissively licensed. [deny.toml](deny.toml) pins the allowed set with
`include-dev = true` (cargo-deny skips dev-dependencies by default) and the
`Rust dependency audit` job in
[rust-audit.yml](.github/workflows/rust-audit.yml) enforces it, so a copyleft
license or an unknown registry cannot enter the dependency tree unnoticed.

Allowed set: MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-3-Clause,
BSL-1.0, CDLA-Permissive-2.0, ISC, Unicode-3.0, Unlicense and Zlib. Reproduce
the check locally:

```sh
cargo install cargo-deny --locked
cargo deny check licenses sources
```

## Trademarks

DeepSeek, DeepSeek Harness, Claude, Claude Code, Codex, OpenAI and the other
product names used in this documentation are trademarks or registered
trademarks of their respective owners. `rdsh` is an independent community
project and is not affiliated with, endorsed by or sponsored by any of them.
