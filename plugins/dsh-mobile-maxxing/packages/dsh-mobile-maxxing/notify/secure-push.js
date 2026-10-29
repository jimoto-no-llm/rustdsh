/** HTTPS push transport that validates the actual DNS result before connecting. */
import { lookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["2001::", 23], ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
]) blocked.addSubnet(network, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** Fail closed on local, private, multicast, mapped and reserved addresses. */
export function isPublicPushAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  return false;
}

/** Check every result and return the same checked addresses to the socket. */
export function createSafeLookup(resolve = lookup) {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !isPublicPushAddress(address))) {
        return callback(new Error("push endpoint resolved to a non-public address"));
      }
      const family = typeof options === "number" ? options : options?.family;
      const matching = family === 4 || family === 6 ? addresses.filter((item) => item.family === family) : addresses;
      if (matching.length === 0) return callback(new Error("push endpoint has no address for the requested family"));
      if (typeof options === "object" && options?.all) return callback(null, matching);
      callback(null, matching[0].address, matching[0].family);
    });
  };
}

/** Native HTTPS neither follows redirects nor resolves the hostname twice. */
export function createSecurePushTransport(resolve = lookup, requestHttps = request) {
  const safeLookup = createSafeLookup(resolve);
  return (endpoint, options) => {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("push endpoint must be public https");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicPushAddress(host)) throw new Error("push endpoint must use a public address");
    return new Promise((resolveRequest, reject) => {
      const req = requestHttps(url, { method: options.method, headers: options.headers, signal: options.signal, lookup: safeLookup, agent: false }, (res) => {
        res.resume();
        resolveRequest({ status: res.statusCode });
      });
      req.once("error", reject);
      req.end(options.body);
    });
  };
}

export const securePushRequest = createSecurePushTransport();
