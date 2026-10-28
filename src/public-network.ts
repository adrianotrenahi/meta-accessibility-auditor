import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPublicAddress } from './network.js';

type Address = { address: string; family: number };
export type PublicLookup = (hostname: string) => Promise<Address[]>;
const dns: PublicLookup = (hostname) => lookup(hostname, { all: true });

/** Resolve once, reject mixed/private answers, and dial only this verified address. */
export async function publicDestination(raw: string, resolve: PublicLookup = dns) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Enter a public HTTP or HTTPS website without credentials in its address.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
          resolve(hostname),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('The website address could not be resolved in time.')),
              4000,
            );
          }),
        ]);
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
      throw Error(
        'Private, local and reserved network destinations are unavailable to public website runs.',
      );
    return {
      url,
      address: addresses[0],
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function pinnedLookup(address: Address) {
  return (_host: string, options: any, callback: any) => {
    if (typeof options === 'function') callback = options;
    callback(null, options?.all ? [address] : address.address, address.family);
  };
}
const forwardHeaders = (headers: IncomingMessage['headers']) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !['proxy-authorization', 'proxy-connection', 'connection', 'upgrade'].includes(name),
    ),
  );

/** Public preflight follows real HTTP redirects without reading page contents or starting models. */
export async function probePublicWebsite(raw: string) {
  let current = raw;
  for (let count = 0; count < 6; count++) {
    const target = await publicDestination(current);
    const result = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
        target.url,
        {
          method: 'HEAD',
          lookup: pinnedLookup(target.address),
          headers: { 'user-agent': 'AccessWalk/0.1 (website reachability check)' },
        },
        (response) => {
          resolve({ status: response.statusCode ?? 0, location: response.headers.location });
          response.destroy();
        },
      );
      request.setTimeout(5000, () =>
        request.destroy(Error('The website did not respond to the reachability check.')),
      );
      request.on('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
      current = new URL(result.location, target.url).href;
      continue;
    }
    return {
      url: new URL(raw).href,
      finalUrl: target.url.href,
      reachable: result.status >= 100,
      status: result.status,
    };
  }
  throw Error('The website redirected too many times during the reachability check.');
}

/** The browser cannot re-resolve a checked hostname to a private address after our check. */
export async function publicBrowserProxy(resolve: PublicLookup = dns) {
  const sockets = new Set<Socket>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const refuse = (response: ServerResponse) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(502);
    response.end('The public website connection was refused.');
  };
  const server = createServer(async (incoming, response) => {
    try {
      const target = await publicDestination(incoming.url ?? '', resolve);
      if (closed || response.destroyed) return;
      const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
        target.url,
        {
          method: incoming.method,
          headers: forwardHeaders(incoming.headers),
          lookup: pinnedLookup(target.address),
        },
        (upstream) => {
          if (response.destroyed) {
            upstream.destroy();
            return;
          }
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      request.on('socket', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      request.setTimeout(30000, () => request.destroy());
      request.on('error', () => {
        if (!response.headersSent) refuse(response);
        else response.destroy();
      });
      incoming.on('aborted', () => request.destroy());
      response.on('close', () => request.destroy());
      incoming.pipe(request);
    } catch {
      refuse(response);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (incoming, downstream, head) => {
    downstream.on('error', () => downstream.destroy());
    void (async () => {
      const target = await publicDestination('https://' + incoming.url, resolve);
      if (target.url.pathname !== '/' || target.url.search || target.url.hash)
        throw Error('Invalid tunnel destination.');
      if (closed || downstream.destroyed) return;
      const upstream = connect({ host: target.address.address, port: target.port });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
      downstream.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        if (downstream.destroyed) {
          upstream.destroy();
          return;
        }
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
    })().catch(() => {
      downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('The public browser connection could not start.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      if (closing) return closing;
      closed = true;
      for (const socket of sockets) socket.destroy();
      closing = new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      return closing;
    },
  };
}
