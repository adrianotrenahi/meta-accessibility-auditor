import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSavedSamMask, SAM_MASK_LIMITS } from '../src/sam-mask.js';
import { digest } from '../src/store.js';
import type { RecordEntry } from '../src/types.js';

export function proveSavedSamMasks(dataDirectory: string, runId: string, outputDirectory: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw Error('Pass one valid saved run reference.');
  const data = realpathSync(dataDirectory);
  const desired = resolve(outputDirectory);
  const output = join(realpathSync(dirname(desired)), basename(desired));
  const within = relative(data, output);
  if (!within || (!within.startsWith('..' + sep) && within !== '..'))
    throw Error('Decoded proof files must be outside the original data directory.');
  const db = new DatabaseSync(join(data, 'runs.sqlite'), { readOnly: true });
  try {
    const rows = () =>
      db.prepare('SELECT * FROM records WHERE run_id=? ORDER BY seq').all(runId) as any[];
    const requests = () =>
      db.prepare('SELECT * FROM requests WHERE run_id=? ORDER BY id').all(runId);
    const originals = rows();
    if (!originals.length) throw Error('No original records were found for that saved run.');
    const before = digest(JSON.stringify({ records: originals, requests: requests() }));
    const records: RecordEntry[] = originals.map((row) => ({
      id: row.id,
      runId: row.run_id,
      seq: row.seq,
      kind: row.kind,
      author: row.author,
      payload: JSON.parse(row.body),
      sources: JSON.parse(row.sources),
      hash: row.hash,
      createdAt: row.created,
    }));
    const results = records.filter(
      (row) => row.kind === 'sam_mapping' && row.payload.stage === 'result',
    );
    if (results.length > 16)
      throw Error('This proof supports at most sixteen saved SAM results per run.');
    const decoded = [],
      errors = [];
    for (const mapping of results) {
      try {
        const capture = records.find(
          (record) => record.id === mapping.payload.captureId && record.kind === 'capture',
        );
        if (!capture || !/^[A-Za-z0-9_-]+\.png$/.test(capture.payload.imageFile))
          throw Error('The original capture or image reference is unavailable.');
        const imagePath = realpathSync(join(data, runId, capture.payload.imageFile));
        const imageLocation = relative(data, imagePath);
        if (imageLocation === '..' || imageLocation.startsWith('..' + sep))
          throw Error('The original image points outside this saved data folder.');
        const imageStat = statSync(imagePath);
        if (!imageStat.isFile() || imageStat.size > SAM_MASK_LIMITS.imageBytes)
          throw Error('The original image exceeds the supported byte allowance.');
        const result = decodeSavedSamMask(mapping, capture, readFileSync(imagePath));
        decoded.push(result);
      } catch (error) {
        errors.push({
          mappingId: mapping.id,
          reason: 'The saved outline could not be verified; no shape is exported.',
          detail: error instanceof Error ? error.message : 'Unknown saved-outline error.',
        });
      }
    }
    const after = digest(JSON.stringify({ records: rows(), requests: requests() }));
    if (before !== after) throw Error('The saved run changed during this read-only proof.');
    // A new output folder only; never overwrite an earlier proof or original file.
    mkdirSync(output, { mode: 0o700 });
    const outlines = decoded.map((result) => {
      if (result.state !== 'decoded') return result;
      const file = `mask_${digest(result.mappingId).slice(0, 24)}.svg`;
      writeFileSync(
        join(output, file),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.maskWidth} ${result.maskHeight}"><g transform="translate(0.5 0.5)"><path d="${result.svgPath}" fill="black" fill-rule="evenodd"/></g></svg>\n`,
        { flag: 'wx', mode: 0o600 },
      );
      return { ...result, file };
    });
    const proof = {
      protocol: 'access-walk/saved-mask-proof-v1',
      runId,
      decodedOutlines: outlines.filter((result) => result.state === 'decoded').length,
      emptyMasks: outlines.filter((result) => result.state === 'empty').length,
      unresolvedMasks: outlines.filter((result) => result.state === 'unresolved').length,
      savedResults: results.length,
      errors,
      originalRecordsAndLedgerUnchanged: true,
      providerCalls: 0,
      additionalCredits: 0,
      outlines,
      limits: [
        'Offline decoding of saved replies only; no new model response.',
        'No Cavioo presentation or customer integration is established.',
        'Geometry does not establish an accessibility finding.',
      ],
    };
    writeFileSync(join(output, 'result.json'), JSON.stringify(proof, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return proof;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      options = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--data', '--run', '--out'].includes(args[i]) || !args[i + 1] || options.has(args[i]))
        throw Error('Use --data <saved data folder> --run <saved run> --out <new proof folder>.');
      options.set(args[i], args[i + 1]);
    }
    if (options.size !== 3)
      throw Error('Use --data <saved data folder> --run <saved run> --out <new proof folder>.');
    const result = proveSavedSamMasks(
      options.get('--data')!,
      options.get('--run')!,
      options.get('--out')!,
    );
    console.log(
      JSON.stringify({
        output: options.get('--out'),
        decodedOutlines: result.decodedOutlines,
        emptyMasks: result.emptyMasks,
        unresolvedMasks: result.unresolvedMasks,
        savedResults: result.savedResults,
        errors: result.errors,
        originalRecordsAndLedgerUnchanged: result.originalRecordsAndLedgerUnchanged,
        providerCalls: 0,
        additionalCredits: 0,
        limits: result.limits,
      }),
    );
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Saved-outline proof failed.');
    process.exitCode = 1;
  }
}
