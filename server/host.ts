import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Store } from '../src/store.js';
import type { Runner } from '../src/runner.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { assessmentForRun } from '../src/assessment.js';

export const HOST_GOAL = 'Add the canvas bag to the basket, stopping before any order.';
/** Generic local host surface. It knows no private application components. */
export async function hostRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: {
    origin: string;
    token: string;
    store: Store;
    runner: Runner;
    mode?: 'offline' | 'live';
    json: (res: ServerResponse, status: number, value: unknown) => void;
  },
) {
  const { store, runner, json } = kit;
  const mode = kit.mode ?? 'offline';
  if (req.headers['x-session-token'] !== kit.token) {
    json(res, 403, { error: 'A local host connection is required.' });
    return;
  }
  if (url.pathname === '/api/host' && req.method === 'GET') {
    json(res, 200, {
      protocol: 'access-walk/host-v1',
      mode,
      url: kit.origin + '/shop/?case=broken',
      goal: HOST_GOAL,
      devices: ['desktop_1440_900'],
      capabilities: {
        liveBrowser: true,
        deleteScreens: false,
        discard: true,
        manualCheckpoints: mode === 'offline',
      },
      modelCalls: store.usage().requests.filter((request) => request.role !== 'sam').length,
    });
    return;
  }
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) {
        json(res, 413, { error: 'Request too large.' });
        return;
      }
    }
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === '/api/host/runs') {
      z.object({ mode: z.literal(mode), requestId: z.uuid() })
        .strict()
        .parse(body);
      if (store.hostStartDiscarded(body.requestId)) {
        json(res, 409, {
          error:
            'Discard was requested for this start. Retry discard to finish any remaining cleanup; starting it again is refused.',
        });
        return;
      }
      const prior = store.hostStart(body.requestId);
      if (prior) {
        json(
          res,
          store.hasRun(prior) ? 200 : 409,
          store.hasRun(prior)
            ? { id: prior }
            : { error: 'This run was discarded. A retry cannot recreate it.' },
        );
        return;
      }
      const run = await runner.start({
        mode,
        headless: true,
        engine: 'chromium',
        voiceOver: false,
        goal: HOST_GOAL,
        manualCheckpoints: mode === 'offline',
        requestId: body.requestId,
      });
      json(res, 201, { id: run.id });
      return;
    }
    const discardStart = url.pathname.match(/^\/api\/host\/requests\/([a-f0-9-]{36})\/discard$/i);
    if (discardStart) {
      z.object({}).strict().parse(body);
      const id = store.discardHostStart(discardStart[1]);
      if (id) await runner.discard(id);
      json(res, 200, { discarded: true });
      return;
    }
    const control = url.pathname.match(
      /^\/api\/host\/runs\/([a-f0-9-]{36})\/(advance|discard|stop)$/,
    );
    if (control) {
      const [, id, action] = control;
      if (action === 'advance')
        z.object({ sequence: z.number().int().positive() }).strict().parse(body);
      else z.object({}).strict().parse(body);
      if (action === 'discard') {
        await runner.discard(id);
        json(res, 200, { discarded: true });
        return;
      }
      if (!store.hasRun(id)) {
        json(res, 404, { error: 'Run not found.' });
        return;
      }
      if (action === 'advance') {
        if (!runner.isWaiting(id)) {
          json(res, 409, { error: 'The next controlled checkpoint is not ready.' });
          return;
        }
        if (body.sequence !== exportHostSnapshot(store, id).snapshot.sequence) {
          json(res, 409, {
            error: 'The displayed checkpoint changed. Refresh the saved state before advancing.',
          });
          return;
        }
        runner.advance(id);
      } else if (runner.active?.run.id === id) await runner.stop(id);
      json(res, 200, { accepted: true });
      return;
    }
  }
  const requested = url.pathname.match(/^\/api\/host\/requests\/([a-f0-9-]{36})$/i);
  if (requested && req.method === 'GET') {
    const id = store.hostStart(requested[1]);
    const requestedDiscard = store.hostStartDiscarded(requested[1]);
    const pending = !!(id && requestedDiscard && (store.hasRun(id) || store.discardPending(id)));
    json(res, 200, {
      id,
      discarded: !pending && (requestedDiscard || (id ? !store.hasRun(id) : false)),
      discardPending: pending,
    });
    return;
  }
  const assessment = url.pathname.match(/^\/api\/host\/runs\/([a-f0-9-]{36})\/assessment$/);
  if (assessment && req.method === 'GET') {
    if (!store.hasRun(assessment[1])) {
      json(res, 404, { error: 'Run not found.' });
      return;
    }
    json(res, 200, assessmentForRun(store, assessment[1]));
    return;
  }
  const frame = url.pathname.match(/^\/api\/host\/runs\/([a-f0-9-]{36})\/frame$/);
  if (frame && req.method === 'GET') {
    const id = frame[1],
      active = runner.active;
    if (!store.hasRun(id)) {
      json(res, 404, { error: 'Run not found.' });
      return;
    }
    if (
      active?.run.id !== id ||
      active.controller.signal.aborted ||
      !active.walk.page ||
      store.run(id).state !== 'running'
    ) {
      json(res, 409, { error: 'The live browser is not available.' });
      return;
    }
    let picture;
    try {
      picture = await active.walk.frames.read();
    } catch {
      const ended =
        runner.active !== active ||
        active.controller.signal.aborted ||
        !store.hasRun(id) ||
        store.run(id).state !== 'running';
      json(res, ended ? 409 : 503, {
        error: ended
          ? 'The live browser has ended.'
          : 'The live picture is temporarily unavailable.',
      });
      return;
    }
    if (
      runner.active !== active ||
      active.controller.signal.aborted ||
      !store.hasRun(id) ||
      store.run(id).state !== 'running'
    ) {
      json(res, 409, { error: 'The live browser has ended.' });
      return;
    }
    json(res, 200, picture);
    return;
  }
  const read = url.pathname.match(
    /^\/api\/host\/runs\/([a-f0-9-]{36})(?:\/assets\/([a-f0-9]{64})\.png)?$/,
  );
  if (read && req.method === 'GET') {
    const [, id, hash] = read;
    if (!store.hasRun(id)) {
      json(res, 404, { error: 'Run not found.' });
      return;
    }
    if (hash) {
      const captures = store
        .records(id)
        .filter((r) => r.kind === 'capture' && r.payload.imageHash === hash);
      for (const capture of captures) {
        let bytes: Buffer;
        try {
          bytes = store.image(id, capture.payload.imageFile);
        } catch {
          // An intact original with identical verified bytes can still be served.
          continue;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(bytes);
        return;
      }
      json(res, 404, { error: 'Original image not found.' });
      return;
    }
    const { snapshot, keyboard } = exportHostSnapshot(store, id);
    json(res, 200, { snapshot, keyboard, waiting: runner.isWaiting(id) });
    return;
  }
  json(res, 404, { error: 'Host action not found.' });
}
