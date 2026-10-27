import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Approval } from './types.js';
export const root = process.cwd();
export const dataDir = resolve(root, 'data');
export function keyFromText(text: string) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(?:META_API_KEY|MODEL_API_KEY)[ \t]*=[ \t]*(.*)$/);
    const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (value) return value;
  }
  return undefined;
}
export function key() {
  const env = (() => {
    try {
      return readFileSync(resolve(root, '.env'), 'utf8');
    } catch {
      return '';
    }
  })();
  const value = process.env.META_API_KEY || process.env.MODEL_API_KEY || keyFromText(env);
  return value || undefined;
}
export function approval(): Approval {
  try {
    const a = JSON.parse(readFileSync(resolve(root, 'spend-approval.json'), 'utf8'));
    if (a.approvedBy !== 'Adriano') throw Error();
    return a;
  } catch {
    throw Error('Paid calls are disabled until a current bounded approval file is supplied.');
  }
}
export const safeError = (e: unknown) => {
  let text = e instanceof Error ? e.message : 'The operation could not finish.';
  const secret = key();
  if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
};
