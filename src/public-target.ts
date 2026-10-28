import { z } from 'zod';
import { publicDestination } from './public-network.js';

export const journeyStepSchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().trim().min(1).max(500),
    intent: z.enum(['navigate', 'search', 'form', 'explore', 'verify', 'complete']).optional(),
    success: z.string().max(500).optional(),
    hint: z.string().max(500).optional(),
    optional: z.boolean().optional(),
  })
  .strict();
export const publicTargetSchema = z
  .object({
    url: z.string().url().max(2048),
    goal: z.string().trim().min(1).max(1500),
    steps: z
      .array(journeyStepSchema)
      .min(1)
      .max(12)
      .refine(
        (steps) => new Set(steps.map((s) => s.id)).size === steps.length,
        'Step identities must be unique.',
      ),
  })
  .strict();
export type PublicTarget = z.infer<typeof publicTargetSchema>;

/** A public target never inherits the demonstration's localhost exception. */
export async function publicTarget(value: unknown): Promise<PublicTarget> {
  const target = publicTargetSchema.parse(value);
  const { url } = await publicDestination(target.url);
  return { ...target, url: url.href };
}

/** A denied entry is retained as a limit rather than spending models on an error page. */
export function publicEntryLimit(title: unknown) {
  return typeof title === 'string' &&
    /^(access denied|403 forbidden|request blocked)$/i.test(title.trim())
    ? 'The website presented an access-denied entry page. The requested journey was not reached; no model request was made.'
    : null;
}
