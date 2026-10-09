// Preloaded only in disposable simulator processes, never in a real CLI profile.
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

export function installNetworkGuard() {
  const observations = { loopback_connections: 0, blocked_connections: 0 };
  const denied = () => {
    observations.blocked_connections++;
    throw Object.assign(new Error("Fault simulator permits loopback TCP only"), {
      code: "simulator_network_denied",
    });
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // Node also passes a normalized [options, callback] array internally.
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host =
      input && typeof input === "object"
        ? input.host
        : typeof input === "number" && typeof args[1] === "string"
          ? args[1]
          : null;
    if (
      (input && typeof input === "object" && input.path) ||
      !["127.0.0.1", "::1"].includes(host)
    )
      return denied();
    observations.loopback_connections++;
    return connect.apply(this, args);
  };
  tls.connect = denied;
  dgram.createSocket = denied;
  syncBuiltinESMExports();
  return observations;
}

if (process.env.RDSH_FAULT_ISOLATED === "1")
  globalThis.rdshFaultNetwork = installNetworkGuard();
