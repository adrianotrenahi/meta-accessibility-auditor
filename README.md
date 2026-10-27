# Access Walk

A fresh Meta hackathon project that investigates barriers to completing website tasks with keyboards and screen readers. Access Walk is a working name.

The application saves one original walk, navigator notes, page images, measurements and screen-reader records. Analysis and review read that same evidence independently. Only reviewed findings reach the viewer.

## What works now

- A controlled shop built during the event, with clean and deliberately broken button and dialog examples.
- Real keyboard navigation through product selection, basket and a non-purchasing review dialog, with focus and before/after captures saved.
- Browser accessibility measurements and an evidence viewer at desktop and phone widths.
- A local SQLite record store, original-record retrieval, saved read manifests, exact-candidate reviews and conservative publication rules.
- Separate Muse Spark driver, analyst and reviewer connections; SAM 3.1 request construction, source-bound geometry parsing and within-run reuse.
- Spending reservations, request/phase/run limits, interrupted-run recovery, ordered events and replay without new model calls.
- A connection to real VoiceOver through Guidepup. Its native key-control proof is currently incomplete on this Mac; it is not presented as a successful screen-reader test.

The saved demonstration uses newly written deterministic analysis/review examples. Its browser actions and measurements are real; its responses are not claimed to come from Meta models. No Meta credits have been spent. The live API and interface are deliberately disabled pending a key and a separate bounded owner approval.

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
```

The viewer check requires `npm run dev` in another terminal. These commands spend no model credits. Screenshots and detailed local proof records are written to ignored `output/` and `data/` folders.

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

The owner's current instruction is **no credit spending**. There is no `spend-approval.json`. Live launch is refused by the interface and command-line script. The model client additionally requires a valid, expiring owner approval and reserves each bounded request before sending it.

The planned limits remain $3 per run, $110 routine project spend and $40 held back from the $150 Meta allowance. Spark uses Standard mode. Unknown charges retain their reservation. No application credentials, database or code from Cavioo are used.

## Scope and remaining proof

Day 1–2 code can be checked offline. Actual Spark navigation, model accuracy, two-of-three live journey completion and real SAM matching require separately approved paid tests and have not been established. Full criterion coverage, polished live bubbles, SAM mask rendering, complete report reconciliation and the final video belong to later days. An automatic accessibility scan is not a screen-reader test or a compliance certificate.

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
