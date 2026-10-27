import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export function isPublicAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224 ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return /^[23]/.test(s) && !s.startsWith('2001:db8:');
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
