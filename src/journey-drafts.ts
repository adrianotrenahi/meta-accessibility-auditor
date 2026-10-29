import { z } from 'zod';
import type { RecordEntry, Run } from './types.js';
import { journeyPlanSchema } from './journey-steps.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const journeyDraftBindingSchema = z
  .object({
    draftId: z.uuid().transform((value) => value.toLowerCase()),
    ownerHash: hash,
    briefHash: hash,
    url: z
      .string()
      .url()
      .max(2048)
      .transform((value) => {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw Error('A journey draft needs a web address without credentials.');
        return url.href;
      }),
    goal: z.string().trim().min(1).max(1500),
  })
  .strict();
export type JourneyDraftBinding = z.infer<typeof journeyDraftBindingSchema>;
export type ModelRequestPurpose = 'execution' | 'planning';
export interface JourneyDraft {
  draftId: string;
  ownerHash: string;
  briefHash: string;
  runId: string;
  planningRequestId: string | null;
  planId: string | null;
  planHash: string | null;
}
export interface JourneyDraftView {
  created: boolean;
  draft: JourneyDraft;
  run: Run;
  plan: RecordEntry | null;
}

/** Read the saved returned data, never a progress message or an invented fallback. */
export function readPlanningSteps(response: RecordEntry) {
  const output: any[] = Array.isArray(response.payload.output) ? response.payload.output : [];
  const tools = output.filter(
    (item) => item.type === 'function_call' && item.name === 'return_result',
  );
  if (tools.length > 1) throw Error('The planning response contains more than one result.');
  const raw =
    tools[0]?.arguments ??
    output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
  if (typeof raw !== 'string' || !raw)
    throw Error('The completed planning response has no returned plan.');
  return journeyPlanSchema.parse(JSON.parse(raw)).steps;
}
