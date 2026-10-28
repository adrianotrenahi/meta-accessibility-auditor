/** Meta count requests may be repeated; a model generation may not have reached us.
 * Retrying generation is limited to proved connection-establishment failures,
 * before any HTTP response. No redirect may hide an earlier transmitted request.
 */
export type MetaPhase = 'input_count' | 'generation';
export type MetaTransportDiagnostic = {
  version: 'meta-transport/1';
  phase: MetaPhase;
  stage: 'requesting' | 'http' | 'reading';
  attempts: number;
  code: string;
  status?: number;
};
const beforeConnection = new Set(['ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);
const knownCodes = new Set([
  ...beforeConnection,
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ABORT_ERR',
]);
const retryCountStatus = new Set([408, 429, 500, 502, 503, 504]);
const retryDelayLimit = 5000;

// Never save an exception message, URL, body, key, address or arbitrary error code.
function connectionCodes(error: unknown) {
  const codes: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) {
      codes.push('OTHER');
      return;
    }
    seen.add(value);
    const initialCodeCount = codes.length;
    const item = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (item.code !== undefined)
      codes.push(typeof item.code === 'string' && knownCodes.has(item.code) ? item.code : 'OTHER');
    if (item.name === 'AbortError' || item.name === 'TimeoutError') codes.push('ABORT_ERR');
    if (item.cause !== undefined) visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) {
      if (!item.errors.length || item.errors.length > 8) codes.push('OTHER');
      else for (const nested of item.errors) visit(nested, depth + 1);
    } else if (item.errors !== undefined) codes.push('OTHER');
    // A wrapper may delegate to documented causes; an unexplained leaf cannot.
    if (codes.length === initialCodeCount) codes.push('OTHER');
  };
  visit(error);
  return codes;
}
function genericFetchFailure(error: unknown) {
  return error instanceof TypeError && error.message === 'fetch failed';
}
function isCancelled(error: unknown, signal: AbortSignal) {
  const codes = connectionCodes(error);
  return (
    signal.aborted ||
    codes.some((code) =>
      ['ABORT_ERR', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code),
    )
  );
}
function shortDelay(attempt: number) {
  return (attempt === 1 ? 250 : 1000) + Math.floor(Math.random() * 100);
}
function retryAfter(response: Response, attempt: number): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) return shortDelay(attempt);
  const seconds = Number(value);
  const date = Number.isFinite(seconds) ? NaN : Date.parse(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : date - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return shortDelay(attempt);
  return delay <= retryDelayLimit ? Math.ceil(delay) : null;
}
export class MetaTransportError extends Error {
  constructor(
    public readonly diagnostic: MetaTransportDiagnostic,
    public readonly generationNotSent = false,
  ) {
    const d = diagnostic;
    const reason =
      d.phase === 'input_count'
        ? `Cavioo could not prepare the next model request with Meta after ${d.attempts} connection attempt${d.attempts === 1 ? '' : 's'}. No new model generation was sent.`
        : generationNotSent
          ? 'The model request could not establish a connection to Meta. No answer was started.'
          : 'Cavioo did not receive a complete result from Meta. Its possible charge remains reserved; no uncertain model request was repeated.';
    super(reason + (d.status ? ` Meta returned status ${d.status}.` : ''));
  }
}
export type MetaRetry = MetaTransportDiagnostic & {
  delayMs: number;
  nextAttempt: number;
  generationNotSent: boolean;
};
export type MetaPostOptions = {
  phase: MetaPhase;
  body: unknown;
  apiKey: string;
  signal: AbortSignal;
  fetcher: typeof fetch;
  assertActive: () => void;
  onRetry?: (retry: MetaRetry) => void;
  // Dependency injection keeps fault tests offline and avoids real waiting in them.
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
export async function waitForMetaRetry(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function postMeta(options: MetaPostOptions): Promise<any> {
  const { phase, signal } = options;
  const path = phase === 'input_count' ? '/responses/input_tokens' : '/responses';
  const body = JSON.stringify(options.body);
  const maximumAttempts = phase === 'input_count' ? 3 : 2;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    signal.throwIfAborted();
    options.assertActive();
    let response: Response | undefined;
    let stage: MetaTransportDiagnostic['stage'] = 'requesting';
    let diagnostic: MetaTransportDiagnostic | undefined;
    let delay: number | null = null;
    let generationNotSent = false;
    try {
      response = await options.fetcher('https://api.meta.ai/v1' + path, {
        method: 'POST',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal,
      });
      stage = 'http';
      if (!response.ok) {
        diagnostic = {
          version: 'meta-transport/1',
          phase,
          stage,
          attempts: attempt,
          code: 'HTTP_ERROR',
          status: response.status,
        };
        if (phase === 'input_count' && retryCountStatus.has(response.status))
          delay = retryAfter(response, attempt);
        await response.body?.cancel().catch(() => {});
      } else {
        stage = 'reading';
        return await response.json();
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const cancelled = isCancelled(error, signal);
      const codes = connectionCodes(error);
      const provedBeforeConnection =
        response === undefined &&
        stage === 'requesting' &&
        codes.length > 0 &&
        codes.every((code) => beforeConnection.has(code));
      generationNotSent = phase === 'generation' && !cancelled && provedBeforeConnection;
      const mixedCauses = new Set(codes).size > 1 && !provedBeforeConnection;
      diagnostic = {
        version: 'meta-transport/1',
        phase,
        stage,
        attempts: attempt,
        code: mixedCauses
          ? 'MIXED_CAUSES'
          : (codes.find((code) => code !== 'OTHER') ??
            (error instanceof SyntaxError ? 'INVALID_JSON' : 'CONNECTION_UNKNOWN')),
      };
      const repeatableCountFailure =
        phase === 'input_count' &&
        !(error instanceof SyntaxError) &&
        (genericFetchFailure(error) || codes.some((code) => knownCodes.has(code)));
      if (!cancelled && (provedBeforeConnection || repeatableCountFailure))
        delay = shortDelay(attempt);
    }
    if (!diagnostic) throw Error('Meta request ended without a result.');
    if (delay === null || attempt === maximumAttempts)
      throw new MetaTransportError(diagnostic, generationNotSent);
    signal.throwIfAborted();
    options.assertActive();
    options.onRetry?.({
      ...diagnostic,
      delayMs: delay,
      nextAttempt: attempt + 1,
      generationNotSent,
    });
    await (options.wait ?? waitForMetaRetry)(delay, signal);
  }
  throw Error('Meta connection attempt limit reached.');
}
