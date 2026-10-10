# Remote MCP OAuth fixture evidence

The optional bundle is reviewed against the actual installed DSH
`0.2.0-rc.2` / native MCP client `0.2.0-rc.2` and MCP SDK `2.0.0`.
The previously referenced DSH README revision was unavailable; no missing source
was claimed as inspected. Installed compiled public code and declarations were
the implementation authority. No installed package or active profile was changed.
Configured web/headless profile entries were inspected using plugin names only;
no profile or credential values were emitted. A running profile was not selected
or booted during this audit. The installed MCP transport factory accepts only
configured HTTP headers, while its SDK already provides OAuth primitives.

`plugins/rdsh-mcp-oauth/test/probe.mjs` runs the original compiled MCP bridge
without headers, then a separately patched copy through the actual bundle after
fixture consent. [Observed JSON](before-after.json) is the executable output;
secrets and ephemeral URLs are omitted. It reports:

```diff
- connected: false; publicTools: []; status: unauthorized
+ connected: true; publicTools: [mcp__work__echo]
+ callText: fixture call succeeded; credentialsConfigured: true
+ logout: configured: false
```

The same native tool naming/call path is used. There were zero model calls.
This is protocol/credential QA with local fixtures, not external-provider
authorization or Production adoption. Source fingerprints identify the exact
native package and seam in the observed JSON. UI behavior is unchanged.

On 2026-10-09, the final bundle passed twelve tests on Windows Node 24.18.0
and Linux/WSL Node 24.21.0, with zero failures or skips. This includes a delayed
old-token 401 arriving after another request rotated the token; it cannot refresh
the new token again. Complete logs are retained in the local task evidence folder.
Existing Rust/CLI inputs at main `41ab8c2536f68118a9f9053ef736ac883ec45679`
passed fmt, release Clippy with zero warnings, 103 release tests, seven example
tests, two fence checks, 53 CLI regression checks and 27 plugin/security checks.
Those inputs were unchanged by this optional bundle. No dashboard files changed.
