import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Local rollback needs only the native file, not an executable SDK or services.
// Reject invalid package paths before Node can fall back to a nearby graph.
export async function resolveMcpPath(packagePath) {
  if (packagePath) {
    if (
      basename(packagePath) !== "package.json" ||
      !(await stat(packagePath)).isFile()
    )
      throw new Error("MCP OAuth: DSH package path must be a package.json file");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      Array.isArray(manifest)
    )
      throw new Error("MCP OAuth: DSH package manifest must be an object");
  }
  const require = createRequire(
    packagePath ? pathToFileURL(packagePath) : import.meta.url,
  );
  return require.resolve("@deepseek-ai/dsh-mcp-client");
}

// Resolve all services from one DSH dependency graph; never mix a global DSH
// Context with another copy of Cordis or the obsolete MCP SDK package.
export async function loadRuntime(packagePath) {
  const mcpPath = await resolveMcpPath(packagePath);
  const require = createRequire(
    packagePath ? pathToFileURL(packagePath) : import.meta.url,
  );
  const load = async (name) =>
    import(pathToFileURL(require.resolve(name)).href);
  const pkg = JSON.parse(
    await readFile(join(dirname(mcpPath), "../package.json"), "utf8"),
  );
  if (pkg.version !== "0.2.0-rc.2")
    throw new Error("MCP OAuth: unsupported DSH MCP version");
  const mcpRequire = createRequire(mcpPath);
  const sdkPath = mcpRequire.resolve("@modelcontextprotocol/client");
  const sdkPkg = JSON.parse(
    await readFile(join(dirname(sdkPath), "../package.json"), "utf8"),
  );
  if (!["2.2.0", "2.3.1", "2.4.0"].includes(sdkPkg.version))
    throw new Error("MCP OAuth: unsupported MCP SDK version");
  // Cordis/schemastery share an ESM dependency with a CJS entry; concurrent
  // first imports can cause ERR_REQUIRE_ESM_RACE_CONDITION on Node 24.
  const cordis = await import(
    pathToFileURL(mcpRequire.resolve("@deepseek-ai/cordis")).href
  );
  const schema = await import(
    pathToFileURL(
      join(
        dirname(mcpRequire.resolve("@deepseek-ai/schemastery")),
        "index.mjs",
      ),
    ).href
  );
  const credentials = await load("@deepseek-ai/dsh-credentials");
  const local = await load("@deepseek-ai/dsh-credentials-local");
  const sdk = await import(pathToFileURL(sdkPath).href);
  return {
    sdk,
    sdkVersion: sdkPkg.version,
    nativeVersion: pkg.version,
    credentials,
    local,
    cordis,
    schema,
    mcpPath,
    loadMcp: () => import(pathToFileURL(mcpPath).href),
  };
}
