# NOTICE: upstream derivation and licensing

rdsh-desktop is a Rust/GPUI reimplementation of the DeepSeek Harness desktop
experience. It derives from, and stays compatible with, this upstream project:

- deepseek-ai/deepseek-harness (MIT License, Copyright (c) 2026 DeepSeek)
- Pinned revision: d743267388641bc76f17c45ce8b4c231aed1d32c
  (recorded in rustdsh desktop/upstream.lock.json, harness 0.2.1-alpha.2)
- Compatible released harness builds: 0.2.0-rc.2, 0.2.1-alpha.2 and
  0.2.1-rc.2 (verified with the session list, model catalog, live streams,
  prompt streaming and the cookie attach path)
- Reference modules: apps/desktop (Electron shell), apps/web (web UI),
  packages/client/ui-theme (design tokens), packages/api (client protocol)

## What is derived

- Design values: colors, typography scale, radii, layout constants and the
  structure of the main conversation screen (see src/theme.rs and src/app.rs).
- Client protocol: HTTP/WebSocket endpoints, request envelopes and the live
  stream semantics (see src/http.rs, src/api.rs, src/mux.rs, src/live.rs).

No upstream source file is copied verbatim. The Rust sources are an independent
implementation written against the observed protocol and theme values.

## What is intentionally not included

- Brand assets: the DeepSeek wordmark, logos, favicons and application icons are
  trademarks and are not licensed by MIT. This app draws its own text labels and
  uses system fonts; the bundled Montserrat webfont (SIL OFL-1.1) from
  packages/client/ui-theme is not shipped here.

## Vendored dependencies

vendor/xattr is a small, freshly written implementation of the xattr 0.2 API
(MIT OR Apache-2.0), created because gpui pins xattr 0.2.3, which no longer
compiles on current Linux toolchains. It contains no upstream code.

vendor/proc-macro-error2 contains the published proc-macro-error2 2.0.1
sources (MIT OR Apache-2.0), with a visibility fix for Rust's
`pub_use_of_private_extern_crate` lint and rustfmt formatting.
Its NOTICE.md records the archive checksum and exact change; the original
LICENSE-MIT and LICENSE-APACHE are included alongside the source.

## Dependency licenses

The application dependency tree is permissive (MIT, Apache-2.0, BSD-3-Clause,
Zlib, Unicode-3.0) with no copyleft licenses; run cargo metadata to reproduce
the inventory.
