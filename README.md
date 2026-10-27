# Access Walk

A fresh Meta hackathon project that investigates barriers to completing website tasks with keyboards and screen readers. Access Walk is a working name.

The product target is a new walk that plugs into Cavioo's existing audit flow and keeps its current visuals: the browser during the run, finding bubbles, then the existing report with each screen's screenshots. Reuse the actual Cavioo components inside the private Cavioo app. The green standalone interface below is an engineering test harness. Saved-record presentation compatibility is now proved in the private Cavioo host; the setup funnel, live transport and production integration remain pending. See [Cavioo compatibility](docs/CAVIOO-COMPATIBILITY.md). The public engine remains independently runnable and contains no pre-existing Cavioo source.

The application saves one original walk, navigator notes, page images, measurements and screen-reader records. Analysis and review read that same evidence independently. Only reviewed findings reach the viewer.

## What works now

- A controlled shop built during the event, with clean and deliberately broken button and dialog examples.
- Real keyboard navigation through product selection, basket and a non-purchasing review dialog, with focus and before/after captures saved.
- Browser accessibility measurements and an evidence viewer at desktop and phone widths.
- A local SQLite record store, original-record retrieval, saved read manifests, exact-candidate reviews and conservative publication rules.
- Separate Muse Spark driver, analyst and reviewer connections; SAM 3.1 request construction, source-bound geometry parsing and within-run reuse.
- Spending reservations, request/phase/run limits, interrupted-run recovery, ordered events and replay without new model calls.
- A connection to real VoiceOver through Guidepup. Its native key-control proof is currently incomplete on this Mac; it is not presented as a successful screen-reader test.

The saved demonstration uses newly written deterministic analysis/review examples. Its browser actions and measurements are real; its responses are not claimed to come from Meta models. One separately approved live test used actual Spark responses and reached the basket, then stopped before the review form at the evidence input limit. Its usage-based cost estimate is $0.3145 against a $3 ceiling. Duplicate findings and overly absolute visual wording remain quality problems. See [the first paid test](docs/FIRST-PAID-TEST.md). Live launch remains disabled in the interface and command-line script.

## Run locally

Use Node.js 24 or later.

```sh
npm ci
npx playwright install webkit chromium
npm run dev
```

Open http://127.0.0.1:4317. Choose **Start saved demo**. It opens the controlled shop in a visible browser. Reopening a run or reading its evidence never starts another run.

```sh
npm run check
npm run build
npm run preflight
npm run proof:browser
npm run proof:browser -- --ui
npm run proof:browser -- --safety
```

The viewer check requires `npm run dev` in another terminal. These commands spend no model credits. The safety check uses only controlled local forms and verifies that unsafe activation and stale sources are refused. Screenshots and detailed local proof records are written to ignored `output/` and `data/` folders.

## Real VoiceOver

Actual VoiceOver testing requires macOS, a visible supported browser and an unlocked desktop. The first browser pairing is Playwright WebKit; this is recorded as WebKit, not claimed to be Safari. WebKit keyboard navigation uses Option-Tab when links are omitted by the default Tab setting.

Enable **Allow VoiceOver to be controlled with AppleScript** in VoiceOver Utility and grant the normal macOS Accessibility and Automation permissions to the process running the tests. Download the matching testing assets, without running automatic system-security configuration:

```sh
npx @guidepup/setup@0.29.3 install voiceover
npm run proof:voiceover
```

The test captures actual spoken phrases separately from visited-item text and attempts a known safe action on our local shop. Unknown or missing output remains inconclusive. Cleanup attempts to restore the test reader's settings and previous enabled state, recording a failure if that cannot finish. This restoration is not yet proven by a successful native run. In-run checks are bounded to two checkpoints; they do not establish that every screen-reader task or browser works.

Latest local limit: System Events timed out while the test tried to send keys (`AppleEvent timed out`, -1712). The control checkbox and assets are present, but actual key operation and reliable speech capture have not passed. Access to System Settings through computer control was refused, so the remaining system permission/state needs inspection before this proof can be completed. No security restrictions were disabled.

## Paid testing stays off

Put a future Meta API key only in private `.env` as `META_API_KEY=…`; `MODEL_API_KEY` is also recognised. Never commit keys, run records or provider responses. Adding a key alone does not authorise spending.

The owner approved **one paid test**, which is now finished. Its temporary `spend-approval.json` was removed and further paid runs require new approval. Live launch is refused by the interface and command-line script. The model client additionally requires a valid, expiring owner approval and reserves each bounded request before sending it.

The planned limits remain $3 per run, $110 routine project spend and $40 held back from the $150 Meta allowance. Spark uses Standard mode. Unknown charges retain their reservation. No application credentials, database or code from Cavioo are used.

## Scope and remaining proof

Day 1–2 code can be checked offline. One actual Spark run established six keyboard actions and analysis/review calls, with a partial journey result. Model accuracy, complete journeys, two-of-three consistency and real SAM matching have not been established. Full criterion coverage, polished live bubbles, SAM mask rendering, complete report reconciliation and the final video belong to later days. An automatic accessibility scan is not a screen-reader test or a compliance certificate.

The twelve-case evaluation set is a draft for owner review. Offline code tests establish record, limit and publication behaviour; they do not establish model accuracy or represent the experiences of all disabled people.

## Prior work and public submission

Cavioo existed before this event. This repository contains newly written hackathon work and open-source dependencies. Cavioo source, private prompts, criterion wording, production data and services are excluded. The controlled shop and test examples were written for this project. The video must distinguish prior work from the new contribution.

Keep every change on a branch and reviewed through a pull request. Do not merge without Adriano's instruction. Never run paid tests just because a key exists. Preserve original evidence, record uncertainty and keep robot limitations separate from website defects.

## References

- [Meta Responses API](https://dev.meta.ai/docs/protocols/responses)
- [Meta input-token counting](https://dev.meta.ai/docs/token-counting)
- [Meta SAM segmentation format](https://dev.meta.ai/docs/sam/reading-segmentation)
- [Guidepup real VoiceOver testing](https://www.guidepup.dev/docs/screen-reader-testing/testing-voiceover)
- [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing)

Third-party dependencies retain their own licences. No licence for the newly written application has been chosen yet.


## Saved host records

`npm run proof:host` generates `fixtures/host-proof`: seven real controlled-browser
captures, six keyboard actions, eight ordered host snapshots and a saved analyst/
reviewer example. It makes zero model requests and spends $0. The export uses
`access-walk/host-v1`, includes only currently accepted exact claim versions, and
preserves original image fingerprints, dimensions and source anchors. A later
withdrawal removes a finding; stale replay cannot restore it. It intentionally
carries no complete Cavioo score or VoiceOver/SAM completion claim.

A separate private host proof imports Cavioo's actual browser, pin/bubble, report
and screenshot-viewer components at desktop and 320px. Cavioo's source remains
private. This public fixture is independently runnable and includes only this
project's controlled pages and newly written saved-response examples. Recorded
captures are not proof of a live video stream, model accuracy or production
integration. See [compatibility scope](docs/CAVIOO-COMPATIBILITY.md).


## Controlled host run interface

`npm run serve:host -- --data /absolute/path/to/dedicated-local-records` starts a
local, offline-only host surface without the standalone viewer. It prints its
loopback address. A host obtains the local session token and uses `GET /api/host`
for the supported controlled URL/goal/capabilities. Requests to `/api/host/runs`
start only the fixed Desktop keyboard example and require a stable request UUID.
Repeated starts reuse the same run; a discarded start cannot be resurrected.
Read snapshots and original PNGs through the run's host routes, advance only a
matching saved revision, or use separate Stop and Discard actions. Stop retains
evidence; confirmed discard waits for cleanup and removes the run and originals.
Minimal incurred/uncertain cost records remain so deletion cannot reset the
project spending limit. No action enables paid inference.

Discard status distinguishes requested cleanup from confirmed removal. Failed
record deletion leaves original image files intact; failed file removal keeps an
ID-only cleanup record so a repeated discard can finish it after restart. Completed
start mappings are replaced by minimal discarded-start identifiers.

`npm run proof:host-controls` checks a fresh headless browser walk, source-bound
accepted finding, repeated starts, stale advances, ordinary Stop, confirmed
discard and original-image removal with zero model calls. Native VoiceOver,
per-screen deletion, model accuracy and SAM are not
established by this controlled proof. Provider awards now include Meta's $150 and
Baseten's separately held $100; paid runs still need a new bounded approval.

### Live browser pictures

`GET /api/host/runs/:id/frame` uses the same host token and reads a fresh PNG
from the already-running browser. It returns `access-walk/frame-v1`, run/picture
identity, capture time, dimensions, image fingerprint and pixels. An original
capture ID is supplied only for identical stable original pixels and unchanged
browser state, including its accessible names and focus. Live pictures
are display-only: they create no audit actions, retained images or model calls.
Concurrent readers share work, with at most four screenshots per second. Closing
the browser clears cached pixels and refuses late replies; Stop and Discard end
the live view. The controlled host proof changes the page between picture reads
and confirms live pixels change while the original audit record stays unchanged.

The live view preserves animations. A moving picture that differs from a saved
original intentionally has no original binding, so it cannot carry that pin;
saved report evidence stays available. Full accessibility-state comparisons are
retained for correctness, shared and paced with the picture reads. Large real-site
performance remains outside the controlled proof. Temporary picture failures
return a safe unavailable response; stopped browsers return an ended response.
