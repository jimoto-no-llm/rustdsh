// Qualification only. Original Cordis injection is the plugin-load observation.
export const inject = ["llm"];
export const name = "rdsh-release-probe";
export function apply() {
  const base = new URL(process.env.RDSH_RELEASE_PROBE_BASE);
  const key = process.env.RDSH_RELEASE_PROBE_KEY;
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !/^[a-f0-9]{64}$/.test(key || "")
  )
    throw new Error("Release probe requires a scoped loopback callback");
  void fetch(new URL("ready", base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      "content-type": "application/json",
      "x-rdsh-release-token": key,
    },
    body: JSON.stringify({
      plugin: name,
      contract: 1,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  }).catch(() => {});
}
