import { z } from 'zod';
import type { BrowserWalk } from './browser.js';
import { recordIsIntact, type Store } from './store.js';
import type { RecordEntry } from './types.js';

export const JOURNEY_EVIDENCE_VERSION = 'journey-evidence/1';
export const INCOMPARABLE_TOTALS_LIMIT =
  'Comparable selection, currency and original scope were not established. No unexplained increase or pass was inferred.';
export const UNRECOGNISED_BUNDLE_LIMIT =
  'A unique complete bundle offer with explicit item identities, quantities, price and currency was not established. Ordinary product prices were not treated as a journey total.';
const key = z.string().min(1).max(200);
const amount = z.number().finite().nonnegative().max(1_000_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/);
const extraSchema = z.object({ id: key, price: amount, currency }).strict();
const choiceSchema = z
  .object({
    id: z.string().max(200),
    selector: z.string().max(240),
    type: z.enum(['checkbox', 'radio', 'select', 'quantity']),
    checked: z.boolean().nullable(),
    selectedIndexes: z.array(z.number().int().nonnegative()).max(100),
    quantity: z.number().int().positive().max(1_000_000).nullable(),
    extra: extraSchema.nullable(),
  })
  .strict();
export const journeyDataSchema = z
  .object({
    commerce: z
      .object({
        kind: z.literal('declared_bundle_offer'),
        total: amount,
        currency,
        items: z
          .array(
            z.object({ id: key, quantity: z.number().int().positive().max(1_000_000) }).strict(),
          )
          .min(1)
          .max(20),
        disclosure: z.string().max(500).nullable(),
      })
      .strict()
      .nullable(),
    choices: z.array(choiceSchema).max(40),
    choicesComplete: z.boolean(),
    limits: z.array(z.string().max(500)).max(20),
  })
  .strict();
type JourneyData = z.infer<typeof journeyDataSchema>;

export const JOURNEY_CONTEXT_LIMIT =
  'Only explicitly declared bundle-offer items, quantities, price/currency and permitted choice states were read. This is not a verdict about the total, disclosure quality or every visible price. Unrecognised commerce stays unknown.';

function original(store: Store, runId: string, record: RecordEntry, kind: RecordEntry['kind']) {
  const saved = store.record(runId, record.id);
  if (
    record.runId !== runId ||
    record.kind !== kind ||
    !saved ||
    saved.kind !== kind ||
    saved.hash !== record.hash ||
    !recordIsIntact(record) ||
    !recordIsIntact(saved)
  )
    throw Error('Journey evidence needs its exact unchanged original record in this run.');
  return saved;
}

function capture(store: Store, runId: string, record: RecordEntry) {
  const source = original(store, runId, record, 'capture');
  if (source.payload.stable !== true)
    throw Error('Journey evidence cannot use an unstable original screen.');
  store.image(runId, source.payload.imageFile);
  return source;
}

function performedTriplet(
  store: Store,
  runId: string,
  before: RecordEntry,
  action: RecordEntry,
  after: RecordEntry,
) {
  capture(store, runId, before);
  capture(store, runId, after);
  original(store, runId, action, 'action');
  if (
    action.author !== 'browser' ||
    action.payload.method !== 'actual_keyboard_or_browser' ||
    action.payload.outcome !== 'performed' ||
    action.payload.sourceCaptureId !== before.id ||
    action.payload.sourceImageHash !== before.payload.imageHash ||
    action.sources.length !== 1 ||
    action.sources[0] !== before.id ||
    before.seq >= action.seq ||
    action.seq >= after.seq ||
    before.id === after.id
  )
    throw Error(
      'Journey evidence needs an actual performed action between its exact original screens.',
    );
}

/** The page's declared prices and choices, read in the page; saves nothing. Read-only,
 * bounded and value-whitelisted: no general field values or JSON-LD/customer data. */
function readPageJourneyData(page: BrowserWalk['page']) {
  return page.evaluate((unrecognisedBundleLimit) => {
    const limits: string[] = [];
    const dom = {
      visible(e: Element) {
        const style = getComputedStyle(e);
        return (
          e.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        );
      },
      isType(e: Element, name: string) {
        return (e.getAttribute('itemtype') ?? '')
          .split(/\s+/)
          .some(
            (value) =>
              value === `https://schema.org/${name}` || value === `http://schema.org/${name}`,
          );
      },
      own(scope: Element, name: string) {
        return [...scope.querySelectorAll(`[itemprop~="${name}"]`)].filter(
          (e) =>
            (e.hasAttribute('itemscope')
              ? e.parentElement?.closest('[itemscope]')
              : e.closest('[itemscope]')) === scope,
        );
      },
      scalar(e: Element | undefined) {
        if (!e || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName)) return null;
        const text = (e.getAttribute('content') ?? e.textContent ?? '').trim();
        return text.length > 0 && text.length <= 200 ? text : null;
      },
      one(scope: Element, name: string) {
        const nodes = this.own(scope, name);
        return nodes.length === 1 ? this.scalar(nodes[0]) : null;
      },
      number(text: string | null, positive = false) {
        if (text === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
        const value = Number(text);
        return Number.isFinite(value) &&
          value <= 1_000_000_000 &&
          (positive ? value > 0 : value >= 0)
          ? value
          : null;
      },
      identifier(scope: Element) {
        const id = this.one(scope, 'sku') ?? this.one(scope, 'productID');
        return id && /^[a-zA-Z0-9._-]{1,80}$/.test(id) ? id : null;
      },
      money(scope: Element) {
        const total = this.number(this.one(scope, 'price'));
        const code = this.one(scope, 'priceCurrency');
        return total !== null && code && /^[A-Z]{3}$/.test(code) ? { total, currency: code } : null;
      },
    };
    const offers = [...document.querySelectorAll('[itemscope][itemtype]')].filter(
      (e) => dom.isType(e, 'Offer') && dom.visible(e),
    );
    const bundles = offers.filter(
      (e) =>
        dom.own(e, 'includesObject').length > 0 &&
        !(e.getAttribute('itemprop') ?? '').split(/\s+/).includes('addOn'),
    );
    let commerce: {
      kind: 'declared_bundle_offer';
      total: number;
      currency: string;
      items: { id: string; quantity: number }[];
      disclosure: string | null;
    } | null = null;
    if (bundles.length === 1) {
      const bundle = bundles[0],
        price = dom.money(bundle),
        nodes = dom.own(bundle, 'includesObject');
      const items: { id: string; quantity: number }[] = [];
      let complete = nodes.length > 0 && nodes.length <= 20;
      for (const node of nodes.slice(0, 20)) {
        const products = dom.own(node, 'typeOfGood');
        const product =
          products.length === 1 && dom.isType(products[0], 'Product') ? products[0] : null;
        const id = product ? dom.identifier(product) : null;
        const quantity = dom.number(dom.one(node, 'amountOfThisGood'), true);
        if (
          !dom.isType(node, 'TypeAndQuantityNode') ||
          !id ||
          quantity === null ||
          !Number.isSafeInteger(quantity) ||
          quantity > 1_000_000
        )
          complete = false;
        else items.push({ id, quantity });
      }
      if (new Set(items.map((item) => item.id)).size !== items.length) complete = false;
      const descriptions = dom
        .own(bundle, 'description')
        .filter((e) => dom.visible(e) && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName));
      const disclosure =
        descriptions.length === 1
          ? (descriptions[0].textContent ?? '').trim().slice(0, 500) || null
          : null;
      if (price && complete)
        commerce = {
          kind: 'declared_bundle_offer',
          ...price,
          items: items.sort((a, b) => a.id.localeCompare(b.id)),
          disclosure,
        };
    }
    if (!commerce) limits.push(unrecognisedBundleLimit);
    const choices: {
      id: string;
      selector: string;
      type: 'checkbox' | 'radio' | 'select' | 'quantity';
      checked: boolean | null;
      selectedIndexes: number[];
      quantity: number | null;
      extra: { id: string; price: number; currency: string } | null;
    }[] = [];
    const controls = [
      ...document.querySelectorAll(
        'input[type="checkbox"],input[type="radio"],select,input[type="number"][itemprop~="amountOfThisGood"],input[type="number"][itemprop~="orderQuantity"]',
      ),
    ].filter(dom.visible);
    let choicesComplete = controls.length <= 40;
    for (const control of controls.slice(0, 40)) {
      const descriptor = [
        control.id,
        control.getAttribute('name'),
        control.getAttribute('autocomplete'),
      ].join(' ');
      if (
        /password|token|secret|one.?time|otp|verification|security|auth|session|credit|payment|cvv|card|email|address|phone/i.test(
          descriptor,
        )
      ) {
        choicesComplete = false;
        continue;
      }
      const input = control as HTMLInputElement;
      const type =
        control.tagName === 'SELECT'
          ? 'select'
          : input.type === 'number'
            ? 'quantity'
            : (input.type as 'checkbox' | 'radio');
      const id = control.id;
      const selector = id ? '#' + CSS.escape(id) : '';
      const extraScope = control.closest('[itemscope][itemtype]');
      const extraPrice =
        extraScope &&
        dom.isType(extraScope, 'Offer') &&
        (extraScope.getAttribute('itemprop') ?? '').split(/\s+/).includes('addOn')
          ? dom.money(extraScope)
          : null;
      const extraId = extraScope ? dom.identifier(extraScope) : null;
      const extra =
        extraPrice && extraId
          ? { id: extraId, price: extraPrice.total, currency: extraPrice.currency }
          : null;
      const quantity =
        type === 'quantity' &&
        /^\d+$/.test(input.value) &&
        Number(input.value) > 0 &&
        Number(input.value) <= 1_000_000
          ? Number(input.value)
          : null;
      const quantityProducts =
        extraScope && dom.isType(extraScope, 'TypeAndQuantityNode')
          ? dom.own(extraScope, 'typeOfGood')
          : [];
      const quantityItemId =
        quantityProducts.length === 1 && dom.isType(quantityProducts[0], 'Product')
          ? dom.identifier(quantityProducts[0])
          : null;
      const quantityKnown =
        !!quantityItemId &&
        !!commerce?.items.some((item) => item.id === quantityItemId && item.quantity === quantity);
      if (
        !id ||
        id.length > 200 ||
        selector.length > 240 ||
        document.querySelectorAll(selector).length !== 1 ||
        (type === 'quantity' ? quantity === null || !quantityKnown : !extra) ||
        (!!extra && !!commerce && extra.currency !== commerce.currency) ||
        type === 'select' ||
        input.disabled
      )
        choicesComplete = false;
      choices.push({
        id: id.slice(0, 200),
        selector: selector.slice(0, 240),
        type,
        checked: type === 'checkbox' || type === 'radio' ? input.checked : null,
        selectedIndexes:
          type === 'select'
            ? [...(control as HTMLSelectElement).options]
                .flatMap((option, index) => (option.selected ? [index] : []))
                .slice(0, 100)
            : [],
        quantity,
        extra,
      });
    }
    if (!choicesComplete)
      limits.push(
        'Some choice identities, meanings or states were not safely established; identical page addresses or totals do not prove an unchanged selection.',
      );
    return { commerce, choices, choicesComplete, limits };
  }, UNRECOGNISED_BUNDLE_LIMIT);
}

const selection = (data: JourneyData) =>
  data.choices
    .map(({ id, selector, type, checked, selectedIndexes, quantity, extra }) => ({
      id,
      selector,
      type,
      checked,
      selectedIndexes,
      quantity,
      extraId: extra?.id ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

/** Prices and choices as they are now, read as text with no screenshot (owner, 31 Oct: a
 * Tab on a page with prices needs a price note, not a picture). Null when unreadable. */
export async function journeyDataNow(walk: BrowserWalk): Promise<JourneyData | null> {
  walk.assertActive();
  const parsed = journeyDataSchema.safeParse(await readPageJourneyData(walk.page));
  return parsed.success ? parsed.data : null;
}

/** Whether declared prices or choices differ; an unreadable side counts as a change. */
export function journeyDataChanged(before: JourneyData | null, after: JourneyData | null) {
  if (!before || !after) return true;
  // Every declared price counts here, including an add-on's own price.
  const shape = (data: JourneyData) =>
    JSON.stringify([
      data.commerce,
      [...data.choices].sort((a, b) => a.id.localeCompare(b.id)),
      data.choicesComplete,
    ]);
  return shape(before) !== shape(after);
}

export async function readJourneyContext(walk: BrowserWalk, source: RecordEntry) {
  walk.assertActive();
  const { store, runId, page } = walk;
  capture(store, runId, source);
  const stamp = await walk.observationStamp();
  const sameSource = source.payload.url === page.url() && source.payload.stateStamp === stamp;
  const data = sameSource ? await readPageJourneyData(page) : null;
  const stable = sameSource && source.payload.stateStamp === (await walk.observationStamp());
  return store.append(
    runId,
    'observation',
    'browser',
    {
      method: 'journey_context',
      version: JOURNEY_EVIDENCE_VERSION,
      stable,
      sourceCaptureId: source.id,
      sourceCaptureHash: source.hash,
      sourceImageHash: source.payload.imageHash,
      data: stable && data ? journeyDataSchema.parse(data) : null,
      limit: stable
        ? JOURNEY_CONTEXT_LIMIT
        : 'The original state changed before or during the read. No commerce or choice fact was inferred.',
    },
    [source.id],
  );
}

function context(store: Store, runId: string, record: RecordEntry) {
  const saved = original(store, runId, record, 'observation');
  const source = store.record(runId, saved.payload.sourceCaptureId);
  if (
    !source ||
    saved.payload.method !== 'journey_context' ||
    saved.payload.version !== JOURNEY_EVIDENCE_VERSION ||
    saved.payload.stable !== true ||
    saved.sources.length !== 1 ||
    saved.sources[0] !== source.id ||
    saved.payload.sourceCaptureHash !== source.hash ||
    saved.payload.sourceImageHash !== source.payload.imageHash ||
    source.seq >= saved.seq
  )
    throw Error('Journey comparison needs a stable original context bound to its exact screen.');
  capture(store, runId, source);
  return { record: saved, capture: source, data: journeyDataSchema.parse(saved.payload.data) };
}

export function compareJourneyTotals(
  store: Store,
  runId: string,
  beforeContext: RecordEntry,
  action: RecordEntry,
  afterContext: RecordEntry,
) {
  const before = context(store, runId, beforeContext),
    after = context(store, runId, afterContext);
  performedTriplet(store, runId, before.capture, action, after.capture);
  if (before.record.seq >= action.seq)
    throw Error('The initial commerce state was not observed before the action.');
  const first = before.data.commerce,
    last = after.data.commerce;
  const selectionSame =
    first && last && before.data.choicesComplete && after.data.choicesComplete
      ? JSON.stringify([first.items, selection(before.data)]) ===
        JSON.stringify([last.items, selection(after.data)])
      : null;
  const sameCurrency = first && last ? first.currency === last.currency : null;
  const sameOrigin =
    new URL(before.capture.payload.url).origin === new URL(after.capture.payload.url).origin;
  const comparable =
    !!first && !!last && selectionSame === true && sameCurrency === true && sameOrigin;
  return store.append(
    runId,
    'observation',
    'browser',
    {
      method: 'comparable_totals',
      version: JOURNEY_EVIDENCE_VERSION,
      stable: true,
      beforeCaptureId: before.capture.id,
      afterCaptureId: after.capture.id,
      actionId: action.id,
      comparable,
      selectionSame,
      sameCurrency,
      currency: sameCurrency ? first!.currency : null,
      beforeTotal: first?.total ?? null,
      afterTotal: last?.total ?? null,
      disclosure: last?.disclosure ?? first?.disclosure ?? null,
      beforeDisclosure: first?.disclosure ?? null,
      afterDisclosure: last?.disclosure ?? null,
      limit: comparable
        ? 'The explicit bundle selection and currency match. A price difference and disclosure quality still require independent contextual review; null structured description is not proof of absent visible disclosure.'
        : INCOMPARABLE_TOTALS_LIMIT,
    },
    [before.record.id, after.record.id, before.capture.id, action.id, after.capture.id],
  );
}

export function recordOptOutContext(
  store: Store,
  runId: string,
  beforeContext: RecordEntry,
  action: RecordEntry,
  afterContext: RecordEntry,
) {
  const before = context(store, runId, beforeContext),
    after = context(store, runId, afterContext);
  performedTriplet(store, runId, before.capture, action, after.capture);
  if (before.record.seq >= action.seq)
    throw Error('The initial choice state was not observed before the action.');
  const candidates = before.data.choices.filter(
    (choice) => choice.id && choice.id === action.payload.before?.id,
  );
  const first = candidates.length === 1 ? candidates[0] : null;
  const matches = first
    ? after.data.choices.filter(
        (choice) =>
          choice.id === first.id &&
          choice.selector === first.selector &&
          choice.type === first.type &&
          choice.extra?.id === first.extra?.id,
      )
    : [];
  const last = matches.length === 1 ? matches[0] : null;
  const initialChoiceKnown = !!first && typeof first.checked === 'boolean';
  const priceKnown =
    !!first?.extra &&
    !!last?.extra &&
    first.extra.currency === last.extra.currency &&
    first.extra.price === last.extra.price;
  const beforeTargets = first
    ? (before.capture.payload.elements ?? []).filter(
        (element: any) =>
          element.selector === first.selector &&
          element.tag === 'input' &&
          element.type === 'checkbox' &&
          element.disabled !== true,
      )
    : [];
  const afterTargets = first
    ? (after.capture.payload.elements ?? []).filter(
        (element: any) =>
          element.selector === first.selector &&
          element.tag === 'input' &&
          element.type === 'checkbox' &&
          element.disabled !== true,
      )
    : [];
  const renderedTargetKnown =
    beforeTargets.length === 1 &&
    afterTargets.length === 1 &&
    beforeTargets[0].name === afterTargets[0].name;
  const optOutTested =
    initialChoiceKnown &&
    priceKnown &&
    renderedTargetKnown &&
    first!.type === 'checkbox' &&
    first!.checked === true &&
    typeof last?.checked === 'boolean' &&
    action.payload.before?.tag === 'input' &&
    action.payload.before?.type === 'checkbox' &&
    action.payload.action?.kind === 'press' &&
    action.payload.action.key === 'Space';
  return store.append(
    runId,
    'observation',
    'browser',
    {
      method: 'optout_context',
      version: JOURNEY_EVIDENCE_VERSION,
      stable: true,
      beforeCaptureId: before.capture.id,
      afterCaptureId: after.capture.id,
      actionId: action.id,
      fieldId: first?.id ?? null,
      initialChoiceKnown,
      priceKnown,
      optOutTested,
      choiceChanged:
        initialChoiceKnown && typeof last?.checked === 'boolean'
          ? first!.checked !== last.checked
          : null,
      initialChecked: first?.checked ?? null,
      finalChecked: last?.checked ?? null,
      extraId: first?.extra?.id ?? null,
      extraPrice: first?.extra?.price ?? null,
      currency: first?.extra?.currency ?? null,
      limit: optOutTested
        ? 'A performed safe keyboard attempt on the initially selected priced checkbox was observed. The meaning and clarity of the opt-out still require review.'
        : 'A supported opt-out path was not established. Radio/select changes, an initially unchecked extra, missing price or mere programmatic changes are not a completed opt-out test.',
    },
    [before.record.id, after.record.id, before.capture.id, action.id, after.capture.id],
  );
}

type ReturnEntry = {
  fieldId: string;
  selector: '#email';
  url: string;
  name: string;
  value: string;
  capture: RecordEntry;
  action: RecordEntry;
  baseline: RecordEntry;
};

/** Values live only in this run's Node memory and are restricted to the approved synthetic email. */
export class ReturnEvidence {
  private entries = new Map<string, ReturnEntry>();
  constructor(
    private store: Store,
    private runId: string,
  ) {}
  clear() {
    this.entries.clear();
  }
  async rememberTyped(
    walk: BrowserWalk,
    before: RecordEntry,
    action: RecordEntry,
    after: RecordEntry,
  ) {
    if (walk.runId !== this.runId || walk.store !== this.store)
      throw Error('Return evidence belongs to another run.');
    performedTriplet(this.store, this.runId, before, action, after);
    const p = action.payload;
    if (
      p.action?.kind !== 'type' ||
      p.action.text !== 'test@example.org' ||
      p.before?.id !== 'email' ||
      p.before?.tag !== 'input' ||
      p.before?.type !== 'email'
    )
      return false;
    const targets = after.payload.elements.filter(
      (element: any) =>
        element.selector === '#email' && element.tag === 'input' && element.type === 'email',
    );
    if (
      targets.length !== 1 ||
      after.payload.url !== walk.page.url() ||
      after.payload.stateStamp !== (await walk.observationStamp())
    )
      return false;
    const field = walk.page.locator('#email');
    if ((await field.count()) !== 1 || (await field.getAttribute('type')) !== 'email') return false;
    const value = await field.inputValue(); // Node comparison only; never passed into page.evaluate.
    if (
      value !== 'test@example.org' ||
      after.payload.stateStamp !== (await walk.observationStamp())
    )
      return false;
    const baseline = this.store.append(
      this.runId,
      'observation',
      'browser',
      {
        method: 'return_entry_baseline',
        version: JOURNEY_EVIDENCE_VERSION,
        stable: true,
        sourceCaptureId: after.id,
        typedActionId: action.id,
        fieldId: 'email',
        baselineRecorded: true,
        limit:
          'Only the approved synthetic email was observed; its value is not stored in this observation.',
      },
      [before.id, action.id, after.id],
    );
    this.entries.set(after.payload.url + ':#email', {
      fieldId: 'email',
      selector: '#email',
      url: after.payload.url,
      name: targets[0].name,
      value,
      capture: after,
      action,
      baseline,
    });
    return true;
  }
  async compareAfterBack(
    walk: BrowserWalk,
    before: RecordEntry,
    action: RecordEntry,
    after: RecordEntry,
  ) {
    if (walk.runId !== this.runId || walk.store !== this.store)
      throw Error('Return evidence belongs to another run.');
    performedTriplet(this.store, this.runId, before, action, after);
    if (action.payload.action?.kind !== 'back')
      throw Error('Return preservation needs the actual recorded back action.');
    const remembered = this.entries.get(after.payload.url + ':#email');
    let returned = false,
      entriesCompared = false,
      preserved: boolean | null = null;
    if (remembered && remembered.capture.seq < before.seq && remembered.baseline.seq < action.seq) {
      original(this.store, this.runId, remembered.baseline, 'observation');
      capture(this.store, this.runId, remembered.capture);
      original(this.store, this.runId, remembered.action, 'action');
      const targets = after.payload.elements.filter(
        (element: any) =>
          element.selector === remembered.selector &&
          element.tag === 'input' &&
          element.type === 'email' &&
          element.name === remembered.name,
      );
      returned =
        targets.length === 1 &&
        after.payload.url === walk.page.url() &&
        after.payload.stateStamp === (await walk.observationStamp());
      if (returned) {
        const field = walk.page.locator(remembered.selector);
        if ((await field.count()) === 1 && (await field.getAttribute('type')) === 'email') {
          const value = await field.inputValue(); // No value/hash is persisted or sent into the page.
          if (after.payload.stateStamp === (await walk.observationStamp())) {
            entriesCompared = true;
            preserved = value === remembered.value;
          }
        }
      }
    }
    return this.store.append(
      this.runId,
      'observation',
      'browser',
      {
        method: 'return_preservation',
        version: JOURNEY_EVIDENCE_VERSION,
        stable: true,
        beforeCaptureId: before.id,
        afterCaptureId: after.id,
        actionId: action.id,
        returned,
        entriesCompared,
        preserved,
        fieldId: remembered?.fieldId ?? null,
        entryCaptureId: remembered?.capture.id ?? null,
        typedActionId: remembered?.action.id ?? null,
        limit: entriesCompared
          ? 'A previously observed permitted field was compared in Node after an actual back action. This does not establish every entry or overall journey clarity.'
          : 'No comparable observed return-field baseline was established. Missing memory or a different returned state is not evidence that entries were lost.',
      },
      [
        before.id,
        action.id,
        after.id,
        ...(remembered
          ? [remembered.baseline.id, remembered.capture.id, remembered.action.id]
          : []),
      ],
    );
  }
}
