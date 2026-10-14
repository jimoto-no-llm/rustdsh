// These fixtures exercise actual native children, not a simulated successful
// protocol. Missing Linux delegation/native packages must fail on a supported OS.
export const hasOwnershipBackend = ["linux", "win32"].includes(
  process.platform,
);
export const requiresOwnershipBackend = {
  skip: hasOwnershipBackend
    ? false
    : `${process.platform} has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job`,
};
// Read-only birth/scope identity has its own platform support, independent of
// whether the caller can acquire a writable kernel group.
export const hasProcessIdentity = ["linux", "win32"].includes(process.platform);
export const requiresProcessIdentity = {
  skip: hasProcessIdentity
    ? false
    : `${process.platform} has no process identity reader; positive Tunnel identity fixtures require Linux or Windows`,
};
