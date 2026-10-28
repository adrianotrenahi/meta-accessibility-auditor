# Meta connection recovery

The robot could stop with only “fetch failed” after a healthy series of actions. That did not distinguish preparing a request from waiting for a generated answer. The retained 28 October Booking.com investigation contains both cases: one count connection failed before a new spending reservation; another generation failed after its reservation, leaving an unknown charge. These originals and their unknown charges remain unchanged.

## What can safely reconnect

An input count does not generate, store a response or record generation usage. It can retry the exact already-rendered body at most three times for a transient connection failure or selected temporary server statuses. Backoff is short and bounded; a `Retry-After` longer than five seconds is respected by stopping rather than retrying early. Permanent rejection, invalid JSON, owner Stop, an abort or a request deadline is not retried.

A generation can reconnect at most once only when no HTTP response has arrived and every available error code proves connection establishment failed: `ENOTFOUND` (address lookup failed), `ECONNREFUSED` (no connection could be made), or `UND_ERR_CONNECT_TIMEOUT` (connection establishment timed out). Unknown/mixed causes, resets, broken pipes, generic/send/header/body timeouts, any HTTP response, and failure while reading the answer do not earn a generation retry. Redirects are not followed: an earlier delivered request cannot be concealed behind a failed redirected address. This is an inference from the documented connection-stage errors and the fixed request URL/body, not provider idempotency.

All attempts for one logical generation share one pre-existing spending reservation. No browser input is repeated by this change. A stopped run cannot reconnect. The actual cost is settled only from the returned provider usage. An uncertain result keeps its existing reservation and stops honestly; there is no invented answer, zero-cost claim, generation replay or automatic release of an unknown charge.

Safe recorded connection notes identify the phase, request/response-reading stage, allowlisted error category, status and attempt number. They contain no original exception message, key, request body, host/address or page text. The existing Cavioo feed/report can display their plain-English reason without a new component or layout.

## Scope and limits

The fixed model settings, original text/images, count/generation body, role/run/project spending limits, request counts and `store: false` privacy choice stay unchanged. Stored-response retrieval requires a stored response ID; it cannot recover the historical stateless request whose ID/result never arrived. Switching to provider storage or assuming an undocumented idempotency key is outside this change. A genuine interrupted generation can still leave the journey partial, with its possible charge held.

The implementation and fault tests establish bounded behavior, not the historical low-level network cause or a completed public flight search. No real Meta request, provider count, website visit, private record mutation or additional credit spend was used. Root coordinates the one bounded actual full-journey proof after all reviewed fixes merge; [ADR-927 (investigate the lost connection and prove safe recovery)](https://linear.app/adrianotrenahi/issue/ADR-927) retains its remaining actual proof.

## Primary sources checked on 28 October 2026

- [Meta token counting](https://dev.meta.ai/docs/token-counting): count-only operation and multimodal counting.
- [Meta Responses](https://dev.meta.ai/docs/protocols/responses): stored-response retrieval and stateless mode.
- [Node 24 error definitions](https://nodejs.org/docs/latest-v24.x/api/errors.html#common-system-errors): address lookup/refusal versus reset and generic connect-or-send timeout.
- [Undici error definitions](https://undici.nodejs.org/api/Errors): connection-establishment, response-header and response-body timeouts, plus stable error codes across bundled versions.

## Offline validation

Tests retain exact bodies across safe count retries, check retry caps/headers, forbid ambiguous generation retries, prove one reservation for a safe pre-connect recovery and retain one unknown charge after an uncertain failure. Stop/abort during backoff prevents the next attempt. Real local Node requests prove a refused connection can reconnect with only one accepted HTTP request; a local redirect check proves the second address is never followed. Malformed output, role limits and original-image tests remain in the required full check. Deliberate guard removals must turn these checks red before publication, with exact restoration.
