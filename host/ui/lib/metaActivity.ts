import { z } from "zod";
import type { HostSnapshot } from "./metaWalkHost";
import type { JobProgress } from "@/app/audits/new/RunProgress";

const id = z.string().min(1).max(200);
const keys = [
  "Tab",
  "Shift+Tab",
  "Alt+Tab",
  "Alt+Shift+Tab",
  "Enter",
  "Space",
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
] as const;
/** Optional recorded progress: no provider response or private reasoning. */
export const metaActivitySchema = z
  .object({
    version: z.literal("recorded-activity/1"),
    runId: id,
    entries: z
      .array(
        z
          .object({
            id,
            sequence: z.number().int().positive(),
            recordHash: z.string().regex(/^[a-f0-9]{64}$/),
            createdAt: z.string().datetime(),
            kind: z.enum(["progress", "action", "preparing", "limit"]),
            action: z.enum([
              "Recorded progress",
              "Input result",
              "Preparing next action",
              "Run limit",
            ]),
            reason: z.string().max(500),
            target: z.enum(keys).optional(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict()
  .superRefine((activity, ctx) => {
    const ids = new Set<string>();
    const labels = {
      progress: "Recorded progress",
      action: "Input result",
      preparing: "Preparing next action",
      limit: "Run limit",
    };
    let previous = 0;
    for (const entry of activity.entries) {
      if (
        ids.has(entry.id) ||
        entry.sequence <= previous ||
        entry.action !== labels[entry.kind] ||
        (entry.target !== undefined && entry.kind !== "action")
      )
        ctx.addIssue({
          code: "custom",
          message: "Recorded activity identity, order or kind is invalid",
        });
      ids.add(entry.id);
      previous = entry.sequence;
    }
  });

export function metaActivityThoughts(
  snapshot: HostSnapshot,
): NonNullable<JobProgress["thoughts"]> {
  const thoughts: NonNullable<JobProgress["thoughts"]> = (
    snapshot.activity?.entries ?? []
  ).map((entry) => ({
    // This alternate feed uses the original monotonic record sequence as the
    // existing /live cursor. The original timestamp stays in the activity row.
    // No timestamp is displayed by the existing thinking component.
    ts: entry.sequence,
    action: entry.action,
    reason: entry.reason,
    ...(entry.target ? { target: entry.target } : {}),
  }));
  return thoughts.slice(-40);
}

/** The existing browser poll appends deltas, so never resend an older row. */
export function metaThoughtDelta(progress: JobProgress, since: unknown) {
  const value =
    typeof since === "string" && since.trim() !== "" ? Number(since) : 0;
  const cursor = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return (progress.thoughts ?? []).filter(
    (thought) => (thought.ts ?? 0) > cursor,
  );
}
