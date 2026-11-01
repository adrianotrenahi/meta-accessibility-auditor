import type { ElementHandle, Locator } from 'playwright';
import { contentSettled, dialogLines, moneyLines } from './page-state.js';
import { stripRecordedFocusHelp, recordedFocusHelpRows } from './focus-help.js';
import { nativeTraversalKey, sameNativeArrowGroup } from './native-keyboard.js';
import { recordIsIntact, type Store } from './store.js';
import type { BrowserWalk } from './browser.js';
import { documentWasReplaced } from './page-observation.js';
import type { RecordEntry } from './types.js';
import type { Action } from './models.js';
import { keyboardCycleMemory, type CycleEvidence } from './keyboard-cycle-memory.js';

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
/** Owner, 1 Nov: Tab keeps going until it reaches the control or focus comes back to a control
 * it already visited (a full loop of the page, which proves the control unreachable). Each
 * press records where focus landed, not a screenshot, unless the page changes; about 0.6 s a
 * press on eDreams. The bound only stops a page with more than this many stops. */
export const MAX_TARGET_KEYS = 300;
/** Arrow keys inside a grid or list, for example a calendar: about two months of days. */
export const MAX_ARROW_KEYS = 62;
export const MAX_FOCUS_STALLS = 3;
class TraversalObservationChanged extends Error {}
const controls =
  'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox]';

/** Compare semantic page content without plain, noninteractive focus tooltips.
 * Originals retain those tooltips and every picture; this is not image equivalence.
 */
function tooltipProjection(aria: string) {
  const lines = aria.split('\n');
  const kept: string[] = [];
  const descriptions: string[] = [];
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
    else descriptions.push(lines.slice(i, end).join('\n'));
    i = end - 1;
  }
  return { aria: kept.join('\n'), descriptions };
}

export function traversalPageShape(aria: string) {
  return tooltipProjection(aria).aria;
}

/** Roving calendar selection may change only local checked/selected flags.
 * All original states remain recorded. Other content, names, prices and controls stay strict.
 */
export function nativeGridShape(aria: string, targetName: string) {
  const lines = traversalPageShape(aria).split('\n');
  const label = JSON.stringify(targetName);
  const blocks: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const group = lines[i]!.match(/^(\s*)- (?:table|grid|listbox|menubar|menu|tablist)(?:\s|:|$)/);
    if (!group) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end]!.match(/^\s*/)?.[0].length ?? 0) > group[1]!.length)
      end++;
    if (
      lines
        .slice(i + 1, end)
        .some((line) =>
          new RegExp(
            '^\\s*- (?:checkbox|radio|option|gridcell|menuitem|tab) ' +
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
      const item = line.match(
        /^(\s*- (?:checkbox|radio|option|gridcell|menuitem|tab) "(?:\\.|[^"\\])*")(.*)$/,
      );
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
  // Tests use smaller bounds; audits use the defaults above.
  bounds: { tab?: number; arrow?: number } = {},
) {
  let current = start;
  const actions: RecordEntry[] = [];
  const stop = (
    outcome: 'unavailable' | 'changed' | 'cycle' | 'limit',
    reason: string,
    details: Record<string, unknown> = {},
    sources: string[] = [],
  ) => {
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
        ...details,
      },
      [...new Set([current.id, ...sources])],
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
  const readTarget = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      active();
      if (!walk.page.isClosed() && documentWasReplaced(error))
        throw new TraversalObservationChanged();
      throw error;
    }
  };
  let cleanupHandle: ElementHandle | undefined;
  const focusHandles: ElementHandle[] = [];
  const focusFacts: { role: string; name: string }[] = [];
  let stalls = 0;
  try {
    await readTarget(() => walk.verifyOriginalCapture(start));
    const epoch = await readTarget(() => walk.page.evaluate(() => performance.timeOrigin));
    let target: Locator | undefined;
    // The role and exact name the decision chose; rechecked when the walk arrives.
    let chosenMeaning: Locator | undefined;
    let listedHandle: ElementHandle<HTMLElement | SVGElement> | null = null;
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
      const semantic = walk.page.getByRole(info.role, { name: info.name, exact: true });
      chosenMeaning = semantic;
      if (typeof start.payload.stampToken === 'string') {
        // The exact element this original listed, even when its name is repeated
        // (eDreams shows two "Where from?" fields). It must still be on the page and
        // still carry the name the decision read: a promotion button can keep its
        // element while its meaning changes.
        listedHandle = await readTarget(() => walk.listedControl(start, decision.targetId!));
        if (
          !listedHandle ||
          !(await readTarget(() =>
            semantic.evaluateAll((elements, other) => elements.includes(other), listedHandle!),
          ))
        ) {
          await listedHandle?.dispose().catch(() => {});
          return stop(
            'unavailable',
            'The chosen control is no longer on the page with the name the decision read. No input was sent.',
          );
        }
      } else {
        // Originals saved before page-state/1 keep the unique semantic match.
        target = semantic;
        const indexed = walk.page.locator(controls).nth(Number(decision.targetId.slice(1)));
        if (
          (await readTarget(() => target!.count())) !== 1 ||
          (await readTarget(() => indexed.count())) !== 1
        )
          return stop(
            'unavailable',
            'The original keyboard target is missing or ambiguous. No input was sent.',
          );
        const indexedHandle = await readTarget(() => indexed.elementHandle());
        try {
          if (
            !indexedHandle ||
            !(await readTarget(() =>
              target!.evaluate((element, other) => element === other, indexedHandle),
            ))
          )
            return stop(
              'unavailable',
              'The original keyboard target is missing or ambiguous. No input was sent.',
            );
        } finally {
          await indexedHandle?.dispose().catch(() => {});
        }
      }
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
      chosenMeaning = target;
    }
    if (
      (target && (await readTarget(() => target!.count())) !== 1) ||
      !(await readTarget(() => (listedHandle ?? target!).isVisible())) ||
      !(await readTarget(() => (listedHandle ?? target!).isEnabled()))
    ) {
      await listedHandle?.dispose().catch(() => {});
      return stop(
        'unavailable',
        'The requested keyboard control is missing, ambiguous or unavailable. No input was sent.',
      );
    }
    const handle = listedHandle ?? (await readTarget(() => target!.elementHandle()));
    if (!handle)
      return stop('unavailable', 'The requested keyboard target disappeared. No input was sent.');
    cleanupHandle = handle;
    const connected = async () =>
      handle
        .evaluate((element) => element.isConnected && element.ownerDocument === document)
        .catch(() => false);
    const focused = async () =>
      handle.evaluate((element) => document.activeElement === element).catch(() => false);
    const rovingTarget = await readTarget(() =>
      handle.evaluate((element) =>
        ['menuitem', 'tab'].includes(element.getAttribute('role') ?? ''),
      ),
    );
    const askedKey = decision.traversalKey ?? 'Tab';
    const outsideGroup = askedKey.startsWith('Arrow') && !(await sameNativeArrowGroup(handle));
    // Arrows cannot enter a menu or tab list from outside it. Its item is reached the way a
    // keyboard user does: Tab into the group, then arrows within it (nativeTraversalKey).
    // Owner, 31 Oct: Booking.com's "Flights" menu item was refused twice and the walk ended.
    // Only from outside every arrow group: focus inside another menu stays a refusal, so an
    // arrow request never turns into a jump between groups.
    const focusInNoGroup =
      outsideGroup &&
      (await readTarget(() =>
        handle.evaluate(
          () =>
            !document.activeElement?.closest(
              'table,[role=grid],[role=listbox],[role=menubar],[role=menu],[role=tablist]',
            ),
        ),
      ));
    const requestedKey = focusInNoGroup && rovingTarget ? 'Tab' : askedKey;
    const arrow = requestedKey.startsWith('Arrow');
    const canTraverseGrid = !arrow || !outsideGroup;
    if (!canTraverseGrid) {
      return stop(
        'unavailable',
        'Arrow traversal requires a focused item in the same native keyboard group. No input was sent.',
      );
    }
    const targetName =
      decision.targetName ??
      start.payload.elements.find((element: any) => element.id === decision.targetId)?.name ??
      '';
    const comparisonAria = (capture: RecordEntry) =>
      traversalPageShape(stripRecordedFocusHelp(capture.payload.aria, capture.payload.focusHelp));
    const shapeOf = (capture: RecordEntry) =>
      arrow || rovingTarget
        ? nativeGridShape(comparisonAria(capture), targetName)
        : comparisonAria(capture);
    // One history for the whole intent, including helpers hidden between keys.
    // Structural display-only qualification never establishes harmless meaning.
    const descriptionHistory = new Map<string, string>();
    const roleTooltipHistory = new Set<string>();
    let newlyObservedDescription = false;
    const recordDescriptions = (capture: RecordEntry, initial = false) => {
      for (const block of tooltipProjection(capture.payload.aria).descriptions) {
        if (!roleTooltipHistory.has(block)) {
          roleTooltipHistory.add(block);
          if (!initial) newlyObservedDescription = true;
        }
      }
      for (const row of recordedFocusHelpRows(capture.payload.focusHelp)) {
        const focus = capture.payload.focus ?? {};
        const signature = JSON.stringify({
          row,
          owner: {
            tag: focus.tag,
            id: focus.id,
            role: focus.role,
            name: focus.name,
          },
        });
        const previous = descriptionHistory.get(row.descriptionId);
        if (previous !== undefined && previous !== signature) return true;
        if (previous === undefined) {
          descriptionHistory.set(row.descriptionId, signature);
          if (!initial) newlyObservedDescription = true;
        }
      }
      return false;
    };
    recordDescriptions(start, true);
    const changedDescription = () =>
      stop(
        'changed',
        'A previously recorded description changed during traversal. Its full original remains saved; a fresh decision is needed before further input.',
      );
    const shape = shapeOf(start);
    // Owner, 1 Nov: eDreams' banner behind the search form keeps swapping its promotions, so
    // over a long Tab walk the copy drifted past the bound against the starting screen and
    // the walk stopped before its full loop. A Tab walk now compares each step with the one
    // before it: a swap is small; a popup, a new page or a changed target still stops it.
    let previousShape = shape;
    const memory = keyboardCycleMemory(walk);
    if (memory.isClosed)
      return stop('unavailable', 'Focus-cycle memory is closed. No traversal input was sent.');
    if (!(await focused())) {
      const prior = await memory.check(walk.page, handle);
      active();
      if (prior.state === 'unknown') {
        const evidence = prior.evidence;
        const first =
          evidence &&
          store
            .records(runId)
            .find(
              (record) =>
                record.kind === 'limit' && record.payload.cycleEvidence?.id === evidence.id,
            );
        return stop(
          'unavailable',
          prior.reason,
          evidence
            ? {
                previousCycleId: first?.id ?? null,
                cycleSourceId: evidence.sourceId,
                cycleSourceKind: evidence.sourceKind,
                cycleEvidence: evidence,
              }
            : {},
          first ? [first.id] : evidence ? [evidence.sourceId] : [],
        );
      }
      if (prior.state === 'blocked') {
        const first = store
          .records(runId)
          .find(
            (record) =>
              record.kind === 'limit' && record.payload.cycleEvidence?.id === prior.evidence.id,
          );
        const names = prior.evidence.participants
          .map((participant) => `${participant.role}: ${participant.name}`)
          .join('; ');
        return stop(
          'cycle',
          `This target was already not reached: focus cycled among ${names}${prior.evidence.context.kind === 'observed-dialog' ? ' in an observed dialog' : ''}. The relevant controls are unchanged; choose a different action or wait for a relevant state change. No new input was sent and no website keyboard barrier is inferred.`,
          {
            previousCycleId: first?.id ?? null,
            cycleSourceId: prior.evidence.sourceId,
            cycleSourceKind: prior.evidence.sourceKind,
            cycleEvidence: prior.evidence,
          },
          first ? [first.id] : [prior.evidence.sourceId],
        );
      }
    }
    // What the robot typed never appears in saved keyboard evidence.
    const typedRedactor = () => {
      const typed = store
        .records(runId)
        .filter(
          (record) =>
            record.kind === 'action' &&
            record.payload.action?.kind === 'type' &&
            typeof record.payload.action.text === 'string',
        )
        .map((record) => record.payload.action.text as string)
        .filter(Boolean);
      return (value: string) => {
        for (const input of typed) value = value.split(input).join('[redacted input]');
        return value;
      };
    };
    const maxKeys = arrow ? (bounds.arrow ?? MAX_ARROW_KEYS) : (bounds.tab ?? MAX_TARGET_KEYS);
    for (let i = 0; i <= maxKeys; i++) {
      active();
      if (
        !(await connected()) ||
        !(await readTarget(() => handle.isVisible())) ||
        !(await readTarget(() => handle.isEnabled()))
      )
        return stop(
          'changed',
          'The original keyboard target changed during traversal. A fresh decision is needed; no target was activated.',
        );
      if (await focused()) {
        // A focus handler may rename the control during the walk ("Reject" becoming
        // "Accept"); arriving at the same element is not arriving at the chosen control.
        const stillChosen = await readTarget(() =>
          chosenMeaning!.evaluateAll((elements, other) => elements.includes(other), handle),
        ).catch(() => false);
        if (!stillChosen)
          return stop(
            'changed',
            "The chosen control's name or role changed during the walk. No activation was sent; a fresh decision is needed.",
          );
        if (decision.activation) {
          if (
            !arrow &&
            !rovingTarget &&
            moneyLines(comparisonAria(current)) !== moneyLines(comparisonAria(start))
          )
            return stop(
              'changed',
              'The requested control is now focused, but a price on the page changed during the walk. A fresh decision is needed before activation. No target activation was sent.',
            );
          if (newlyObservedDescription)
            return stop(
              'changed',
              'The requested control is now focused. New description information was recorded during movement; a fresh decision is needed before activation. No target activation was sent.',
            );
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
      if (i === maxKeys) {
        // Owner, 1 Nov: eDreams' date field was never reached, and nothing was saved for the
        // analyst. A try that stops at its bound saves what it measured, whatever the key
        // ("we should not miss anything"); it is not proof the control is unreachable.
        const measured = actions.length > 0 && (await connected());
        const result = stop(
          'limit',
          measured
            ? `The keyboard target was not reached after ${actions.length} key presses. The measured presses are saved as keyboard evidence; on their own they do not prove the control can never be reached.`
            : 'The keyboard target was not reached within this bounded traversal. This does not establish a website keyboard barrier.',
          {},
          [start.id, ...actions.map((record) => record.id)],
        );
        if (!measured) return result;
        // Where the last press landed (Codex and Loca, PR 75), unless it is the page itself
        // or the same control as before.
        const last = await readTarget(() => walk.page.evaluateHandle(() => document.activeElement));
        const lastFocus = last.asElement();
        const isPage =
          !lastFocus ||
          (await readTarget(() =>
            lastFocus.evaluate(
              (element) => element === document.body || element === document.documentElement,
            ),
          ));
        const repeated =
          !!lastFocus &&
          !!focusHandles.at(-1) &&
          (await focusHandles
            .at(-1)!
            .evaluate((element, other) => element === other, lastFocus)
            .catch(() => false));
        if (lastFocus && !isPage && !repeated) {
          const facts = current.payload.focus ?? {};
          focusFacts.push({
            role: facts.role || (facts.tag === 'a' ? 'link' : facts.tag || 'control'),
            name: facts.name ?? '',
          });
        }
        await last.dispose().catch(() => {});
        const redact = typedRedactor();
        store.append(
          runId,
          'observation',
          'browser',
          {
            method: 'keyboard_reach/1',
            reached: false,
            fullCycle: false,
            target: {
              captureId: start.id,
              id: decision.targetId ?? null,
              role: decision.targetRole ?? null,
              name: redact(targetName),
              visibleAndEnabledAtStart: true,
            },
            keysPressed: actions.length,
            key: requestedKey,
            focusOrder: focusFacts.map((fact) => ({
              role: fact.role,
              name: redact(fact.name),
            })),
            limit:
              "Measured with real key presses in this browser, up to the robot's bound per try. It is not a screen-reader test.",
          },
          [...new Set([start.id, current.id, ...actions.map((record) => record.id)])],
        );
        return { ...result, evidenceSaved: true as const };
      }
      const activeHandle = await readTarget(() =>
        walk.page.evaluateHandle(() => document.activeElement),
      );
      const focus = activeHandle.asElement();
      // A widget may hold focus for a Tab or two (eDreams' accessibility notice does).
      // Staying put is a stall, not a cycle: it is counted, and only a return to an
      // earlier, different control is a cycle. Three stalls in a row end the walk.
      const previous = focusHandles.at(-1);
      const stalled =
        !!focus &&
        !!previous &&
        (await previous.evaluate((element, other) => element === other, focus).catch(() => false));
      if (stalled) {
        await focus!.dispose().catch(() => {});
        if (++stalls >= MAX_FOCUS_STALLS)
          return stop(
            'cycle',
            `Focus stayed on the same control for ${stalls} Tab presses in a row. The robot stopped this traversal; a fresh decision is needed.`,
          );
      } else stalls = 0;
      if (stalled) {
        // Held focus: no new visited control; the next key is still sent below.
      } else if (focus) {
        focusHandles.push(focus);
        const facts = current.payload.focus ?? {};
        focusFacts.push({
          role: facts.role || (facts.tag === 'a' ? 'link' : facts.tag || 'control'),
          name: facts.name ?? '',
        });
        // The document's placeholder is not a visited control. A first Tab after
        // a popup closes can leave body focused before the next real Tab enters
        // the page. All keys/content changes and the ordinary bound still apply.
        const pagePlaceholder = await readTarget(() =>
          focus.evaluate(
            (element) => element === document.body || element === document.documentElement,
          ),
        );
        const seen = pagePlaceholder
          ? []
          : await Promise.all(
              focusHandles
                .slice(0, -1)
                .map((old) =>
                  old.evaluate((element, other) => element === other, focus).catch(() => false),
                ),
            );
        if (seen.some(Boolean)) {
          const begin = seen.findIndex(Boolean);
          const redact = typedRedactor();
          const sourceKind =
            current.kind === 'capture' ||
            (current.kind === 'observation' && current.payload.method === 'keyboard_focus/1')
              ? current.kind
              : null;
          if (!sourceKind)
            return stop(
              'changed',
              'The cycle has no current original or keyboard-focus observation. Its inputs remain saved; no further input was sent.',
            );
          const evidence: CycleEvidence | undefined = await memory.remember({
            page: walk.page,
            target: handle,
            participants: focusHandles
              .slice(begin, -1)
              .map((handle, index) => ({ handle, ...focusFacts[begin + index]! })),
            sourceId: current.id,
            sourceKind,
            actionIds: actions.map((record) => record.id),
            redact,
          });
          active();
          const result = stop(
            'cycle',
            'Keyboard focus returned to a previously visited control. The robot stopped this traversal; no website keyboard barrier is inferred.',
            { ...(evidence ? { cycleEvidence: evidence } : { cycleMemory: 'unavailable' }) },
            [start.id, ...actions.map((record) => record.id)],
          );
          // Measured evidence for the analyst: real Tab presses went round the page
          // and never focused a control that was visible and enabled when the walk
          // began. The analyst may report it under C05; the reviewer still decides.
          if (!arrow && !rovingTarget && actions.length > 0 && (await connected()))
            store.append(
              runId,
              'observation',
              'browser',
              {
                method: 'keyboard_reach/1',
                reached: false,
                fullCycle: true,
                target: {
                  captureId: start.id,
                  id: decision.targetId ?? null,
                  role: decision.targetRole ?? null,
                  name: redact(targetName),
                  visibleAndEnabledAtStart: true,
                },
                keysPressed: actions.length,
                key: requestedKey,
                focusOrder: focusFacts.map((fact) => ({
                  role: fact.role,
                  name: redact(fact.name),
                })),
                limit:
                  'Measured with real key presses in this browser. It is not a screen-reader test.',
              },
              [...new Set([start.id, current.id, ...actions.map((record) => record.id)])],
            );
          return result;
        }
      } else await activeHandle.dispose();
      active();
      const beforeStep = current;
      const key = await readTarget(() => nativeTraversalKey(handle, requestedKey));
      const arrowGuard = key.startsWith('Arrow')
        ? async () => (await connected()) && (await sameNativeArrowGroup(handle))
        : undefined;
      if (arrowGuard && !(await arrowGuard()))
        return stop(
          'changed',
          'Keyboard focus left the original native group. A fresh decision is needed; no arrow input was sent.',
        );
      const keyAction: Action = {
        kind: 'press',
        key,
        note: 'Move keyboard focus toward the requested original control.',
      };
      let next = await step(current, keyAction, arrowGuard);
      active();
      if (recordDescriptions(next.current)) {
        current = next.current;
        if (next.performed) actions.push(next.performed);
        return changedDescription();
      }
      if (
        !next.performed &&
        focus &&
        (await connected()) &&
        (await focus
          .evaluate((element) => element.isConnected && document.activeElement === element)
          .catch(() => false)) &&
        next.current.payload.url === beforeStep.payload.url &&
        comparisonAria(next.current) === comparisonAria(beforeStep) &&
        (await readTarget(() => walk.page.evaluate(() => performance.timeOrigin))) === epoch
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
                'Focus appearance or recorded display-only help changed before input. A fresh original was recorded; the unsent key is attempted once with no repeated input or extra model decision.',
            },
            [beforeStep.id, next.current.id],
          );
          active();
          next = await step(next.current, keyAction, arrowGuard);
          active();
          if (recordDescriptions(next.current)) {
            current = next.current;
            if (next.performed) actions.push(next.performed);
            return changedDescription();
          }
        }
      }
      current = next.current;
      if (next.performed) actions.push(next.performed);
      active();
      if (
        !next.performed ||
        current.payload.url !== start.payload.url ||
        (await readTarget(() => walk.page.evaluate(() => performance.timeOrigin))) !== epoch ||
        // Arrow walks in grids and menus keep their exact shape. A plain Tab walk stops
        // for a popup or a large change, not for copy rotating elsewhere on the page;
        // prices are checked before any activation instead.
        (arrow || rovingTarget
          ? shapeOf(current) !== shape
          : dialogLines(shapeOf(current)) !== dialogLines(shape) ||
            !contentSettled(previousShape, shapeOf(current)))
      )
        return stop(
          'changed',
          'The page changed during keyboard traversal. A fresh decision is needed; no target was activated.',
        );
      previousShape = shapeOf(current);
    }
    throw Error('Keyboard traversal did not return its bounded result.');
  } catch (error) {
    if (!(error instanceof TraversalObservationChanged)) throw error;
    active();
    current = await walk.captureSettled();
    return stop(
      'changed',
      'The document changed while reading the original keyboard target. Any earlier keys remain recorded; a fresh decision is needed before further input.',
    );
  } finally {
    await cleanupHandle?.dispose().catch(() => {});
    for (const focus of focusHandles) await focus.dispose().catch(() => {});
  }
}
