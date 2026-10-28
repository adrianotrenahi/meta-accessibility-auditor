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
  // The separate public-site batch includes earlier local costs and held charges.
  const totalLimit = publicWebsites === true ? 10 : 3;
  if (
    !allowed ||
    typeof allowed !== 'object' ||
    Array.isArray(allowed) ||
    allowed.approvedBy !== 'Adriano' ||
    typeof allowed.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(allowed.expiresAt)) ||
    Date.parse(allowed.expiresAt) <= Date.now() ||
    !Number.isFinite(allowed.maxUsd) ||
    allowed.maxUsd <= 0 ||
    allowed.maxUsd > totalLimit ||
    !Number.isFinite(allowed.maxRunUsd) ||
    allowed.maxRunUsd <= 0 ||
    allowed.maxRunUsd > allowed.maxUsd ||
    allowed.maxRunUsd > 3 ||
    !settings.readKey()
  )
    throw Error(
      publicWebsites === true
        ? 'Public website model testing needs a key and a current approval capped at $10 total and $3 per run.'
        : 'Controlled model testing needs a key and a current approval capped at $3 total and per run.',
    );
  return 'live';
}
