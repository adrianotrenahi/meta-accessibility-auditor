import { approval, key } from '../src/config.js';
import type { Approval } from '../src/types.js';

/** Only the separate local proof host may opt into a current, small paid batch. */
export function controlledHostMode(
  enabled = false,
  settings: { readApproval: () => Approval; readKey: () => string | undefined } = {
    readApproval: approval,
    readKey: key,
  },
): 'offline' | 'live' {
  if (!enabled) return 'offline';
  const allowed = settings.readApproval();
  if (
    allowed.approvedBy !== 'Adriano' ||
    !Number.isFinite(Date.parse(allowed.expiresAt)) ||
    Date.parse(allowed.expiresAt) <= Date.now() ||
    !Number.isFinite(allowed.maxUsd) ||
    allowed.maxUsd <= 0 ||
    allowed.maxUsd > 3 ||
    !Number.isFinite(allowed.maxRunUsd) ||
    allowed.maxRunUsd <= 0 ||
    allowed.maxRunUsd > allowed.maxUsd ||
    allowed.maxRunUsd > 3 ||
    !settings.readKey()
  )
    throw Error(
      'Controlled model testing needs a key and a current approval capped at $3 total and per run.',
    );
  return 'live';
}
