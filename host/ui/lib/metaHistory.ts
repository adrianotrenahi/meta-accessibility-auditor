import { hostSnapshotSchema, projectMetaWalk, type HostSnapshot } from './metaWalkHost';

type Job = {
  id: string;
  engineId: string | null;
  owner: string;
  account?: string;
  createdAt: string;
  deleted: boolean;
  discarding: boolean;
};

/** A read-only projection for the existing Audits list. Setup attempts with no
 * engine run are not audits, and are never described as live or completed.
 * `belongs` decides which saved audits are this account's. */
export async function readMetaHistory(
  jobs: Iterable<Job>,
  belongs: (job: Job) => boolean,
  mode: 'offline' | 'live',
  read: (engineId: string) => Promise<unknown>,
) {
  const eligible = [...jobs].filter((job) =>
    belongs(job) && !!job.engineId && !job.deleted && !job.discarding,
  );
  const sessions = [];
  const captures = [];
  const unavailableIds: string[] = [];
  // Sequential reads bound the work even when a local folder has many tests.
  for (const job of eligible) {
    let snapshot: HostSnapshot;
    try {
      snapshot = hostSnapshotSchema.parse(await read(job.engineId!));
      if (snapshot.run.id !== job.engineId || snapshot.run.mode !== mode)
        throw Error('The saved audit does not match its original local run.');
    } catch {
      unavailableIds.push(job.id);
      continue;
    }
    // A discard that started during the read must not reappear in the list.
    if (job.deleted || job.discarding || !belongs(job)) continue;
    const host = new URL(snapshot.run.url).hostname.replace(/^www\./i, '');
    const state = {
      running: 'Running', complete: 'Finished', partial: 'Partial',
      stopped: 'Stopped', interrupted: 'Interrupted',
    }[snapshot.run.state];
    sessions.push({
      id: job.id,
      name: `${state} · ${snapshot.run.goal || host}`,
      websiteHost: host,
      sourceUrl: snapshot.run.url,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      activeJobId: snapshot.run.state === 'running' ? job.id : null,
      score: null,
      _count: { steps: projectMetaWalk(snapshot).steps.length, issues: snapshot.findings.length },
    });
    const original = snapshot.captures.find((capture) => capture.imageAvailable);
    if (original) captures.push({
      id: original.id,
      sessionId: job.id,
      screenshotUrl: `/api/offline/jobs/${job.id}/assets/${original.imageHash}.png`,
      capturedAt: original.createdAt,
    });
  }
  // A deletion while another row was being read also withdraws earlier rows.
  const remaining = new Set(eligible.filter((job) =>
    belongs(job) && !job.deleted && !job.discarding,
  ).map((job) => job.id));
  return {
    unavailableCount: unavailableIds.filter((id) => remaining.has(id)).length,
    sessions: sessions.filter((session) => remaining.has(session.id)),
    captures: captures.filter((capture) => remaining.has(capture.sessionId)),
  };
}
