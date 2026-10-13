function safeReason(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000) || "unknown_error";
}

export function registerDashboardShutdown(close, processRef = process) {
  let completion = null;
  const handle = (signal) => {
    if (completion) return completion;
    completion = Promise.resolve()
      .then(close)
      .then(
        () => {
          processRef.stdout.write("", () => processRef.exit(0));
        },
        (error) => {
          processRef.exitCode = 1;
          processRef.stderr.write(
            `[rdsh-dashboard] ${signal} shutdown failed: ${safeReason(error)}\n`,
            () => processRef.exit(1),
          );
        },
      )
      .catch(() => {
        processRef.exitCode = 1;
        processRef.exit(1);
      });
    return completion;
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    processRef.once(signal, () => {
      void handle(signal);
    });
  return { wait: () => completion || Promise.resolve() };
}
