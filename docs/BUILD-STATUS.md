# Day 1 and Day 2 status

Updated 27 October 2026. This status distinguishes working code from proof that still needs to happen.

## Impact on the system

The new standalone application contains a local evidence store, original-record retrieval, independent analysis/review connections, an event stream, spending reservations, a controlled browser walk and a VoiceOver connection. Meta calls are disabled under Adriano's overnight instruction. The API key is absent and no spending approval exists.

Fifteen offline tests currently pass. They cover source integrity, candidate/review identity, changed-image rejection, missing/foreign evidence, safe key-file parsing, unknown charges, phase/request limits, protected final review, blocked private destinations, the purchase boundary and SAM geometry handling. The TypeScript check and production interface build pass.

The real controlled browser proof passes both cases. Each takes thirteen recorded browser actions using the recorded Mac WebKit Option-Tab pattern throughout. The clean button has a name and its dialog receives focus; the broken button has no name and its dialog leaves focus outside. These are actual browser observations, without AI calls or a claim about VoiceOver. An earlier inconsistent Tab pattern failed after the browser settings differed; that was corrected as a test-harness condition, not called a site defect.

The native VoiceOver proof has been attempted and remains incomplete: System Events timed out while sending keys. The control flag and matching test assets are present. Computer control was refused access to System Settings. No security control was disabled and no screen-reader pass was manufactured.

## Impact on the UX

A local viewer shows saved runs, original screenshots, page information as text, actual actions and reviewed demonstration findings. An example finding about the unnamed basket button links to its original measurement and page capture. Reloading and reopening evidence make no model calls. Raw candidate accusations are excluded from the viewer.

The real-browser viewer check passes at 1440px and 320px with no accessibility-checker violations or horizontal page overflow. Removing a button's name deliberately makes the checker fail; reloading restores the page. Screenshots and the local proof report are saved outside Git.

The viewer is an early Day 1–2 interface. The complete criterion review, polished live bubbles and SAM mask rendering are later work. Access Walk is a working name.

## Still pending

- **Adriano:** add the Meta API key privately in the morning. Separately decide whether to approve a bounded paid batch; the present instruction remains no spending.
- **Native VoiceOver proof:** the Mac's key-control/Automation state needs inspection before the real test can pass. Codex implements and reruns the proof once control works; the existing checkbox alone is not proof.
- **Day 2 model proof:** actual Spark navigation, two successful journeys in three approved attempts, real SAM element matching, model accuracy and measured provider cost remain untested because paid calls were declined. Codex runs them only after a future approval.
- **Evaluation cases:** the twelve-case set has draft expected labels. Adriano reviews them before model evaluation; only the named-button/dialog pairs have full browser proof so far.
- **Owner choices:** final name, time commitment, real demo site/task, criterion/design details, track/team, participant contribution and launch timing remain undecided. Partner-credit awards remain pending.
- **Later days:** full criterion coverage, richer visual review, final report reconciliation, finished bubbles/mask rendering, independent human validation and the video remain to be built or verified as scheduled.
- **Review and merge:** external review, any validated corrections and the owner's merge decision remain ahead. No application code has been merged or deployed.

Day 1 is therefore substantially implemented with its native VoiceOver proof outstanding. Day 2 connections and offline behaviour are implemented; its model and native-reader completion conditions are not yet met. Total Meta spending: **$0.00**.
