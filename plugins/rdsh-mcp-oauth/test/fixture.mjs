import { createServer } from "node:http";
import { createHash } from "node:crypto";

// Local RFC metadata/token and JSON-RPC fixture, with rotating refresh tokens.
// All values are synthetic; no real provider, credential or model is reached.
export async function oauthFixture() {
  const state = {
    requests: [],
    tokens: 0,
    refreshes: 0,
    codes: new Map(),
    grants: new Map(),
    requiredScope: "read",
    wrongIssuer: false,
    wrongResource: false,
    redirectToken: false,
    invalidRefresh: false,
    tokenExtraScope: false,
    omitScope: false,
    rejectedToken: null,
  };
  let base;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    state.requests.push({
      path: req.url,
      method: req.method,
      headers: req.headers,
      body,
    });
    const respond = (status, data, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, base);
    if (
      url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return respond(200, {
        resource: state.wrongResource ? base + "/other" : base + "/mcp",
        authorization_servers: [base + "/issuer"],
        scopes_supported: ["read"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/issuer") {
      return respond(200, {
        issuer: state.wrongIssuer ? base + "/alien" : base + "/issuer",
        authorization_endpoint: base + "/authorize",
        token_endpoint: base + "/token",
        registration_endpoint: base + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/register") {
      const data = JSON.parse(body);
      return respond(201, {
        ...data,
        client_id: "rustdsh-fixture",
        client_id_issued_at: 0,
      });
    }
    if (url.pathname === "/token") {
      if (state.redirectToken) {
        res.writeHead(307, { location: base + "/leak" });
        return res.end();
      }
      const p = new URLSearchParams(body);
      if (p.get("resource") !== base + "/mcp")
        return respond(400, {
          error: "invalid_grant",
          error_description: "SECRET_REMOTE_ECHO",
        });
      let approved;
      if (p.get("grant_type") === "authorization_code") {
        state.tokens++;
        const record = state.codes.get(p.get("code"));
        if (
          !record ||
          record.challenge !==
            createHash("sha256")
              .update(p.get("code_verifier") ?? "")
              .digest("base64url") ||
          record.redirect !== p.get("redirect_uri")
        )
          return respond(400, { error: "invalid_grant" });
        approved = record.scope;
        state.codes.delete(p.get("code"));
      } else {
        state.refreshes++;
        approved = state.grants.get(p.get("refresh_token"));
        state.grants.delete(p.get("refresh_token"));
        if (state.invalidRefresh || approved === undefined)
          return respond(400, {
            error: "invalid_grant",
            error_description: "SECRET_REMOTE_ECHO",
          });
      }
      const serial = state.tokens + state.refreshes;
      const refresh = `FAKE_REFRESH_${serial}`;
      state.grants.set(refresh, approved);
      return respond(200, {
        access_token: `FAKE_ACCESS_${serial}`,
        token_type: "Bearer",
        refresh_token: refresh,
        expires_in: 60,
        ...(state.omitScope
          ? {}
          : { scope: state.tokenExtraScope ? approved + " admin" : approved }),
      });
    }
    if (url.pathname === "/mcp") {
      if (
        !req.headers.authorization ||
        req.headers.authorization === "Bearer rejected" ||
        req.headers.authorization === `Bearer ${state.rejectedToken}`
      )
        return respond(
          401,
          { error: "FAKE_ACCESS_SECRET_ECHO" },
          {
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${state.requiredScope}"`,
          },
        );
      if (state.requiredScope.includes("write"))
        return respond(
          403,
          {
            error: "insufficient_scope",
            error_description: req.headers.authorization,
          },
          {
            "www-authenticate":
              'Bearer error="insufficient_scope", scope="read write"',
          },
        );
      if (req.method === "GET") return respond(405, {});
      if (req.method === "DELETE") return respond(200, {});
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      let result;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "echo",
                description: "fixture echo",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
          };
          break;
        case "tools/call":
          result = {
            content: [{ type: "text", text: message.params.arguments.value }],
            structuredContent: { value: message.params.arguments.value },
          };
          break;
        default:
          result = {};
      }
      return respond(200, { jsonrpc: "2.0", id: message.id, result });
    }
    return respond(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    base,
    config: (serverName = "work") => ({
      serverName,
      url: base + "/mcp",
      issuer: base + "/issuer",
      callbackUrl: "http://127.0.0.1:37771/oauth/callback",
      clientId: "rustdsh-fixture",
      scopes: ["read"],
    }),
    callback(
      authorizationUrl,
      code = `FAKE_CODE_${state.codes.size}_${state.tokens}`,
    ) {
      const auth = new URL(authorizationUrl),
        url = new URL(auth.searchParams.get("redirect_uri"));
      state.codes.set(code, {
        challenge: auth.searchParams.get("code_challenge"),
        redirect: url.href,
        scope: auth.searchParams.get("scope"),
      });
      url.searchParams.set("code", code);
      url.searchParams.set("state", auth.searchParams.get("state"));
      url.searchParams.set("iss", base + "/issuer");
      return url.href;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
