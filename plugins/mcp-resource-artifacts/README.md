# MCP resource artifact patch for rustdsh

This directory packages a verified DSH source patch that exposes MCP resource content as safe, durable image and file attachments. Listing a resource link never fetches it. The model may call `open_mcp_resource_link` with the exact server and URI only after the user asks to read or inspect it.

## Behavior

- The link projection preserves the MCP server name and exact URI. It dispatches `resources/read` through the caller-scoped provider, never fetches an arbitrary URL, and rejects `ui://` before dispatch.
- Binary base64 never enters model-visible text. The patch checks canonical base64, MIME syntax, an 8 MiB per-item cap, a 16 MiB per-read cap, and a 16-part cap before storage. Large text and active text MIME types become attachments.
- PNG, JPEG, WebP and GIF bytes are verified by the attachment backend. They become image blocks only when the current model route accepts image input; otherwise they are inert file attachments. Other binary data and HTML, JavaScript or SVG use `.bin`; large or active text uses `.txt`. Nothing is executed.
- Refusals include a readable reason. Attachments follow the configured backend's retention policy; the feature does not provide automatic expiry.
- Pagination and reconnect handling remain with the existing provider. No resource is cached across servers or connection generations.

## Compatible DSH source

Node.js 22 or later and Git are required. Use a clean, isolated DSH source checkout at base `f97c0438fb1608bbc4c08c88a27344249795ea22` (`@deepseek-ai/dsh-mcp-resources` `0.1.7-rc.2`). The source patch commit is `3b7c71fc79c4fe438e1c08f6d0e98680c83d17b2`. It changes only 10 pinned source, test, lockfile and catalog paths.

Run from the rustdsh checkout. `--check` is the read-only default.

```sh
node plugins/mcp-resource-artifacts/source-patch.mjs --source ../dsh-resource-source --check
node plugins/mcp-resource-artifacts/source-patch.mjs --source ../dsh-resource-source --apply
```

The tool verifies the source root, exact base revision, patch checksum and header, file set, clean worktree and resulting Git blobs. It refuses dirty or untracked source trees without changing them and will not guess compatibility with another revision or apply to an installed DSH checkout.

It does not build or install DSH or change profiles. Build the patched source and decide separately whether to adopt that build. DSH's MIT license notice is included as `DSH-LICENSE`.

## Validation

```sh
node --test plugins/mcp-resource-artifacts/tests/source-patch.test.mjs
```

The upstream MCP resource and client focused tests pass 77/77. A full TypeScript build of the source checkout could not complete because that checkout lacks dependency links for `@standard-schema/spec`, `zod` and `undici`. The rustdsh fixture tests validate patch preflight, apply, repeat and preservation on invalid input. The patched DSH has not been built or adopted into a profile, and its runtime UI has not been checked on a live installation.
