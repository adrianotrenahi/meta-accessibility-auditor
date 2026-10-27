# Cavioo compatibility

Required direction, 27 October 2026. Build a fresh audit engine that works behind Cavioo's existing experience. Keep the current audit setup, visible browser, finding bubbles and final report with screenshots for every captured screen. Use the actual Cavioo components in the private app, including its typography, colours, spacing, icons, focus behaviour and responsive layout. A similar-looking replacement is not component reuse.

The current standalone interface is an engineering test harness, not an approved new product design. Implementation work is paused while this direction is recorded. The connection described below is planned, not working proof.

## Impact on the system

The new engine owns navigation, original evidence, keyboard and VoiceOver checks, analysis, SAM and accepted-only review. A connector translates its records into the formats Cavioo already uses. Cavioo continues to supply the existing product flow, workspace permissions, visual components and report readers. This does not require copying Cavioo's worker, private prompts or criterion wording into the fresh public engine.

| Existing experience | Parts to reuse in Cavioo | New work to supply |
| --- | --- | --- |
| Audit setup and progress | Existing audit funnel, RunProgress, LiveRunTopBar and LiveRunPipeline | Validated goal/settings, progress and task states |
| Browser during the run | LiveRunPreview, CavBrowserFrame and the current browser-frame delivery path | Current URL, real live frames, dimensions and connection state; saved screenshots remain separate evidence |
| Screens visited | LiveRunPagesStrip and CavScreenshotFrame | Ordered screen records with stable identity and their original screenshots |
| Finding bubbles | CavFindingPin, AnnotationPin, AnnotationPostit and the existing annotation canvas where applicable | Accepted claim, exact screen/capture identity and correctly transformed element coordinates |
| Final report and evidence | AuditReportClient, AuditReportView, EvidenceChapter, CavFindingRow, CavFindingCardSection and FullScreenAnnotationViewer | Compatible report records, accepted findings and original screenshots for every captured screen |

These are integration targets identified in the current Cavioo source. Their presence does not establish that the new engine already drives them. Compose the existing parts inside the existing layout; add only the necessary connection code and supported extensions.

The connector must handle:

- **Start:** accept the existing goal, URL and supported audit settings. Validate unsupported inputs before starting, through existing feedback patterns. Do not silently ignore settings or add an engine-selection step to the customer funnel.
- **Identity:** keep a durable mapping between the engine run, Cavioo job/session, screen, capture, finding and review version. Replayed events must update the same items rather than create duplicates.
- **Live browser and screenshots:** supply actual frame delivery for the existing browser view. After-action screenshots alone are not a continuous browser stream. Preserve viewport, original image dimensions, scroll and capture identity so zoomed pins and SAM outlines stay on the right element.
- **Findings:** publish only the accepted exact claim version. Map supported fields into Cavioo's existing finding readers; preserve evidence, uncertainty, severity, grouping, visibility and withdrawals separately. Do not invent a second customer-facing finding model.
- **Controls:** preserve Cavioo's own finish, discard, pause/resume and reconnect meanings. In particular, its discard action removes the run's findings and screenshots; it must not be connected directly to the prototype's evidence-preserving Stop. A partial run must remain visibly incomplete. Unsupported capabilities need explicit existing states rather than apparently working controls.
- **Report and scoring:** preserve report structure, screen ordering, screenshots, filters, details and permissions. Version the new method and fifteen-criterion scope. Only map criteria with explicitly equivalent meaning; do not present a partial new audit as full Cavioo coverage or turn unassessed checks into a pass or zero score.
- **Access and spending:** keep keys in the engine service, and enforce Cavioo workspace access through the host. Ordinary report reads and reconnects never start paid work. Production account, billing and audit settings are not changed by this plan.

## Impact on the UX

A customer starts an audit through the same Cavioo funnel, watches the website in the same browser layout, sees reviewed bubbles using the same pin/card styling and opens the same report. For example, a finding about an unnamed Add to basket button opens that exact product screenshot in Cavioo's existing evidence viewer. It does not open a separate Access Walk report.

The public repository holds the new engine, compatible connector interfaces, tests and controlled examples. Cavioo's pre-existing components remain private and are imported by the Cavioo host. The public engine and connector fixtures must run without Cavioo credentials or source. The video and submission identify the existing Cavioo interface and components as prior work, and the new engine and integration as event work.

## Still pending

- **Codex:** document and implement the connector against Cavioo's current progress, browser-frame and report formats before further interface construction. The existing public harness is not compatibility proof.
- **Codex:** prove setup → visible browser → accepted bubble → report → correct original screenshot in Cavioo's development app using saved records and the actual components, with no model spending.
- **Codex:** compare desktop and 320px views with the existing layout; verify image fitting, pin positions, keyboard/focus behaviour, loading, partial and failed states, duplicate/out-of-order delivery, reconnects and discarded runs. Real VoiceOver proof remains outstanding.
- **Codex:** preserve the shared original-record architecture and fix the recorded evidence-size, duplication, visual wording and missing-target gaps. The connector must not hide those problems.
- **Adriano:** inspect the unchanged Cavioo experience after the development proof. Production wiring or activation remains a separate reviewed change; another paid run needs new bounded approval. The $150 allowance and $3 run ceiling are unchanged.
