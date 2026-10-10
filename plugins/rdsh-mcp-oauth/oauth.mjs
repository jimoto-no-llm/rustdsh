import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class OAuthFailure extends Error {
  constructor(code) {
    super(`MCP OAuth: ${code}`);
    this.code = code;
  }
}
const fail = (code) => {
  throw new OAuthFailure(code);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const challengeHash = (value) =>
  createHash("sha256").update(value).digest("base64url");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function safeError(error) {
  return error instanceof OAuthFailure
    ? error
    : new OAuthFailure("operation_failed");
}
export function secureURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_url");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    fail("insecure_url");
  return url;
}
export function scopes(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/ +/).filter(Boolean)
      : [];
  if (
    values.length > 64 ||
    values.some(
      (v) =>
        typeof v !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(v),
    )
  )
    fail("invalid_scope");
  return [...new Set(values)].sort();
}
export function configuration(value) {
  const allowed = [
    "serverName",
    "url",
    "issuer",
    "callbackUrl",
    "clientId",
    "dynamicRegistration",
    "clientSecretRef",
    "scopes",
    "toolCallTimeoutMs",
    "failOnStartupError",
    "maxInstructionBytes",
    "reconnect",
  ];
  if (value && Object.keys(value).some((k) => !allowed.includes(k)))
    fail("unknown_config_field");
  if (!value || !/^[A-Za-z0-9_-]{1,32}$/.test(value.serverName))
    fail("invalid_server_name");
  const url = secureURL(value.url).href;
  const issuer = secureURL(value.issuer).href;
  const callback = secureURL(value.callbackUrl);
  if (
    callback.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(callback.hostname) ||
    callback.search
  )
    fail("invalid_callback");
  if (!!value.clientId === !!value.dynamicRegistration)
    fail("select_own_client_registration");
  if (
    value.clientId !== undefined &&
    (typeof value.clientId !== "string" ||
      !value.clientId ||
      value.clientId.length > 2048)
  )
    fail("invalid_client_id");
  if (
    value.clientSecretRef !== undefined &&
    (!value.clientId || !/^[A-Z_][A-Z0-9_]*$/.test(value.clientSecretRef))
  )
    fail("invalid_client_secret_ref");
  if (
    value.headers ||
    value.clientSecret ||
    value.tokens ||
    value.access_token ||
    value.refresh_token
  )
    fail("inline_credentials_forbidden");
  return {
    serverName: value.serverName,
    url,
    issuer,
    callbackUrl: callback.href,
    clientId: value.clientId ?? null,
    dynamicRegistration: value.dynamicRegistration === true,
    clientSecretRef: value.clientSecretRef ?? null,
    scopes: scopes(value.scopes),
  };
}
export function createOAuthManager({
  config: input,
  credentials,
  sdk,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const config = configuration(input);
  const binding = { serverName: config.serverName, url: config.url };
  const key = `rdsh-mcp-oauth/mcp-${hash(JSON.stringify(binding))}`;
  const fingerprint = hash(JSON.stringify(config));
  const secrets = new Set();
  const remember = (p) => {
    for (const value of [
      p?.tokens?.access_token,
      p?.tokens?.refresh_token,
      p?.client?.client_secret,
      p?.pending?.verifier,
      p?.pending?.state,
    ]) {
      if (typeof value === "string" && value) secrets.add(value);
    }
  };
  const owned = (record) => {
    if (record === undefined) return;
    const p = record.payload;
    if (
      record.kind !== "grant" ||
      !p ||
      p.schema !== 1 ||
      p.fingerprint !== fingerprint ||
      p.binding?.serverName !== binding.serverName ||
      p.binding?.url !== binding.url ||
      p.issuer !== config.issuer
    )
      fail("credential_binding_mismatch");
    remember(p);
    return structuredClone(p);
  };
  const base = () => ({
    schema: 1,
    binding,
    fingerprint,
    issuer: config.issuer,
  });
  const wrap = (payload) => ({ kind: "grant", payload });
  async function checkedFetch(url, init = {}) {
    secureURL(url instanceof Request ? url.url : url);
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      if (response.ok) return response;
      // OAuth SDK diagnostics can otherwise include an untrusted error body or
      // error_description containing a token. Keep protocol codes only.
      let code = "server_error";
      try {
        const data = await response.json();
        if (
          [
            "invalid_grant",
            "invalid_client",
            "invalid_scope",
            "access_denied",
            "temporarily_unavailable",
          ].includes(data.error)
        )
          code = data.error;
      } catch {}
      if (code === "invalid_grant") fail(code);
      return Response.json({ error: code }, { status: response.status });
    } catch (error) {
      throw safeError(error);
    }
  }
  async function discover(challenge) {
    const resourceMetadataUrl = challenge?.resourceMetadataUrl;
    if (resourceMetadataUrl) secureURL(resourceMetadataUrl);
    const resource = await sdk.discoverOAuthProtectedResourceMetadata(
      config.url,
      { resourceMetadataUrl },
      checkedFetch,
    );
    if (
      !resource ||
      !Array.isArray(resource.authorization_servers) ||
      !resource.authorization_servers.some(
        (u) => secureURL(u).href === config.issuer,
      )
    )
      fail("untrusted_issuer");
    // The resource audience is explicitly bound to this registered endpoint.
    // Never accept metadata for a different path/account or send a bearer there.
    if (secureURL(resource.resource).href !== config.url)
      fail("resource_mismatch");
    const metadata = await sdk.discoverAuthorizationServerMetadata(
      config.issuer,
      { fetchFn: checkedFetch },
    );
    if (!metadata || secureURL(metadata.issuer).href !== config.issuer)
      fail("issuer_mismatch");
    for (const field of ["authorization_endpoint", "token_endpoint"]) {
      if (!metadata[field]) fail("missing_authorization_metadata");
      secureURL(metadata[field]);
    }
    if (!metadata.code_challenge_methods_supported?.includes("S256"))
      fail("pkce_s256_required");
    if (metadata.registration_endpoint)
      secureURL(metadata.registration_endpoint);
    return { resource, metadata };
  }
  async function clientInfo(payload) {
    const info = { ...payload.client };
    if (config.clientSecretRef) {
      const result = await credentials.resolve(config.clientSecretRef);
      if (!result?.value) fail("client_secret_missing");
      info.client_secret = result.value; // operation-local; never copied to config/export
      secrets.add(result.value);
    }
    return info;
  }
  async function diagnose() {
    try {
      const response = await fetchImpl(config.url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const challenge = sdk.extractWWWAuthenticateParams(response);
      await response.body?.cancel();
      const { resource } = await discover(challenge);
      return {
        ...binding,
        issuer: config.issuer,
        status: "explicit_login_required",
        requiredScopes: scopes(challenge.scope ?? resource.scopes_supported),
        configuredScopes: config.scopes,
      };
    } catch (error) {
      throw safeError(error);
    }
  }
  function savedTokens(tokens, approved) {
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      /[\x00-\x20\x7f]/.test(tokens.access_token) ||
      tokens.token_type?.toLowerCase() !== "bearer"
    )
      fail("invalid_token_response");
    const granted =
      tokens.scope === undefined ? approved : scopes(tokens.scope);
    if (granted.some((scope) => !approved.includes(scope)))
      fail("unconsented_scope");
    if (
      tokens.expires_in !== undefined &&
      (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
    )
      fail("invalid_token_expiry");
    return {
      tokens,
      approvedScopes: approved,
      grantedScopes: granted,
      expiresAt:
        tokens.expires_in === undefined
          ? null
          : now() + tokens.expires_in * 1000,
    };
  }
  async function beginLogin(requested = config.scopes) {
    try {
      const approved = scopes(requested);
      let result;
      await credentials.modifyRecord(key, async (current) => {
        const old = owned(current);
        // Obtain the challenge without credentials, before considering consent.
        const response = await fetchImpl(config.url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        const challenge = sdk.extractWWWAuthenticateParams(response);
        await response.body?.cancel();
        const required = scopes(challenge.scope);
        if (required.some((s) => !approved.includes(s)))
          fail("consent_required");
        const { resource, metadata } = await discover(challenge);
        let client = old?.client;
        if (!client) {
          if (config.clientId) client = { client_id: config.clientId };
          else {
            if (!metadata.registration_endpoint)
              fail("registration_unavailable");
            client = await sdk.registerClient(config.issuer, {
              metadata,
              clientMetadata: {
                client_name: "rustdsh / DSH MCP",
                redirect_uris: [config.callbackUrl],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
                application_type: "native",
              },
              scope: approved.join(" "),
              fetchFn: checkedFetch,
            });
          }
        }
        const state = randomBytes(32).toString("base64url");
        const auth = await sdk.startAuthorization(config.issuer, {
          metadata,
          clientInformation: client,
          redirectUrl: config.callbackUrl,
          scope: approved.join(" "),
          state,
          resource: new URL(resource.resource),
        });
        const url = secureURL(auth.authorizationUrl);
        if (
          url.origin !== secureURL(metadata.authorization_endpoint).origin ||
          url.pathname !== new URL(metadata.authorization_endpoint).pathname ||
          url.searchParams.get("redirect_uri") !== config.callbackUrl ||
          url.searchParams.get("state") !== state ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          url.searchParams.get("code_challenge") !==
            challengeHash(auth.codeVerifier)
        )
          fail("invalid_authorization_request");
        const pending = {
          state,
          verifier: auth.codeVerifier,
          challenge: challengeHash(auth.codeVerifier),
          expiresAt: now() + 10 * 60 * 1000,
          approved,
          metadata,
          resource: resource.resource,
        };
        result = {
          status: "consent_required",
          authorizationUrl: url.href,
          scopes: approved,
          key,
        };
        remember({ client, pending });
        return wrap({ ...(old ?? base()), client, pending });
      });
      return result;
    } catch (error) {
      throw safeError(error);
    }
  }
  async function finishLogin(callbackText) {
    try {
      await credentials.modifyRecord(key, async (current) => {
        const p = owned(current),
          pending = p?.pending;
        if (!pending || pending.expiresAt <= now())
          fail("login_expired_or_absent");
        const url = secureURL(callbackText),
          expected = new URL(config.callbackUrl);
        if (
          url.origin !== expected.origin ||
          url.pathname !== expected.pathname
        )
          fail("callback_mismatch");
        for (const name of ["state", "code", "iss", "error"])
          if (url.searchParams.getAll(name).length > 1)
            fail("duplicate_callback_parameter");
        if (!equal(url.searchParams.get("state"), pending.state))
          fail("state_mismatch");
        if (!equal(challengeHash(pending.verifier), pending.challenge))
          fail("pkce_mismatch");
        if (
          pending.metadata?.issuer !== config.issuer ||
          pending.resource !== config.url
        )
          fail("credential_binding_mismatch");
        if (url.searchParams.has("error")) fail("authorization_denied");
        const code = url.searchParams.get("code");
        if (!code) fail("authorization_code_missing");
        secrets.add(code);
        const tokens = await sdk.exchangeAuthorization(config.issuer, {
          metadata: pending.metadata,
          clientInformation: await clientInfo(p),
          authorizationCode: code,
          iss: url.searchParams.get("iss") ?? undefined,
          codeVerifier: pending.verifier,
          redirectUri: config.callbackUrl,
          resource: new URL(pending.resource),
          fetchFn: checkedFetch,
        });
        const next = {
          ...p,
          ...savedTokens(tokens, pending.approved),
          metadata: pending.metadata,
          resource: pending.resource,
        };
        delete next.pending;
        return wrap(next);
      });
      return inspect();
    } catch (error) {
      throw safeError(error);
    }
  }
  function redactDiagnostic(value) {
    if (typeof value !== "string") return safeError(value).message;
    for (const secret of secrets)
      value = value.replaceAll(secret, "[redacted]");
    return value;
  }
  async function token(forceRejectedToken) {
    try {
      let failure;
      const record = await credentials.modifyRecord(key, async (current) => {
        const p = owned(current);
        if (!p?.tokens) fail("login_required");
        const forced =
          forceRejectedToken !== undefined &&
          forceRejectedToken === p.tokens.access_token;
        if (!forced && (p.expiresAt === null || p.expiresAt > now() + 30000))
          return;
        if (!p.tokens.refresh_token) fail("login_required");
        try {
          // Revalidate the trusted issuer/resource before every credential exchange.
          const { metadata, resource } = await discover();
          if (resource.resource !== p.resource) fail("resource_mismatch");
          const tokens = await sdk.refreshAuthorization(config.issuer, {
            metadata,
            clientInformation: await clientInfo(p),
            refreshToken: p.tokens.refresh_token,
            resource: new URL(p.resource),
            fetchFn: checkedFetch,
          });
          return wrap({
            ...p,
            ...savedTokens(tokens, p.grantedScopes),
            metadata,
          });
        } catch (error) {
          if (error instanceof OAuthFailure && error.code === "invalid_grant") {
            const next = { ...p };
            delete next.tokens;
            delete next.expiresAt;
            delete next.pending;
            failure = new OAuthFailure("login_required");
            return wrap(next); // persist selected invalidation, then report outside lock
          }
          throw error;
        }
      });
      if (failure) throw failure;
      return owned(record).tokens.access_token;
    } catch (error) {
      throw safeError(error);
    }
  }
  async function inspect() {
    try {
      const p = owned(await credentials.readRecord(key));
      return {
        ...binding,
        issuer: config.issuer,
        key,
        configured: !!p?.tokens,
        status: p?.tokens
          ? p.expiresAt !== null && p.expiresAt <= now()
            ? "expired"
            : "authorized"
          : p?.pending
            ? "pending_consent"
            : "login_required",
        expiresAt: p?.expiresAt ?? null,
        scopes: p?.grantedScopes ?? [],
        clientSecretRef: config.clientSecretRef,
      };
    } catch (error) {
      throw safeError(error);
    }
  }
  async function logout() {
    try {
      owned(await credentials.readRecord(key));
      await credentials.deleteRecord(key);
      return { ...binding, key, status: "local_credentials_removed" };
    } catch (error) {
      throw safeError(error);
    }
  }
  function transportOptions() {
    let lastToken;
    const rejectedTokens = new WeakMap();
    return {
      onInsufficientScope: "throw",
      authProvider: {
        async token() {
          return (lastToken = await token());
        },
        async onUnauthorized({ response }) {
          try {
            const challenge = sdk.extractWWWAuthenticateParams(response);
            const p = owned(await credentials.readRecord(key));
            if (
              scopes(challenge.scope).some(
                (s) => !p?.grantedScopes?.includes(s),
              )
            )
              fail("consent_required");
            await discover(challenge);
            await token(rejectedTokens.get(response) ?? lastToken);
          } catch (error) {
            throw safeError(error);
          }
        },
      },
      async fetch(url, init) {
        if (
          secureURL(url instanceof Request ? url.url : url).href !== config.url
        )
          fail("resource_mismatch");
        try {
          const response = await fetchImpl(url, { ...init, redirect: "error" });
          if (response.ok) return response;
          if (response.status === 403) {
            await response.body?.cancel();
            fail("consent_required");
          }
          // Retain only discovery fields; remote error bodies never reach native
          // reconnect/tool diagnostics, and the SDK handles one 401 retry.
          const c = sdk.extractWWWAuthenticateParams(response);
          await response.body?.cancel();
          const parts = [];
          if (c.resourceMetadataUrl)
            parts.push(
              `resource_metadata=${JSON.stringify(secureURL(c.resourceMetadataUrl).href)}`,
            );
          const required = scopes(c.scope);
          if (required.length)
            parts.push(`scope=${JSON.stringify(required.join(" "))}`);
          const filtered = new Response("", {
            status: response.status,
            headers: parts.length
              ? { "www-authenticate": `Bearer ${parts.join(", ")}` }
              : {},
          });
          const authorization = new Headers(
            init?.headers ?? (url instanceof Request ? url.headers : undefined),
          ).get("authorization");
          if (authorization?.startsWith("Bearer "))
            rejectedTokens.set(filtered, authorization.slice(7));
          return filtered;
        } catch (error) {
          throw safeError(error);
        }
      },
    };
  }
  return {
    config,
    key,
    diagnose,
    beginLogin,
    finishLogin,
    inspect,
    logout,
    token,
    transportOptions,
    redactDiagnostic,
  };
}
