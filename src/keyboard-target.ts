import type { ElementHandle, Locator } from 'playwright';
import { recordIsIntact, type Store } from './store.js';
import type { BrowserWalk } from './browser.js';
import type { RecordEntry } from './types.js';
import type { Action } from './models.js';

export const TARGET_ROLES = [
  'gridcell',
  'searchbox',
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'tab',
  'option',
  'spinbutton',
] as const;
export const MAX_TARGET_KEYS = 24;
const controls =
  'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox]';

/** Compare semantic page content without plain, noninteractive focus tooltips.
 * Originals retain those tooltips and every picture; this is not image equivalence.
 */
export function traversalPageShape(aria: string) {
  const lines = aria.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i]!.match(/^(\s*)- tooltip(?:\s|:|$)/);
    if (!start) {
      kept.push(lines[i]!);
      continue;
    }
    let end = i + 1;
    while (
      end < lines.length &&
      lines[end]!.trim() &&
      (lines[end]!.match(/^\s*/)?.[0].length ?? 0) > start[1]!.length
    )
      end++;
    const children = lines.slice(i + 1, end);
    const plain = children.every((line) => {
      const role = line.match(/^\s*- ([a-z]+)(?:\s|:|$)/)?.[1];
      return role && ['text', 'generic', 'paragraph', 'strong', 'emphasis', 'img'].includes(role);
    });
    if (!plain) kept.push(...lines.slice(i, end));
    i = end - 1;
  }
  return kept.join('\n');
}

/** Roving calendar selection may change only local checked/selected flags.
 * All original states remain recorded. Other content, names, prices and controls stay strict.
 */
export function nativeGridShape(aria: string, targetName: string) {
  const lines = traversalPageShape(aria).split('\n');
  const label = JSON.stringify(targetName);
  const blocks: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const group = lines[i]!.match(/^(\s*)- (?:table|grid|listbox)(?:\s|:|$)/);
    if (!group) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end]!.match(/^\s*/)?.[0].length ?? 0) > group[1]!.length)
      end++;
    if (
      lines
        .slice(i + 1, end)
        .some((line) =>
          new RegExp(
            '^\\s*- (?:checkbox|radio|option|gridcell) ' +
              label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
              '(?: |:|$)',
          ).test(line),
        )
    )
      blocks.push({ start: i, end });
  }
  if (!blocks.length) return lines.join('\n');
  const block = blocks.sort((a, b) => a.end - a.start - (b.end - b.start))[0]!;
  return lines
    .map((line, i) => {
      if (i <= block.start || i >= block.end) return line;
      const item = line.match(/^(\s*- (?:checkbox|radio|option|gridcell) "(?:\\.|[^"\\])*")(.*)$/);
      return item
        ? item[1]! + item[2]!.replace(/ \[(?:checked|selected)(?:=(?:true|false|mixed))?\]/g, '')
        : line;
    })
    .join('\n');
}

export type TargetStep = (
  before: RecordEntry,
  action: Action,
  expectedTarget?: () => Promise<boolean>,
) => Promise<{
  current: RecordEntry;
  performed?: RecordEntry;
}>;

/** Real keyboard traversal; activation needs an explicit request and the normal fresh-input checks. */
export async function walkToKeyboardTarget(
  walk: BrowserWalk,
  store: Store,
  runId: string,
  start: RecordEntry,
  decision: Action,
  signal: AbortSignal,
  step: TargetStep,
) {
  let current = start;
  const actions: RecordEntry[] = [];
  const stop = (outcome: 'unavailable' | 'changed' | 'cycle' | 'limit', reason: string) => {
    store.append(
      runId,
      'limit',
      'driver',
      {
        method: 'keyboard_target_traversal',
        outcome,
        reason,
        requestedTarget: {
          id: decision.targetId ?? null,
          role: decision.targetRole ?? null,
          name: decision.targetName ?? null,
        },
        performedKeys: actions.length,
      },
      [current.id],
    );
    return { current, actions, outcome };
  };
  const active = () => {
    signal.throwIfAborted();
    walk.assertActive();
  };
  active();
  const original = store.record(runId, start.id);
  if (
    !original ||
    start.kind !== 'capture' ||
    start.runId !== runId ||
    !recordIsIntact(original) ||
    !recordIsIntact(start) ||
    original.hash !== start.hash ||
    JSON.stringify(original.sources) !== JSON.stringify(start.sources)
  )
    throw Error('Keyboard traversal needs its intact original screen.');
  await walk.verifyOriginalCapture(start);
  const epoch = await walk.page.evaluate(() => performance.timeOrigin);
  let target: Locator;
  if (decision.targetId) {
    const matches = start.payload.elements.filter(
      (element: any) => element.id === decision.targetId,
    );
    if (matches.length !== 1 || !/^e\d+$/.test(decision.targetId))
      return stop(
        'unavailable',
        'The requested keyboard target is not in this original screen. No input was sent.',
      );
    const info = matches[0];
    if (!info.name || !TARGET_ROLES.includes(info.role))
      return stop(
        'unavailable',
        'This target has no unique supported keyboard name. No input was sent.',
      );
    // A unique actual semantic match prevents source-order changes from retargeting a key walk.
    target = walk.page.getByRole(info.role, { name: info.name, exact: true });
    const indexed = walk.page.locator(controls).nth(Number(decision.targetId.slice(1)));
    if (
      (await target.count()) !== 1 ||
      (await indexed.count()) !== 1 ||
      !(await target.evaluate((element, other) => element === other, await indexed.elementHandle()))
    )
      return stop(
        'unavailable',
        'The original keyboard target is missing or ambiguous. No input was sent.',
      );
  } else {
    if (
      !decision.targetRole ||
      !TARGET_ROLES.includes(decision.targetRole) ||
      !decision.targetName?.trim()
    )
      return stop(
        'unavailable',
        'A keyboard target needs an exact name and role from the current page. No input was sent.',
      );
    target = walk.page.getByRole(decision.targetRole, { name: decision.targetName, exact: true });
  }
  if ((await target.count()) !== 1 || !(await target.isVisible()) || !(await target.isEnabled()))
    return stop(
      'unavailable',
      'The requested keyboard control is missing, ambiguous or unavailable. No input was sent.',
    );
  const handle = await target.elementHandle();
  if (!handle)
    return stop('unavailable', 'The requested keyboard target disappeared. No input was sent.');
  const connected = async () =>
    handle
      .evaluate((element) => element.isConnected && element.ownerDocument === document)
      .catch(() => false);
  const focused = async () =>
    handle.evaluate((element) => document.activeElement === element).catch(() => false);
  const focusHandles: ElementHandle[] = [];
  const key = decision.traversalKey ?? 'Tab';
  const arrow = key.startsWith('Arrow');
  const canTraverseGrid =
    !arrow ||
    (await handle.evaluate((element) => {
      const group = element.closest('table,[role=grid],[role=listbox]');
      return (
        !!group &&
        !!document.activeElement &&
        group.contains(document.activeElement) &&
        ['checkbox', 'radio', 'option', 'gridcell'].includes(element.getAttribute('role') ?? '')
      );
    }));
  if (!canTraverseGrid) {
    await handle.dispose();
    return stop(
      'unavailable',
      'Arrow traversal requires a current focused cell in the same native grid. No input was sent.',
    );
  }
  const targetName =
    decision.targetName ??
    start.payload.elements.find((element: any) => element.id === decision.targetId)?.name ??
    '';
  const shapeOf = (aria: string) =>
    arrow ? nativeGridShape(aria, targetName) : traversalPageShape(aria);
  try {
    const shape = shapeOf(start.payload.aria);
    for (let i = 0; i <= MAX_TARGET_KEYS; i++) {
      active();
      if (!(await connected()) || !(await handle.isVisible()) || !(await handle.isEnabled()))
        return stop(
          'changed',
          'The original keyboard target changed during traversal. A fresh decision is needed; no target was activated.',
        );
      if (await focused()) {
        if (decision.activation) {
          active();
          const next = await step(
            current,
            {
              kind: 'press',
              key: decision.activation,
              note: 'Apply the explicitly requested activation to the reached original control.',
            },
            async () => (await connected()) && (await focused()),
          );
          current = next.current;
          if (next.performed) actions.push(next.performed);
          if (!next.performed)
            return stop(
              'changed',
              'The original target changed before activation. A fresh decision is needed; no target activation was sent.',
            );
          return { current, actions, outcome: 'activation_sent' as const };
        }
        return { current, actions, outcome: 'reached' as const };
      }
      if (i === MAX_TARGET_KEYS)
        return stop(
          'limit',
          'The keyboard target was not reached within this bounded traversal. This does not establish a website keyboard barrier.',
        );
      const activeHandle = await walk.page.evaluateHandle(() => document.activeElement);
      const focus = activeHandle.asElement();
      if (focus) {
        const seen = await Promise.all(
          focusHandles.map((old) =>
            old.evaluate((element, other) => element === other, focus).catch(() => false),
          ),
        );
        if (seen.some(Boolean)) {
          await focus.dispose();
          return stop(
            'cycle',
            'Keyboard focus returned to a previously visited control. The robot stopped this traversal; no website keyboard barrier is inferred.',
          );
        }
        focusHandles.push(focus);
      }
      active();
      const beforeStep = current;
      const keyAction: Action = {
        kind: 'press',
        key,
        note: 'Move keyboard focus toward the requested original control.',
      };
      let next = await step(current, keyAction);
      if (
        !next.performed &&
        focus &&
        (await connected()) &&
        (await focus
          .evaluate((element) => element.isConnected && document.activeElement === element)
          .catch(() => false)) &&
        next.current.payload.url === beforeStep.payload.url &&
        next.current.payload.aria === beforeStep.payload.aria &&
        (await walk.page.evaluate(() => performance.timeOrigin)) === epoch
      ) {
        const withoutAppearance = (value: any) => {
          const { appearance: _appearance, ...rest } = value ?? {};
          return rest;
        };
        if (
          JSON.stringify(withoutAppearance(next.current.payload.focus)) ===
          JSON.stringify(withoutAppearance(beforeStep.payload.focus))
        ) {
          store.append(
            runId,
            'limit',
            'driver',
            {
              method: 'keyboard_target_observation_refresh',
              reason:
                'Focus appearance changed before input. A fresh original was recorded; the unsent key is attempted once with no repeated input or extra model decision.',
            },
            [beforeStep.id, next.current.id],
          );
          active();
          next = await step(next.current, keyAction);
        }
      }
      current = next.current;
      if (next.performed) actions.push(next.performed);
      active();
      if (
        !next.performed ||
        current.payload.url !== start.payload.url ||
        (await walk.page.evaluate(() => performance.timeOrigin)) !== epoch ||
        shapeOf(current.payload.aria) !== shape
      )
        return stop(
          'changed',
          'The page changed during keyboard traversal. A fresh decision is needed; no target was activated.',
        );
    }
    throw Error('Keyboard traversal did not return its bounded result.');
  } finally {
    await handle.dispose().catch(() => {});
    for (const focus of focusHandles) await focus.dispose().catch(() => {});
  }
}
