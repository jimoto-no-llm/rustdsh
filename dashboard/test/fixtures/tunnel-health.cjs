// Local child-process fixture. It never contacts a control plane or a model.
const http = require("node:http");
const fs = require("node:fs");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
if (
  argument("--control-plane.api-key") !== "env:CONTROL_PLANE_API_KEY" ||
  argument("--mcp.extra-headers") !==
    "Authorization: env:RDSH_DASHBOARD_AUTHORIZATION" ||
  argument("--mcp.discovery-extra-headers") !==
    "Authorization: env:RDSH_DASHBOARD_AUTHORIZATION" ||
  argument("--health.listen-addr") !== "127.0.0.1:0"
)
  process.exit(2);
const server = http.createServer((_req, res) => {
  res.end("ok");
});
server.listen(0, "127.0.0.1", async () => {
  fs.writeFileSync(
    argument("--health.url-file"),
    `http://127.0.0.1:${server.address().port}/`,
  );
  const response = await fetch(argument("--mcp.server-url"), {
    headers: { authorization: process.env.RDSH_DASHBOARD_AUTHORIZATION },
  });
  // A bearer-authenticated GET is rejected by the MCP protocol with 400, not by auth with 401.
  if (response.status !== 400) process.exit(3);
  await response.body?.cancel();
  console.log("FIXTURE_READY");
  setTimeout(() => server.close(() => process.exit(0)), 3500);
});
