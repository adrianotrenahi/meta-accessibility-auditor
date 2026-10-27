# Cavioo compatibility

Required direction, 27 October 2026. Build a fresh audit engine that works behind Cavioo's existing experience. Keep the current audit setup, visible browser, finding bubbles and final report with screenshots for every captured screen. Use the actual Cavioo components in the private app, including its typography, colours, spacing, icons, focus behaviour and responsive layout. A similar-looking replacement is not component reuse.

The current standalone interface is an engineering test harness, not an approved new product design. Implementation work is paused while this direction is recorded. The connection described below is planned, not working proof.

## Impact on the system

The new engine owns navigation, original evidence, keyboard and VoiceOver checks, analysis, SAM and accepted-only review. A connector translates its records into the formats Cavioo already uses. Cavioo continues to supply the existing product flow, workspace permissions, visual components and report readers. This does not require copying Cavioo's worker, private prompts or criterion wording into the fresh public engine.

| Existing experience | Parts to reuse in Cavioo | New work to supply |
| --- | --- | --- |
| Audit setup and progress | Existing audit funnel, top bar and progress components | Validated goal/settings, progress and task states |
| Browser during the run | Existing live-browser frame and frame delivery | Current URL, real live frames, dimensions and connection state; saved screenshots remain separate evidence |
| Screens visited | Existing screen strip and screenshot frames | Ordered screen records with stable identity and their original screenshots |
| Finding bubbles | Existing finding pins, cards and annotation canvas where applicable | Accepted claim, exact screen/capture identity and correctly transformed element coordinates |
| Final report and evidence | Existing report, finding details and full-screen screenshot viewer | Compatible report records, accepted findings and original screenshots for every captured screen |

The private integration plan maps these roles to the actual existing components. Their presence does not establish that the new engine already drives them. Compose the existing parts inside the existing layout; add only the necessary connection code and supported extensions.

The connector must handle:

- **Start:** accept the existing goal, URL and supported audit settings. Validate unsupported inputs before starting, through existing feedback patterns. Do not silently ignore settings or add an engine-selection step to the customer funnel.
- **Identity:** keep a durable mapping between the engine run, Cavioo job/session, screen, capture, finding and review version. Replayed events must update the same items rather than create duplicates.
- **Live browser and screenshots:** supply actual frame delivery for the existing browser view. After-action screenshots alone are not a continuous browser stream. Preserve viewport, original image dimensions, scroll and capture identity so zoomed pins and SAM outlines stay on the right element.
- **Findings:** publish only the accepted exact claim version. Map supported fields into Cavioo's existing finding readers; preserve evidence, uncertainty, severity, grouping, visibility and withdrawals separately. Do not invent a second customer-facing finding model.
- **Controls:** preserve Cavioo's own finish, discard, pause/resume and reconnect meanings. In particular, its confirmed discard removes the linked run's findings, screenshots and engine evidence; it must not be connected directly to the prototype's evidence-preserving Stop. Do not retain a hidden original-evidence archive after promising deletion. Preserve originals for retained runs, and stop in-flight work before applying discard. A partial run must remain visibly incomplete. Unsupported capabilities need explicit existing states rather than apparently working controls.
- **Report and scoring:** preserve report structure, screen ordering, screenshots, filters, details and permissions. Version the new method and fifteen-criterion scope. Only map criteria with explicitly equivalent meaning; do not present a partial new audit as full Cavioo coverage or turn unassessed checks into a pass or zero score.
- **Access and spending:** keep keys in the engine service, and enforce Cavioo workspace access through the host. Ordinary report reads and reconnects never start paid work. Production account, billing and audit settings are not changed by this plan.

## Impact on the UX

A customer starts an audit through the same Cavioo funnel, watches the website in the same browser layout, sees reviewed bubbles using the same pin/card styling and opens the same report. For example, a finding about an unnamed Add to basket button opens that exact product screenshot in Cavioo's existing evidence viewer. It does not open a separate Access Walk report.

The public repository must hold the new engine, compatible connector interfaces, tests and controlled examples as they are implemented. The first versioned saved-record export and controlled compatibility fixtures now exist. The private host proof consumes them through actual Cavioo components; it does not yet connect production jobs or the setup funnel. Cavioo's pre-existing components remain private and are imported by the Cavioo host. Standalone proofs must run without Cavioo credentials, source or production-service calls. The video and submission identify the existing Cavioo interface and components as prior work, and the new engine and integration as event work.

## Still pending

- **Codex:** document and implement the connector against Cavioo's current progress, browser-frame and report formats before further interface construction. The existing public harness is not compatibility proof.
- **Codex:** prove setup → visible browser → accepted bubble → report → correct original screenshot in Cavioo's development app using saved records and the actual components, with no model spending.
- **Codex:** compare desktop and 320px views with the existing layout; verify image fitting, pin positions, keyboard/focus behaviour, loading, partial and failed states, duplicate/out-of-order delivery, reconnects and discarded runs. Real VoiceOver proof remains outstanding.
- **Codex:** preserve the shared original-record architecture and fix the recorded evidence-size, duplication, visual wording and missing-target gaps. The connector must not hide those problems.
- **Adriano:** inspect the unchanged Cavioo experience after the development proof. Production wiring or activation remains a separate reviewed change; another paid run needs new bounded approval. The $150 allowance and $3 run ceiling are unchanged.


## First offline proof on 27 October

The compatibility plan is merged. Coding resumed with `access-walk/host-v1`, a
strict saved-record export and ordered replay fixtures. The private reader maps
those records to existing progress, screen and finding readers; the private proof
imports the actual browser, pin, bubble, screen strip, report and screenshot viewer.
It does not copy their code into this repository.

The proof uses seven original captures from six real keyboard actions on the
controlled shop, one saved accepted finding and intermediate states where the
review becomes stale and the finding disappears. Desktop and 320px checks cover
exact pin geometry, keyboard bubble opening, stale-review withdrawal, no shop pin
on the basket, an unscored report, explicit incomplete assessment and the correct
original image. Repeated/out-of-order delivery and changed originals are tested
at the host boundary. Original PNG bytes/dimensions are checked by the private
fixture host. No model calls, credit spend, production calls or database writes
are involved. The private proof's phone bubble is placed outside the frame's
clipping boundary while reusing the existing finding component.

This is presentation compatibility for saved records. Real setup → job dispatch,
authenticated access, continuous browser frames, customer controls, confirmed
discard and cleanup, production persistence, full scoring and native-reader report
objects remain unimplemented/unproved. The private wrapper's proof controls and
local framework shims do not establish the full authenticated product flow or
full-page visual identity. VoiceOver, SAM, model quality and publication timing
require their own evidence; a replay does not establish any of them. The green
standalone viewer remains an engineering harness.


Saved-state delivery has a durable revision that advances for run state and
spending changes even when no new evidence record is added. An unreadable or
rewritten original is marked unavailable; only claims that depend on it are
withheld, and unrelated intact originals remain readable. Originals keep their
identity when availability changes. The controlled proof uses a temporary local
store; `npm run proof:host -- --port 4341` selects a different free port if needed.
