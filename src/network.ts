import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
const specialV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  specialV6.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224 ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return /^[23]/.test(s) && !specialV6.check(s, 'ipv6');
  }
  return false;
}
export async function permittedUrl(raw: string, controlledOrigin: string, approvedOrigin?: string) {
  const url = new URL(raw);
  if (url.username || url.password) throw Error('Credentials in URLs are not allowed.');
  if (url.origin === controlledOrigin) return url;
  if (!['http:', 'https:'].includes(url.protocol))
    throw Error('Only approved web pages can be opened.');
  if (approvedOrigin && url.origin !== approvedOrigin)
    throw Error('This navigation leaves the approved site.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address)))
    throw Error('Private or local network destinations are blocked.');
  return url;
}
