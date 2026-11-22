export const operations = Object.freeze([
  "start",
  "resume",
  "send",
  "interrupt",
  "stop",
  "usage",
]);
export const versions = ["0.2.0-rc.2", "0.2.2-rc.5"];

export function adapterCatalog() {
  return ["dsh", "codex", "claude", "kimi"].map((id) => ({
    id,
    protocol: id === "dsh" ? "acp-stdio-v1" : null,
    verified_versions: id === "dsh" ? [...versions] : [],
    verification:
      id === "dsh"
        ? "versioned wire fixtures and isolated DSH ACP lifecycle smoke"
        : "no implementation or verified CLI version",
    operations: Object.fromEntries(
      operations.map((name) => [
        name,
        {
          status:
            id === "dsh"
              ? "requires_version_and_protocol_check"
              : "unsupported",
          method:
            id !== "dsh"
              ? null
              : {
                  start: "session/new",
                  resume: "session/resume",
                  send: "session/prompt",
                  interrupt: "session/cancel",
                  stop: "cancel input, session/close and EOF, scoped kernel termination, descendant verification",
                  usage: "session/update:usage_update",
                }[name],
        },
      ]),
    ),
  }));
}
