import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeNetworkAddressError extends Error {
  constructor(message = "远程地址解析到了本机、局域网或保留网络。") {
    super(message);
    this.name = "UnsafeNetworkAddressError";
    this.code = "REMOTE_ADDRESS_NOT_ALLOWED";
  }
}

function ipv4Octets(address) {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

export function isPrivateOrReservedAddress(address) {
  const normalized = String(address ?? "")
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .toLocaleLowerCase("en");
  const octets = ipv4Octets(normalized);
  if (octets) {
    const [first, second, third] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }

  if (isIP(normalized) !== 6) return false;
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^(?:fe[89ab])/u.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:")
  );
}

export async function assertPublicHostname(
  hostname,
  { lookupImpl = lookup } = {},
) {
  if (lookupImpl === null) return;
  const normalized = String(hostname ?? "")
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .toLocaleLowerCase("en");
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost")
  ) {
    throw new UnsafeNetworkAddressError();
  }
  if (isIP(normalized)) {
    if (isPrivateOrReservedAddress(normalized)) {
      throw new UnsafeNetworkAddressError();
    }
    return;
  }

  let records;
  try {
    records = await lookupImpl(normalized, { all: true, verbatim: true });
  } catch {
    const error = new Error("无法解析远程地址。");
    error.code = "REMOTE_ADDRESS_UNRESOLVED";
    throw error;
  }
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.some((record) => isPrivateOrReservedAddress(record.address))
  ) {
    throw new UnsafeNetworkAddressError();
  }
}

export function createPublicNetworkFetch(
  fetchImpl,
  { lookupImpl = lookup } = {},
) {
  if (lookupImpl === null) return fetchImpl;
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    await assertPublicHostname(url.hostname, { lookupImpl });
    return fetchImpl(input, init);
  };
}
