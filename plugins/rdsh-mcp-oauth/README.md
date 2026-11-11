# Remote MCP OAuth for DSH

Optional Cordis bundle for Issue [#77](https://github.com/jimoto-no-llm/rustdsh/issues/77).
Requires Node 24, DSH MCP/credentials `0.2.0-rc.2`, MCP SDK `2.4.0`
(or previously audited external `2.2.0` / `2.3.1`) and an explicitly installed HTTP option seam. The Rust launcher, agent loop, profile
boot, native MCP supervisor, tool policy and resource handling remain native.
This bundle is an opt-in candidate; it is not enabled by an installer or profile.

The SDK must resolve to `2.4.0` from the native `@deepseek-ai/dsh-mcp-client`
dependency graph. This bundle's targeted npm override removes that package's
otherwise nested `2.0.0` dependency. Cordis and the native credentials services
continue to come from the same DSH installation. Previously audited external
`2.2.0` / `2.3.1` installations remain accepted; only exact `2.2.0`, `2.3.1` and `2.4.0` are allowed,
not a semver range. No installed DSH package or profile is updated automatically.

SDK `2.4.0` retains the native Client/HTTP transport and the discovery, PKCE,
registration, exchange and refresh APIs used here ([public API](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v2.4.0/packages/client/src/index.ts)).
Its [redirect hardening](https://github.com/modelcontextprotocol/typescript-sdk/commit/433eb413dc305ebeb93b8ebcde0095a8fc0d5fa0)
does not relax this bundle's stricter policy: both fetch seams still force
`redirect: "error"`, including same-origin 307/308. Never set `redirectPolicy:
'follow'` to make a failing endpoint work. Native seam hashes remain unchanged;
real SDK/native tests and redirect negatives qualify the dependency graph, not
an installed profile or real authorization server.

## Configure your own client

Register a **rustdsh / DSH MCP** client with the authorization server you trust.
Do not reuse another product's client ID, client metadata document or name.
Alternatively, set `dynamicRegistration: true` instead of `clientId`; the explicit
login command registers that DSH client when the server supports registration.
Client metadata documents are not automatically borrowed or hosted by this bundle.

Save a public `server.json`, outside the credential store:

```json
{
  "serverName": "work",
  "url": "https://mcp.example.org/mcp",
  "issuer": "https://auth.example.org/issuer",
  "callbackUrl": "http://127.0.0.1:37771/oauth/callback",
  "clientId": "YOUR_REGISTERED_DSH_CLIENT_ID",
  "scopes": ["read"]
}
```

`issuer` is an explicit trust decision, checked against protected resource and
authorization metadata. The resource audience must match the registered MCP URL.
HTTPS is required except literal loopback HTTP; redirects are refused. Callback
URLs must be literal loopback HTTP without query parameters. If the server needs
a client secret, configure `clientSecretRef: "MCP_CLIENT_SECRET"`, a DSH credential
reference, and provision its value through the existing credentials service.
Inline headers, bearer tokens and client secrets are rejected.

## Explicit installation and login

Use the package file of the **same DSH installation** that will load the bundle:

When using `RDSH_DSH_PACKAGE`, first apply the following override in the owning
installation project's root `package.json`, regenerate and review its lockfile
so the native client resolves to `2.4.0`, then run
`npm ci --ignore-scripts --no-audit --no-fund` in that project. npm can retain an
old nested resolution when updating an existing lockfile: verify with
`npm ls @modelcontextprotocol/client @modelcontextprotocol/core --all` that no
`2.0.0` or `2.1.0` SDK remains. npm only applies
overrides from the installation root; this bundle's override cannot update a
separate DSH installation. The loader rejects old or unaudited SDK versions
instead of mixing the bundle's SDK with that installation's services.

```json
{
  "overrides": {
    "@deepseek-ai/dsh-mcp-client@0.2.0-rc.2": {
      "@modelcontextprotocol/client": "2.4.0"
    }
  }
}
```

Merge this entry into any existing `overrides`; retain the DSH MCP/credentials
versions above. A `2.4.0` direct dependency alone does not replace the native
client's exact `2.0.0` dependency. The source hashes below remain the audited
DSH MCP source; the SDK update does not change that source or install the seam.

```sh
export RDSH_DSH_PACKAGE=/absolute/path/to/@deepseek-ai/dsh/package.json
node plugins/rdsh-mcp-oauth/cli.mjs verify-seam --dsh-package "$RDSH_DSH_PACKAGE"
node plugins/rdsh-mcp-oauth/cli.mjs install-seam --dsh-package "$RDSH_DSH_PACKAGE"
node plugins/rdsh-mcp-oauth/cli.mjs diagnose --dsh-package "$RDSH_DSH_PACKAGE" --dsh-home "$DSH_HOME" --config server.json
node plugins/rdsh-mcp-oauth/cli.mjs login --dsh-package "$RDSH_DSH_PACKAGE" --dsh-home "$DSH_HOME" --config server.json
```

`verify-seam` initially refuses an unpatched installation. `install-seam` is an
explicit local package change, intended after review; it refuses any unaudited
source. Tests patch only isolated copies, never the installed DSH. Six guarded
replacements add an optional third HTTP transport argument to native `apply`.
Existing two-argument calls and stdio keep their behavior. The original SHA256 is
`758d8fc473b700b5d351158d06ce9f9e92c16e8b25497b08bb7bd2122a87f5dd`;
the patched SHA256 is
`2f34c35c7a96e83fbf8a6446eff374f165c81e0c70375f188064783d0b67300f`.
Only this compiled public package was audited; its TypeScript source map was not
shipped. Future package updates fail closed until a new seam is reviewed.
`revert-seam` restores exactly that original source and refuses unrelated updates.
`revert-seam` だけは SDK や資格情報サービスを読み込まず、指定した DSH の
監査済みファイルを復元します。旧 SDK `2.0.0` が残っている場合や SDK を
削除した場合も、依存の再インストールなしで復元できます。インストール、
検証、OAuth 操作には SDK `2.4.0`（既存の外部環境では `2.2.0` も可）と同じ DSH のサービスが必要です。
明示するパスは JSON object を記述した `package.json` に限ります。DSH を
所有するプロジェクトの manifest も使え、特定の package 名は要求しません。

Open the returned authorization URL on a browser where you want to consent.
After consent, copy the entire callback URL from the browser's address bar. The
CLI does not run a callback HTTP listener: a loopback connection failure is
expected, including on another machine or during SSH. On the DSH host, run:

```sh
node plugins/rdsh-mcp-oauth/cli.mjs finish --dsh-package "$RDSH_DSH_PACKAGE" --dsh-home "$DSH_HOME" --config server.json
```

Paste the callback URL into **stdin**, then end input with Ctrl-D (Unix) or
Ctrl-Z followed by Enter (Windows). Keep the authorization/callback URLs private;
do not place them in shell arguments, history, logs, issues or profile exports.
State, callback origin/path, issuer and PKCE are checked before redeeming the code.
Pending login expires in ten minutes; replay after success is rejected.

## Connect and manage accounts

Install/load this local bundle through DSH's existing plugin loader, resolving its
native peers from `RDSH_DSH_PACKAGE`. Add a `rdsh-mcp-oauth` instance using the same
public configuration as `server.json`, **instead of** the native `mcp-client`
instance for that server name. Credentials and tools services must be enabled.
Native `toolCallTimeoutMs`, `maxInstructionBytes`, `failOnStartupError` and
`reconnect` configuration are accepted. The native public name remains
`mcp__work__<tool>`, with the same supervisor, policy and cancellation path.

`inspect` and `export` report only server binding, issuer, status, expiry, granted
scopes and reference names. Grants live in DSH's existing `.credentials.yaml`,
under `rdsh-mcp-oauth/mcp-<SHA256(serverName+canonicalURL)>`. Another alias at the
same URL gets a separate record; a changed URL cannot reuse the previous grant.
Changes to client/issuer/callback/config reject a stale record rather than overwrite
it. Use the previous configuration to log out before changing that binding.

Tokens refresh before expiry or once after a 401. The native cross-process writer
lock spans read, refresh and replacement, preventing concurrent refresh rotation.
`invalid_grant` invalidates only this grant. Additional scopes stop the operation
with `consent_required`; check `diagnose`, then deliberately run `login --scope
"read write"` and `finish` to consent again. No silent scope widening or automatic
`offline_access` request is added. The existing grant survives a failed new login.

`logout` removes only the selected local record. It does **not** claim to revoke
server-side access; use the authorization server's account controls for revocation.
SDK HTTP errors and scoped native diagnostics omit/redact credential values.

## Verification

```sh
cd plugins/rdsh-mcp-oauth
npm ci --ignore-scripts --no-audit --no-fund
npm test
node test/probe.mjs
```

The tests use the real SDK, Cordis, native file-backed credentials and
native MCP bridge with local synthetic OAuth/MCP servers. They cover metadata,
redirect/state/PKCE/issuer rejection, cross-provider rotating refresh, account
isolation, explicit step-up, own client registration, secret references, stdin
completion, safe export and guarded seam recovery. No provider, model or paid API
is called. [Actual before/after evidence](../../docs/evidence/mcp-oauth/README.md).
Runtime checks also verify one patched SDK/core graph, shared Cordis services,
and rejection of old external SDKs. The probe reports the versions actually
resolved by the loader.

Protocol reference: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
