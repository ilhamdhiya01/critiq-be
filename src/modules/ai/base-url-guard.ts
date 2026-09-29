import { lookup as dnsLookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { AiError } from './ai-error';

// An openai_compatible base URL is typed in by a tenant's Admin and then
// fetched by Critiq's own servers — and the test endpoint echoes part of the
// reply back. Left open, that is SSRF into Critiq's network (internal
// services, the cloud metadata endpoint). So besides the spec's "https
// unless allowlisted", every address the host resolves to must be public,
// unless the host is on AI_COMPAT_HTTP_ALLOWLIST — which is how a
// self-hosted vLLM on an internal name gets through, deliberately.
//
// Residual risk, accepted for now: DNS rebinding between this check and the
// SDK's own connection. Closing it means pinning the resolved IP in a custom
// agent.

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is an IPv4 address in disguise.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) {
    return BLOCKED.check(mapped[1], 'ipv4');
  }
  const family = isIP(address);
  if (family === 4) {
    return BLOCKED.check(address, 'ipv4');
  }
  if (family === 6) {
    return BLOCKED.check(address, 'ipv6');
  }
  return true; // not an IP at all — refuse rather than guess
}

type Lookup = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: Lookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function reject(reason: string): never {
  throw new AiError('insecure_base_url', { providerMessage: reason });
}

export async function assertSafeBaseUrl(
  raw: string,
  allowlist: readonly string[],
  lookup: Lookup = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('Base URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return reject('Base URL must use https.');
  }
  // Credentials in the URL would be logged and echoed wherever the URL is.
  if (url.username || url.password) {
    return reject('Base URL must not contain credentials.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowlisted = allowlist.includes(host);
  if (allowlisted) {
    return url;
  }
  if (url.protocol === 'http:') {
    return reject('Base URL must use https unless its host is allowlisted.');
  }

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host)).map((entry) => entry.address);
    } catch {
      return reject('Base URL host could not be resolved.');
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return reject(
      'Base URL resolves to a private or internal address; allowlist the host to use it.',
    );
  }
  return url;
}
