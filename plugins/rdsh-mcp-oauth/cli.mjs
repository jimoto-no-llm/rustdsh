#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRuntime } from "./runtime.mjs";
import { createOAuthManager, safeError, OAuthFailure } from "./oauth.mjs";
import { changeSeam, verifySeam } from "./native-seam.mjs";

export async function openCredentials(runtime, dshHome) {
  const ctx = new runtime.cordis.Context();
  const fiber = await ctx.plugin(runtime.local.LocalCredentialProvider, {
    dshHome,
    path: join(dshHome, ".credentials.yaml"),
    watch: false,
  });
  if (!ctx.credentials) throw new OAuthFailure("credentials_unavailable");
  return { credentials: ctx.credentials, close: () => fiber.dispose() };
}
export async function main(
  args,
  {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  let close;
  try {
    const [command, ...rest] = args;
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (
        !rest[i]?.startsWith("--") ||
        !rest[i + 1] ||
        options[rest[i].slice(2)] !== undefined
      )
        throw new OAuthFailure("invalid_arguments");
      options[rest[i].slice(2)] = rest[i + 1];
    }
    if (
      Object.keys(options).some(
        (k) => !["dsh-package", "config", "dsh-home", "scope"].includes(k),
      )
    )
      throw new OAuthFailure("invalid_arguments");
    if (!options["dsh-package"]) throw new OAuthFailure("dsh_package_required");
    const runtime = await loadRuntime(resolve(options["dsh-package"]));
    if (
      command === "install-seam" ||
      command === "revert-seam" ||
      command === "verify-seam"
    ) {
      const result =
        command === "verify-seam"
          ? { sha256: await verifySeam(runtime.mcpPath) }
          : await changeSeam(runtime.mcpPath, command.split("-")[0]);
      stdout.write(JSON.stringify(result) + "\n");
      return 0;
    }
    if (!options.config || !options["dsh-home"])
      throw new OAuthFailure("config_and_dsh_home_required");
    const config = JSON.parse(await readFile(resolve(options.config), "utf8"));
    const provider = await openCredentials(
      runtime,
      resolve(options["dsh-home"]),
    );
    close = provider.close;
    const manager = createOAuthManager({
      config,
      credentials: provider.credentials,
      sdk: runtime.sdk,
    });
    let result;
    if (command === "diagnose") result = await manager.diagnose();
    else if (command === "login")
      result = await manager.beginLogin(options.scope ?? manager.config.scopes);
    else if (command === "finish") {
      // Callback codes and state are read via stdin, never command-line args.
      let callback = "";
      for await (const chunk of stdin) {
        callback += chunk;
        if (Buffer.byteLength(callback) > 16384)
          throw new OAuthFailure("callback_too_large");
      }
      result = await manager.finishLogin(callback.trim());
    } else if (command === "inspect" || command === "export")
      result = await manager.inspect();
    else if (command === "logout") result = await manager.logout();
    else throw new OAuthFailure("unknown_command");
    stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    stderr.write(safeError(error).message + "\n");
    return 1;
  } finally {
    await close?.();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await main(process.argv.slice(2));
