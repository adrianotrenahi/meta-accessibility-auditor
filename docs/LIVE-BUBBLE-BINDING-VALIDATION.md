# Reviewed original pictures in the live view

28 October 2026. This change is stacked above the reviewed Day 4 engine proposal. It does not merge that proposal or activate a customer engine.

## Impact on the system

The paid Day 4 record exposed two identical original pictures with different references: the finding used the earlier picture, while a later measurement captured the same page again. Selecting only the newest original prevented a matching finding pin even though both pictures and full page states agreed.

Live sampling now prefers an accepted finding's original among the exact matches. Eligible originals must belong to the same run, come from the browser, retain their intact saved record, be stable, and match the sampled PNG bytes, dimensions and full page state before and after sampling. A preferred finding cannot bypass any of those conditions. If no accepted original matches, the existing latest-match behavior remains; if nothing matches, the picture has no evidence reference.

The finding stays attached to its original. Neither original record, screenshot nor claim is rewritten. Live pictures remain fresh samples, with the same request sharing and quarter-second sampling limit. Selection reads the currently accepted findings rather than retaining an approval across later evidence changes. It creates no evidence or model requests and changes no action, image, token or spending allowance.

Validation:

- `npm run check`: **231 tests passed**, including the TypeScript check. `npm run build` passed.
- The real Chromium regression creates an original, a source-bound saved example and a later identical capture. The live picture selects the reviewed original while both records and image files remain distinct and unchanged.
- The same real-browser test changes only the button's accessible name. Pixels stay identical, but the evidence reference disappears. Restoring the original state restores the valid match; withdrawing the example restores ordinary latest-match behavior. The test makes zero model or native-reader requests.
- Unit cases reject changed record integrity, foreign runs, non-browser authors, different pixels/state/dimensions and unstable originals despite a preference. Existing concurrent-read, close and invisible-state guards still pass.
- The complete private Cavioo offline proof passes at 1440px and 320px using its existing setup, live canvas, pins, report and original viewer. Reload/reconnect, hidden tabs, access refusal, malformed/slow optional details, discard, accessibility scans and overflow checks pass with **zero model calls**. These are explicitly saved-response examples.
- Selecting accepted findings on the retained 158-record controlled run took a median **5.2ms**, maximum **13.3ms** across twenty read-only measurements, versus the existing 250ms sample spacing. This measures that selection work only; it is not large-site or end-to-end performance proof.
- Isolated removal of the reviewed-original preference, or removal of the full-state comparison, makes the real-browser regression fail. Working files remain unchanged. Evidence: `/private/tmp/meta-frame-binding-break-proof.json`.

Local evidence: `/private/tmp/meta-live-binding-full-check.log`, `/private/tmp/meta-live-binding-build.log`, `/private/tmp/meta-live-binding-cavioo-proof/`, and `/private/tmp/meta-live-binding-source-timing.json`.

## Impact on the UX

Cavioo keeps the same browser, pin, bubble and report components and layout. For example, an identical measurement picture can no longer hide the already reviewed Add-button finding merely because it received a newer original reference. An invisible accessible-name change still withholds that pin even when the picture looks unchanged.

## Still pending

- Codex/reviewers: complete the required external reviews and any confirmed correction verification. Adriano decides when these changes merge. Retarget this stacked proposal to `main` before its parent merges, following the existing merge rules.
- Codex: prove the changed behavior with actual model-driven active bubbles at both widths. The existing paid run was generated before this change; these new tests are offline and establish no new model response or general quality percentage.
- Codex: complete safe grouping of one supported issue across before/after screens without losing its original occurrences or merging distinct controls. The current historical report still has two cards.
- Broader customer-flow/performance, native-reader/human comparison, labels, decoded SAM masks, final report reconciliation and recording/submission remain in the main build plan and existing proof tickets.

This slice spends **$0 additional Meta/Baseten credits**. Recorded Meta usage remains an estimated **$5.291118 of $150**, pending Billing reconciliation.
