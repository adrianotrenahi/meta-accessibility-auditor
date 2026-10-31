import { approval, key } from '../src/config.js';
import type { Approval } from '../src/types.js';

/** Only the separate local proof host may opt into a current, small paid batch. */
export function controlledHostMode(
  enabled = false,
  settings: { readApproval: () => Approval; readKey: () => string | undefined } = {
    readApproval: approval,
    readKey: key,
  },
  publicWebsites = false,
): 'offline' | 'live' {
  if (!enabled) return 'offline';
  const allowed = settings.readApproval();
  // Real websites: at most $10 per audit and no project total (owner, 31 Oct). The
  // controlled shop keeps its own $3 total and per-run proof limit.
  const publicSite = publicWebsites === true;
  const runLimit = publicSite ? 10 : 3;
  const total = allowed?.maxUsd;
  if (
    !allowed ||
    typeof allowed !== 'object' ||
    Array.isArray(allowed) ||
    allowed.approvedBy !== 'Adriano' ||
    typeof allowed.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(allowed.expiresAt)) ||
    Date.parse(allowed.expiresAt) <= Date.now() ||
    (total === undefined
      ? !publicSite
      : !Number.isFinite(total) || total <= 0 || (!publicSite && total > 3)) ||
    !Number.isFinite(allowed.maxRunUsd) ||
    allowed.maxRunUsd <= 0 ||
    (total !== undefined && allowed.maxRunUsd > total) ||
    allowed.maxRunUsd > runLimit ||
    !settings.readKey()
  )
    throw Error(
      publicWebsites === true
        ? 'Public website model testing needs a key and a current approval of at most $10 per audit.'
        : 'Controlled model testing needs a key and a current approval capped at $3 total and per run.',
    );
  return 'live';
}
