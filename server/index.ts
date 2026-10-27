import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { dataDir, safeError, key } from '../src/config.js';
import { voiceOverPreflight } from '../src/voiceover.js';
import { shopPage } from './shop.js';
import { z } from 'zod';
import { hostRequest } from './host.js';
import { sessionLock } from '../src/lock.js';
export const visibleKinds = new Set([
  'plan',
  'action',
  'capture',
  'observation',
  'at_check',
  'coverage',
  'limit',
]);
export async function startServer(port = 4317, dir = dataDir, frontend = true) {
  const store = new Store(dir);
  let release: () => void;
  try {
    release = sessionLock(dir);
  } catch (e) {
    store.close();
    throw e;
  }
  let origin = `http://127.0.0.1:${port}`;
  const runner = new Runner(store, origin),
    token = randomBytes(24).toString('hex');
  if (frontend && !existsSync('dist/client/index.html')) {
    release();
    store.close();
    throw Error('Build the interface with npm run build before starting the application.');
  }
  const json = (res: ServerResponse, status: number, value: any) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}`)
        return json(res, 403, { error: 'Use the local application address.' });
      const url = new URL(req.url ?? '/', origin);
      if (req.headers.origin && req.headers.origin !== origin)
        return json(res, 403, { error: 'Requests from other websites are refused.' });
      if (req.headers['sec-fetch-site'] === 'cross-site')
        return json(res, 403, { error: 'Open this page directly on this Mac.' });
      if (url.pathname === '/api/host' || url.pathname.startsWith('/api/host/'))
        return await hostRequest(req, res, url, { origin, token, store, runner, json });
      if (url.pathname.startsWith('/shop')) {
        res.writeHead(200, {
          'Content-Type': 'text/html;charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(shopPage(req.url ?? ''));
      }
      if (url.pathname === '/api/session')
        return json(res, 200, {
          token,
          keyPresent: !!key(),
          liveEnabled: false,
          voiceOver: voiceOverPreflight(),
          spending: 'No paid testing authorised. Offline mode is available.',
        });
      if (req.method === 'POST') {
        if (req.headers['x-session-token'] !== token)
          return json(res, 403, { error: 'Start this action from the local application.' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 4096) return json(res, 413, { error: 'Request is too large.' });
        }
        if (url.pathname === '/api/runs') {
          const options = z
            .object({
              mode: z.literal('offline'),
              voiceOver: z.boolean().optional(),
              headless: z.boolean().optional(),
            })
            .parse(JSON.parse(raw));
          const run = await runner.start(options);
          return json(res, 201, run);
        }
        const stopped = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/stop$/);
        if (stopped) {
          await runner.stop(stopped[1]);
          return json(res, 200, { stopped: true });
        }
        return json(res, 404, { error: 'Action not found.' });
      }
      if (url.pathname === '/api/runs') return json(res, 200, store.runs());
      const match = url.pathname.match(
        /^\/api\/runs\/([a-f0-9-]+)(?:\/(events|assets)(?:\/([a-zA-Z0-9_.-]+))?)?$/,
      );
      if (match) {
        const [, id, part, name] = match;
        if (part === 'assets') {
          const image = store.image(id, name ?? '');
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          return res.end(image);
        }
        if (part === 'events') {
          store.run(id);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          let seq = Number(req.headers['last-event-id'] ?? 0);
          if (!Number.isSafeInteger(seq)) seq = 0;
          const emit = () => {
            if (!store.hasRun(id)) {
              res.end();
              return;
            }
            for (const record of store.records(id, seq)) {
              res.write(
                `id: ${record.seq}\ndata: ${JSON.stringify({ seq: record.seq, kind: record.kind })}\n\n`,
              );
              seq = record.seq;
            }
            res.write(': keepalive\n\n');
          };
          emit();
          const timer = setInterval(emit, 1000);
          req.on('close', () => clearInterval(timer));
          return;
        }
        const records = store.records(id).filter((r) => visibleKinds.has(r.kind));
        return json(res, 200, {
          run: store.run(id),
          records,
          findings: store.published(id),
          limits: store.publicationLimits(id),
          usage: store.usage(id),
          score: null,
        });
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Resource not found.' });
      const asset = resolve('dist/client', '.' + url.pathname);
      const publicRoot = resolve('dist/client');
      if (asset.startsWith(publicRoot + '/') && existsSync(asset) && url.pathname !== '/') {
        const extension = asset.split('.').at(-1);
        res.writeHead(200, {
          'Content-Type':
            extension === 'js'
              ? 'application/javascript'
              : extension === 'css'
                ? 'text/css'
                : 'application/octet-stream',
        });
        return res.end(readFileSync(asset));
      }
      if (frontend) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(readFileSync(join(publicRoot, 'index.html')));
      }
      json(res, 404, { error: 'Page not found.' });
    } catch (e) {
      json(res, 400, { error: safeError(e) });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('The local server did not obtain a port.');
    port = address.port;
    origin = `http://127.0.0.1:${port}`;
    runner.origin = origin;
    store.recoverInterrupted();
  } catch (e) {
    release();
    store.close();
    throw e;
  }
  return {
    server,
    store,
    runner,
    origin,
    token,
    close: async () => {
      if (runner.active) await runner.stop(runner.active.run.id);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      store.close();
      release();
    },
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const app = await startServer(Number(process.env.PORT ?? 4317));
  console.log(`Access Walk is available at ${app.origin}. Paid calls are disabled.`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit());
    });
}
