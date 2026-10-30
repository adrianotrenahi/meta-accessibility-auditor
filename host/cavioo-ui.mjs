// Loads the hosted Cavioo screens package (prior work; see tools/cavioo-ui/build.mjs).
// The package is accepted only when its SHA-256 matches cavioo-ui.lock.json, so a
// changed or swapped file is refused. A verified copy is kept, so later starts work
// without a connection, and the browser only ever loads it from this computer.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CAVIOO_UI_LOCK = JSON.parse(
  await readFile(new URL('./cavioo-ui.lock.json', import.meta.url), 'utf8'),
);
const MAX_BYTES = 32 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Turns the verified package text into files the page server can send. */
export function readCaviooUi(text, lock = CAVIOO_UI_LOCK) {
  if (sha256(text) !== lock.sha256)
    throw Error('The Cavioo screens package does not match its recorded fingerprint, so it was not used.');
  const pkg = JSON.parse(text);
  if (pkg.format !== 'access-walk/cavioo-ui-v1' || !pkg.files?.['/'] || typeof pkg.hostLib !== 'string')
    throw Error('The Cavioo screens package has an unknown format.');
  const files = new Map();
  for (const [name, file] of Object.entries(pkg.files)) {
    if (!/^\/[a-zA-Z0-9/_.-]*$/.test(name) || name.includes('..') || typeof file.type !== 'string')
      throw Error('The Cavioo screens package names an unsafe file.');
    files.set(name, { type: file.type, bytes: Buffer.from(file.base64, 'base64') });
  }
  return { files, hostLib: pkg.hostLib, builtFrom: pkg.builtFrom };
}

/**
 * Order: a local file named in ACCESS_WALK_CAVIOO_UI (for rebuilding), then the
 * verified copy, then a download from the recorded address. Each must match.
 */
export async function loadCaviooUi({
  cacheDirectory,
  lock = CAVIOO_UI_LOCK,
  source = process.env.ACCESS_WALK_CAVIOO_UI,
  download = fetch,
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(lock.sha256 ?? '') || !/^https:\/\//.test(lock.url ?? ''))
    throw Error('cavioo-ui.lock.json must name an https address and a SHA-256 fingerprint.');
  if (source) return readCaviooUi(await readFile(source, 'utf8'), lock);
  const kept = path.join(cacheDirectory, `${lock.sha256}.json`);
  try {
    return readCaviooUi(await readFile(kept, 'utf8'), lock);
  } catch (error) {
    if (error.code !== 'ENOENT' && !/fingerprint|format|unsafe/.test(error.message)) throw error;
  }
  let text;
  try {
    const response = await download(lock.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw Error(`the download answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw Error('the download is larger than expected');
    text = bytes.toString('utf8');
  } catch (error) {
    throw Error(
      `The Cavioo screens could not be downloaded (${error.message}). Check the internet connection and start again; the engine itself needs no download.`,
    );
  }
  const loaded = readCaviooUi(text, lock);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await writeFile(`${kept}.tmp`, text, { mode: 0o600 });
  await rename(`${kept}.tmp`, kept);
  return loaded;
}
