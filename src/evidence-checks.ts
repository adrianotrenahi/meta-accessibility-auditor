import { z } from 'zod';
import type { Page } from 'playwright';
import type { AxeResults, Result, NodeResult } from 'axe-core';
import { recordIsIntact } from './store.js';
import type { RecordEntry, ElementInfo } from './types.js';

export const missingEvidenceSchema = z
  .object({
    method: z.enum(['measurement', 'keyboard_focus', 'keyboard_activation', 'voiceover']),
    captureId: z.string().min(1).max(200),
    criterionId: z
      .string()
      .regex(/^C(?:0[1-9]|1[0-5])$/)
      .nullable(),
    reason: z.string().min(3).max(700),
    activationKey: z.enum(['Enter', 'Space']).optional(),
    targetName: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.method === 'keyboard_activation') {
      if (!request.activationKey || !request.targetName)
        context.addIssue({
          code: 'custom',
          message:
            'A keyboard activation needs its explicit key and the exact focused control name.',
        });
    } else if (request.activationKey !== undefined || request.targetName !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'Activation keys and control names belong only to a keyboard activation check.',
      });
  });
export type MissingEvidenceRequest = z.infer<typeof missingEvidenceSchema>;
/**
 * The JSON schema a model receives cannot say that only keyboard_activation takes an
 * activation key and control name. A stray key or name on another method carries no
 * meaning and is removed; an activation request missing either is not performed.
 * Only these optional requests are tidied: every other malformed result still fails.
 */
export function normalizeMissingEvidence(value: unknown) {
  if (!Array.isArray(value)) return value;
  return value
    .flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [item];
      const { activationKey, targetName, ...request } = item as Record<string, unknown>;
      if (request.method !== 'keyboard_activation') return [request];
      return activationKey != null && targetName != null ? [item] : [];
    })
    .slice(0, 2);
}
export type FocusedMethod = MissingEvidenceRequest['method'];

/** Claims a slot before execution, so a failed check is not a free retry. */
export class FocusedCheckBudget {
  private methods: FocusedMethod[];
  private reserved: number;
  constructor(options: { reserveVoiceOver?: number; usedMethods?: FocusedMethod[] } = {}) {
    this.methods = [...(options.usedMethods ?? [])];
    this.reserved = options.reserveVoiceOver ?? 0;
    if (
      !Number.isInteger(this.reserved) ||
      this.reserved < 0 ||
      this.reserved > 2 ||
      this.methods.length > 2 ||
      this.methods.some((m) => !missingEvidenceSchema.shape.method.safeParse(m).success)
    )
      throw Error('Focused checks must fit the existing two-check allowance.');
    this.reserved = Math.min(this.reserved, this.remaining);
  }
  get used() {
    return this.methods.length;
  }
  get remaining() {
    return 2 - this.used;
  }
  claim(method: FocusedMethod) {
    if (!missingEvidenceSchema.shape.method.safeParse(method).success)
      return {
        allowed: false,
        reason: 'The requested focused method is unsupported.',
        remaining: this.remaining,
      };
    if (this.remaining === 0)
      return {
        allowed: false,
        reason: 'The two focused checks have already been attempted.',
        remaining: 0,
      };
    if (method !== 'voiceover' && this.remaining <= this.reserved)
      return {
        allowed: false,
        reason: 'The remaining focused checks are reserved for real VoiceOver.',
        remaining: this.remaining,
      };
    this.methods.push(method);
    if (method === 'voiceover' && this.reserved) this.reserved--;
    return {
      allowed: true,
      reason: 'One existing focused-check slot was reserved before execution.',
      remaining: this.remaining,
    };
  }
}

export function focusedCheckEligibility(
  request: MissingEvidenceRequest,
  context: {
    runId: string;
    source: RecordEntry;
    storedSource?: RecordEntry;
    current: RecordEntry;
    actualStateStamp: string;
  },
) {
  const refused = (reason: string) => ({ allowed: false, state: 'NOT_TESTED' as const, reason });
  if (!missingEvidenceSchema.safeParse(request).success)
    return refused('The missing-fact request is unsupported; no check was attempted.');
  const { source, storedSource, current, actualStateStamp, runId } = context;
  if (
    !storedSource ||
    storedSource.kind !== 'capture' ||
    source.kind !== 'capture' ||
    current.kind !== 'capture' ||
    source.runId !== runId ||
    current.runId !== runId ||
    storedSource.runId !== runId ||
    request.captureId !== source.id ||
    storedSource.id !== source.id ||
    source.hash !== storedSource.hash ||
    !recordIsIntact(source) ||
    !recordIsIntact(storedSource) ||
    !recordIsIntact(current)
  )
    return refused('The exact original screen cannot be verified; no check was attempted.');
  if (
    source.payload.stable !== true ||
    current.payload.stable !== true ||
    source.id !== current.id ||
    source.hash !== current.hash ||
    typeof source.payload.imageHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.payload.imageHash) ||
    source.payload.imageHash !== current.payload.imageHash ||
    typeof source.payload.stateStamp !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.payload.stateStamp) ||
    source.payload.stateStamp !== current.payload.stateStamp ||
    source.payload.stateStamp !== actualStateStamp ||
    source.payload.url !== current.payload.url
  )
    return refused(
      'The requested original state is no longer current; no revisit or input was attempted.',
    );
  if (request.method === 'keyboard_activation') {
    const focus = source.payload.focus;
    if (
      !focus ||
      focus.name !== request.targetName ||
      !(
        (focus.tag === 'input' &&
          ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(focus.type)) ||
        (!['input', 'textarea'].includes(focus.tag) &&
          (['button', 'a', 'select'].includes(focus.tag) ||
            ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option'].includes(
              focus.role,
            )))
      )
    )
      return refused(
        'The requested named control is not the focused control in the current original; no activation was attempted.',
      );
  }
  return {
    allowed: true,
    state: 'ready' as const,
    reason: 'The exact stable original screen is still current.',
  };
}

type Box = ElementInfo['box'];
export type TargetMeasurement = {
  elementId: string | null;
  selector: string;
  box: Box;
  sizeMet: boolean | null;
  spacingException: boolean | null;
  otherExceptions: 'not-assessed';
  shapeLimit: string | null;
};
export function spacingException(
  box: Box,
  neighbours: { box: Box; sizeMet: boolean | null }[],
  complete: boolean,
) {
  if (
    !complete ||
    ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.width <= 0 ||
    box.height <= 0
  )
    return null;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  for (const other of neighbours) {
    const b = other.box;
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0)
      return null;
    // Undersized/unknown-shape targets get the conservative 24px circle too.
    if (other.sizeMet !== true && Math.hypot(cx - b.x - b.width / 2, cy - b.y - b.height / 2) < 24)
      return false;
    const dx = Math.max(b.x - cx, 0, cx - b.x - b.width);
    const dy = Math.max(b.y - cy, 0, cy - b.y - b.height);
    if (Math.hypot(dx, dy) < 12) return false;
  }
  return true;
}

export function contrastRatio(foreground: string, background: string): number | null {
  const luminance = (hex: string) => {
    if (!/^#[a-f\d]{6}$/i.test(hex)) return null;
    const c = [1, 3, 5]
      .map((n) => parseInt(hex.slice(n, n + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const a = luminance(foreground),
    b = luminance(background);
  return a === null || b === null ? null : (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export const requiredTextContrast = (fontSizePx: number, fontWeight: number) =>
  !Number.isFinite(fontSizePx) ||
  fontSizePx <= 0 ||
  !Number.isFinite(fontWeight) ||
  fontWeight < 1 ||
  fontWeight > 1000
    ? null
    : fontSizePx >= 24 || (fontSizePx >= (14 * 96) / 72 && fontWeight >= 700)
      ? 3
      : 4.5;

const supportedRules = new Set([
  'color-contrast',
  'button-name',
  'link-name',
  'label',
  'select-name',
  'image-alt',
  'input-image-alt',
  'area-alt',
  'document-title',
  'heading-order',
  'page-has-heading-one',
  'target-size',
]);
const limit = 60;
const checkDataKeys = [
  'fgColor',
  'bgColor',
  'contrastRatio',
  'fontSize',
  'fontWeight',
  'expectedContrastRatio',
  'shadowColor',
  'messageKey',
  'accessibleName',
  'relatedNode',
];
function safeAxeNode(node: NodeResult) {
  return {
    target: node.target,
    // Avoid serialising raw input markup or arbitrary check data containing page values.
    failureSummary: node.failureSummary,
    checks: [...node.any, ...node.all, ...node.none].map((check) => ({
      id: check.id,
      data: Object.fromEntries(
        checkDataKeys
          .filter((key) => ['string', 'number', 'boolean'].includes(typeof check.data?.[key]))
          .map((key) => [key, check.data[key]]),
      ),
    })),
  };
}
export function summarizeAxe(result: AxeResults) {
  const row = (r: Result) => ({
    id: r.id,
    impact: r.impact,
    description: r.description,
    help: r.help,
    nodes: r.nodes.slice(0, limit).map(safeAxeNode),
    nodesTruncated: r.nodes.length > limit,
  });
  return {
    violations: result.violations.map(row),
    passes: result.passes.filter((r) => supportedRules.has(r.id)).map(row),
    incomplete: result.incomplete.map((r) => ({ ...row(r), nodeCount: r.nodes.length })),
    scanLimits: {
      maximumNodesPerRule: limit,
      passedRules: 'Only the supported measurement rules are retained.',
      rawInputMarkup: 'Not retained by the measurement projection.',
    },
  };
}

export type ContrastMeasurement = {
  selector: string;
  foreground: string | null;
  background: string | null;
  ratio: number | null;
  axeReportedRatio: number | null;
  fontSizePx: number | null;
  fontWeight: number | null;
  requiredRatio: number | null;
  source: 'axe-core';
  state: 'measured' | 'incomplete';
  reason: string | null;
};
export function contrastMeasurements(result: AxeResults): ContrastMeasurement[] {
  const rows: ContrastMeasurement[] = [];
  for (const bucket of ['passes', 'violations', 'incomplete'] as const)
    for (const rule of result[bucket].filter((r) => r.id === 'color-contrast'))
      for (const node of rule.nodes)
        for (const check of [...node.any, ...node.all, ...node.none].filter(
          (c) => c.id === 'color-contrast',
        )) {
          const d = check.data ?? {};
          const foreground = typeof d.fgColor === 'string' ? d.fgColor : null;
          const background = typeof d.bgColor === 'string' ? d.bgColor : null;
          const fontSizePx =
            typeof d.fontSize === 'string' ? Number(d.fontSize.match(/\(([\d.]+)px\)/)?.[1]) : NaN;
          const fontWeight =
            d.fontWeight === 'bold' ? 700 : d.fontWeight === 'normal' ? 400 : Number(d.fontWeight);
          const ratio = foreground && background ? contrastRatio(foreground, background) : null;
          const measured =
            bucket !== 'incomplete' &&
            ratio !== null &&
            Number.isFinite(fontSizePx) &&
            fontSizePx > 0 &&
            Number.isFinite(fontWeight) &&
            fontWeight > 0 &&
            fontWeight <= 1000 &&
            !d.shadowColor &&
            !d.messageKey;
          rows.push({
            selector: JSON.stringify(node.target),
            foreground,
            background,
            ratio: measured ? ratio : null,
            axeReportedRatio:
              typeof d.contrastRatio === 'number' && Number.isFinite(d.contrastRatio)
                ? d.contrastRatio
                : null,
            fontSizePx: Number.isFinite(fontSizePx) ? fontSizePx : null,
            fontWeight: Number.isFinite(fontWeight) ? fontWeight : null,
            requiredRatio: measured ? requiredTextContrast(fontSizePx, fontWeight) : null,
            source: 'axe-core',
            state: measured ? 'measured' : 'incomplete',
            reason: measured
              ? null
              : 'The automatic check could not establish simple measured text colours and typography.',
          });
        }
  return rows;
}

export async function collectBrowserFacts(page: Page, source: RecordEntry, axe: AxeResults) {
  const dom = await page.evaluate((maximum) => {
    let textTruncated = false;
    const util = {
      selector(element: Element) {
        const parts: string[] = [];
        let e: Element | null = element;
        while (e) {
          if (e.id) {
            parts.unshift('#' + CSS.escape(e.id));
            break;
          }
          const tag = e.tagName.toLowerCase();
          const siblings = e.parentElement
            ? [...e.parentElement.children].filter((s) => s.tagName === e!.tagName)
            : [e];
          parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(e) + 1})`);
          e = e.parentElement;
        }
        return parts.join(' > ');
      },
      text(e: Element | null) {
        const value = (e instanceof HTMLElement ? e.innerText : (e?.textContent ?? '')).trim();
        if (value.length > 500) textTruncated = true;
        return value.slice(0, 500);
      },
      box(e: Element) {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      visible(e: Element, margin = 0) {
        const r = e.getBoundingClientRect(),
          s = getComputedStyle(e);
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.right > -margin &&
          r.bottom > -margin &&
          r.left < innerWidth + margin &&
          r.top < innerHeight + margin &&
          s.visibility !== 'hidden' &&
          s.visibility !== 'collapse' &&
          s.display !== 'none' &&
          Number(s.opacity) > 0
        );
      },
      labelledBy(e: Element, attribute: string) {
        return (e.getAttribute(attribute) ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => util.text(document.getElementById(id)))
          .filter(Boolean);
      },
      get(query: string, margin = 0) {
        return [...document.querySelectorAll(query)].filter((e) => util.visible(e, margin));
      },
    };
    const allFields = util.get('input:not([type=hidden]),select,textarea');
    const fields = allFields.slice(0, maximum).map((e) => {
      const input = e as HTMLInputElement;
      const labels = [...(input.labels ?? [])];
      const ariaInvalid = e.getAttribute('aria-invalid');
      const nativeValidityValid = input.validity?.valid ?? null;
      return {
        selector: util.selector(e),
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute('type') ?? '',
        visibleLabels: labels.filter((label) => util.visible(label)).map((e) => util.text(e)),
        programmaticLabels: [
          e.getAttribute('aria-label') ?? '',
          ...util.labelledBy(e, 'aria-labelledby'),
          ...labels.map((e) => util.text(e)),
        ].filter(Boolean),
        placeholder: e.getAttribute('placeholder') ?? '',
        required: input.required || e.getAttribute('aria-required') === 'true',
        // ARIA's false/empty/absent states are false; other nonempty tokens are invalid.
        invalid:
          (ariaInvalid !== null && ariaInvalid !== '' && ariaInvalid.toLowerCase() !== 'false') ||
          nativeValidityValid === false,
        ariaInvalid,
        nativeValidityValid,
        describedBy: util.labelledBy(e, 'aria-describedby'),
      };
    });
    const allImages = util.get('img,[role="img"]');
    const images = allImages.slice(0, maximum).map((e) => ({
      selector: util.selector(e),
      tag: e.tagName.toLowerCase(),
      alt: e.getAttribute('alt'),
      role: e.getAttribute('role'),
      ariaLabel: e.getAttribute('aria-label'),
      programmaticLabels: util.labelledBy(e, 'aria-labelledby'),
      contextText: util.text(e.closest('figure,article,li') ?? e.parentElement),
    }));
    const allHeadings = util.get('h1,h2,h3,h4,h5,h6,[role="heading"]');
    const headings = allHeadings.slice(0, maximum).map((e) => ({
      selector: util.selector(e),
      level: /^H[1-6]$/.test(e.tagName)
        ? Number(e.tagName[1])
        : Number(e.getAttribute('aria-level')) || null,
      text: util.text(e),
      ariaHidden: e.getAttribute('aria-hidden') === 'true',
    }));
    const allTargets = util.get(
      'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox]',
      12,
    );
    const targets = allTargets.slice(0, maximum).map((e) => {
      const b = util.box(e),
        s = getComputedStyle(e);
      const radii = [
        s.borderTopLeftRadius,
        s.borderTopRightRadius,
        s.borderBottomLeftRadius,
        s.borderBottomRightRadius,
      ];
      const simpleRadii = radii.every((r) => /^\d+(?:\.\d+)?px$/.test(r));
      const radius = Math.max(...radii.map(parseFloat));
      const simple = s.transform === 'none' && s.clipPath === 'none' && simpleRadii;
      const sizeMet =
        b.width < 24 || b.height < 24
          ? false
          : simple && b.width - radius * 2 >= 24 && b.height - radius * 2 >= 24
            ? true
            : null;
      return {
        selector: util.selector(e),
        box: b,
        sizeMet,
        shapeLimit: simple
          ? null
          : 'Clipping, transformation or target shape needs separate review.',
      };
    });
    const allMessages = util.get(
      '[role="alert"],[role="status"],[aria-invalid="true"],.error,.warning,[data-error]',
    );
    const colourMessages = allMessages.slice(0, maximum).map((e) => ({
      selector: util.selector(e),
      text: util.text(e),
      color: getComputedStyle(e).color,
      role: e.getAttribute('role'),
      describedBy: util.labelledBy(e, 'aria-describedby'),
    }));
    return {
      fields,
      images,
      headings: { title: document.title, items: headings },
      targets,
      colourMessages,
      viewport: { width: innerWidth, height: innerHeight },
      counts: {
        fields: allFields.length,
        images: allImages.length,
        headings: allHeadings.length,
        targets: allTargets.length,
        colourMessages: allMessages.length,
      },
      visibleTextCount: util
        .get('body *')
        .filter((e) =>
          [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
        ).length,
      unknownSurfaces: !!document.querySelector('iframe,canvas'),
      shadowRoots: [...document.querySelectorAll('*')].some((e) => !!e.shadowRoot),
      textTruncated,
    };
  }, limit);
  const controls = ((source.payload.elements as ElementInfo[]) ?? [])
    .filter(
      (e) =>
        e.box.x + e.box.width > 0 &&
        e.box.y + e.box.height > 0 &&
        e.box.x < source.payload.width &&
        e.box.y < source.payload.height,
    )
    .slice(0, limit)
    .map((e) => ({
      elementId: e.id,
      selector: e.selector ?? '',
      tag: e.tag,
      role: e.role,
      name: e.name,
      text: e.text,
      box: e.box,
      disabled: e.disabled,
    }));
  const targets: TargetMeasurement[] = dom.targets.map((target, index) => {
    const matched = controls.filter((c) => c.selector === target.selector);
    return {
      ...target,
      elementId: matched.length === 1 ? matched[0].elementId : null,
      spacingException: spacingException(
        target.box,
        dom.targets.filter((_, n) => n !== index),
        dom.counts.targets <= limit && !dom.shadowRoots && !dom.unknownSurfaces,
      ),
      otherExceptions: 'not-assessed',
    };
  });
  const contrast = contrastMeasurements(axe);
  const visibleMeasuredCount = contrast.filter((c) => c.state === 'measured').length;
  return {
    schema: 'access-walk/facts-v1' as const,
    captureId: source.id,
    imageHash: source.payload.imageHash as string,
    url: source.payload.url as string,
    scope: {
      viewportOnly: true,
      maximumPerFamily: limit,
      controlsIncomplete:
        !Number.isInteger(source.payload.limits?.totalControls) ||
        dom.shadowRoots ||
        dom.unknownSurfaces ||
        dom.textTruncated ||
        source.payload.limits?.totalControls > limit ||
        controls.some((c) => !c.selector || typeof c.name !== 'string'),
      controlsTruncated: source.payload.limits?.totalControls > limit,
      fieldsIncomplete: dom.shadowRoots || dom.unknownSurfaces || dom.textTruncated,
      fieldsTruncated: dom.counts.fields > limit,
      imagesIncomplete: dom.shadowRoots || dom.unknownSurfaces || dom.textTruncated,
      imagesTruncated: dom.counts.images > limit,
      headingsIncomplete:
        dom.shadowRoots ||
        dom.unknownSurfaces ||
        dom.textTruncated ||
        dom.headings.items.some((h) => h.level === null),
      headingsTruncated: dom.counts.headings > limit,
      targetsIncomplete:
        dom.shadowRoots || dom.unknownSurfaces || targets.some((t) => t.elementId === null),
      targetsTruncated: dom.counts.targets > limit,
      contrastIncomplete:
        visibleMeasuredCount === 0 ||
        contrast.some((c) => c.state === 'incomplete') ||
        dom.visibleTextCount > visibleMeasuredCount ||
        dom.unknownSurfaces ||
        dom.shadowRoots,
      contrastTruncated: contrast.length > limit,
      colourMessagesIncomplete: dom.shadowRoots || dom.unknownSurfaces || dom.textTruncated,
      colourMessagesTruncated: dom.counts.colourMessages > limit,
      colourMessageSelection:
        'Explicit alert/status, invalid-field and error/warning markers only.',
      unknownSurfaces: dom.unknownSurfaces,
      shadowRoots: dom.shadowRoots,
      textTruncated: dom.textTruncated,
    },
    controls,
    fields: dom.fields,
    images: dom.images,
    targets,
    headings: dom.headings,
    contrast: contrast.slice(0, limit),
    colourMessages: dom.colourMessages,
    limits: [
      'Facts describe the captured viewport and listed native/declared controls, not every page or custom pointer area.',
      'Values entered into form fields are not extracted.',
      'Accessible names and roles are browser observations, not VoiceOver speech.',
      'Target geometry does not decide equivalent, inline, user-agent or essential exceptions.',
      'Colour/message meaning, image purpose and label quality need review in original context.',
    ],
  };
}
export type BrowserFacts = Awaited<ReturnType<typeof collectBrowserFacts>>;
