import type { Page } from 'playwright';
import { z } from 'zod';

const boundedText = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/);
const focusHelpSchema = z
  .object({
    version: z.literal('recorded-focus-help/1'),
    focus: z
      .object({
        tag: z.string().min(1).max(30),
        domId: z.string().max(200),
        role: z.string().max(80),
        describedBy: z.array(id).min(1).max(4),
      })
      .strict(),
    descriptionId: id,
    text: boundedText,
    ariaLine: z
      .string()
      .min(9)
      .max(800)
      .regex(/^- text: [^\r\n]+$/),
    position: z.enum(['absolute', 'fixed']),
    pointerEvents: z.literal('none'),
    verified: z
      .object({
        uniqueId: z.literal(true),
        currentFocus: z.literal(true),
        visible: z.literal(true),
        noninteractive: z.literal(true),
        plainText: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .refine(
    (row) =>
      new Set(row.focus.describedBy).size === row.focus.describedBy.length &&
      row.focus.describedBy.includes(row.descriptionId) &&
      [row.text, JSON.stringify(row.text)].some((value) => row.ariaLine === '- text: ' + value),
  );
export type RecordedFocusHelp = z.infer<typeof focusHelpSchema>;

/** Structural validity only. Callers must retain meaning and changes in these original rows. */
export function recordedFocusHelpRows(help: unknown): RecordedFocusHelp[] {
  if (!Array.isArray(help) || !help.length || help.length > 4) return [];
  const parsed = z.array(focusHelpSchema).max(4).safeParse(help);
  if (!parsed.success) return [];
  const rows = parsed.data;
  if (
    new Set(rows.map((row) => row.descriptionId)).size !== rows.length ||
    rows.some((row) => JSON.stringify(row.focus) !== JSON.stringify(rows[0]!.focus))
  )
    return [];
  return rows;
}

/** DOM facts only. No attributes, text, focus or styles are changed by this read. */
async function descriptionFacts(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const rawIds = active?.getAttribute('aria-describedby')?.trim();
    if (!active || !rawIds) return [];
    const ids = rawIds.split(/\s+/);
    if (
      ids.length > 4 ||
      new Set(ids).size !== ids.length ||
      ids.some((value) => value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) ||
      active.getAttribute('aria-errormessage') ||
      (active.hasAttribute('aria-invalid') && active.getAttribute('aria-invalid') !== 'false')
    )
      return [];
    const focus = {
      tag: active.tagName.toLowerCase(),
      domId: active.id,
      role: active.getAttribute('role') ?? '',
      describedBy: ids,
    };
    if (focus.domId.length > 200 || focus.role.length > 80) return [];
    const allIds = [...document.querySelectorAll('[id]')];
    const interactive =
      'a[href],button,input,select,textarea,form,fieldset,label,summary,details,iframe,object,embed,' +
      'audio[controls],video[controls],[tabindex],[contenteditable]:not([contenteditable="false"]),' +
      '[onclick],[onkeydown],[onkeyup],[onpointerdown],[onmousedown],[accesskey],[draggable="true"],' +
      '[role]:not([role="none"]):not([role="presentation"]):not([role="generic"])';
    const hidden = '[hidden],[inert],[aria-hidden="true"]';
    const live = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"])';
    const rows = [];
    for (const descriptionId of ids) {
      const matching = allIds.filter((element) => element.id === descriptionId);
      if (matching.length !== 1) continue;
      const node = matching[0]!;
      const text = node.textContent?.trim() ?? '';
      const style = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      if (
        !text ||
        text.length > 300 ||
        /[\u0000-\u001f\u007f]/.test(text) ||
        !['absolute', 'fixed'].includes(style.position) ||
        style.pointerEvents !== 'none' ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        bounds.bottom <= 0 ||
        bounds.right <= 0 ||
        bounds.top >= innerHeight ||
        bounds.left >= innerWidth ||
        node.contains(active) ||
        active.contains(node) ||
        (node as HTMLElement).isContentEditable ||
        node.closest(hidden + ',' + live) ||
        node.closest(interactive) ||
        node.querySelector(interactive + ',' + live) ||
        [...node.querySelectorAll(hidden)].some((child) => child.textContent?.trim()) ||
        node.querySelectorAll('*').length > 24 ||
        (active.getAttribute('aria-controls') ?? '').split(/\s+/).includes(descriptionId)
      )
        continue;
      let visible = true;
      for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
        const computed = getComputedStyle(ancestor);
        if (
          computed.display === 'none' ||
          computed.visibility !== 'visible' ||
          Number(computed.opacity) <= 0
        ) {
          visible = false;
          break;
        }
      }
      if (!visible) continue;
      rows.push({
        focus,
        descriptionId,
        text,
        position: style.position as 'absolute' | 'fixed',
        pointerEvents: 'none' as const,
      });
    }
    return rows;
  });
}

/** Record only exact current-focus descriptions whose own snapshot is one text leaf. */
export async function readRecordedFocusHelp(page: Page): Promise<RecordedFocusHelp[]> {
  const before = await descriptionFacts(page);
  if (!before.length) return [];
  const rows: RecordedFocusHelp[] = [];
  for (const facts of before) {
    const selector =
      '[id="' + facts.descriptionId.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
    const node = page.locator(selector);
    if ((await node.count()) !== 1) continue;
    let ariaLine: string;
    try {
      ariaLine = (await node.ariaSnapshot({ timeout: 250 })).trim();
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') continue;
      throw error;
    }
    const parsed = focusHelpSchema.safeParse({
      ...facts,
      version: 'recorded-focus-help/1',
      ariaLine,
      verified: {
        uniqueId: true,
        currentFocus: true,
        visible: true,
        noninteractive: true,
        plainText: true,
      },
    });
    if (parsed.success) rows.push(parsed.data);
  }
  // A disappearing/changing helper or a changed focus cannot become a stale instruction.
  const after = await descriptionFacts(page);
  return rows.filter((row) =>
    after.some(
      (current) =>
        current.descriptionId === row.descriptionId &&
        JSON.stringify(current) ===
          JSON.stringify({
            focus: row.focus,
            descriptionId: row.descriptionId,
            text: row.text,
            position: row.position,
            pointerEvents: row.pointerEvents,
          }),
    ),
  );
}

/** Rendering projection only. Callers must separately guard new/changed description meaning. */
export function stripRecordedFocusHelp(aria: string, help: unknown): string {
  const rows = recordedFocusHelpRows(help);
  if (!rows.length) return aria;
  const lines = aria.split('\n');
  const remove = new Set<number>();
  for (const row of rows) {
    // Top-level leaves only: a same-text child of a link/control is not this standalone help.
    const matches = lines.flatMap((line, index) => (line === row.ariaLine ? [index] : []));
    if (matches.length !== 1) return aria;
    const index = matches[0]!;
    const next = lines.slice(index + 1).find((line) => line.trim());
    if (remove.has(index) || /^\s+\S/.test(next ?? '')) return aria;
    remove.add(index);
  }
  return lines.filter((_, index) => !remove.has(index)).join('\n');
}
