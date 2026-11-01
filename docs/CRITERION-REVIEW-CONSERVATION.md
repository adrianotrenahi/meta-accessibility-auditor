# Keep criterion proposals available after a focused check

## Impact on the system

A focused check can take a new picture after the analyst proposes a criterion result. Previously, independent review selected the current picture and existing findings first. A criterion proposal was included only when all its original pictures were already selected. With no findings, the new picture could silently exclude every earlier criterion proposal.

The reviewer now receives every criterion proposal still owed a review, with its complete original evidence, including earlier pictures (owner, 1 November: the earlier limit of the five newest also counted proposals already judged, so on a Booking.com audit a proposal was left unreviewed 43 times). A proposal that already has a review keeps it, and one replaced by a newer proposal for the same check is not sent, because the report reads only the newest. Current-screen and existing-finding evidence stays mandatory. Optional criterion evidence cannot displace it or take a request above the existing 50-picture bound. The existing information, output, request-count and spending checks still apply; including more evidence does not promise that a request can be afforded or completed.

Before adding an earlier picture, selection checks its stored bytes, the exact proposal and its sources against the analyst's saved read. An earlier source rewritten with a fresh valid hash still cannot replace the version the analyst read. Missing, changed or unstable optional evidence leaves that proposal unassessed while intact findings remain reviewable.

Each excluded proposal receives a saved reason identifying the exact proposal and checkpoint: unavailable originals, the picture bound, or the batch of 60 newest owed proposals one review can answer (older owed proposals stay for the next checkpoint or the final review). A supplied proposal the reviewer returns no decision for gets a `criterion_review_missing` record and is offered again. This is a record of selection at that checkpoint, not a criterion decision. Newer valid selections can still reconsider the unchanged proposal. The engine creates no automatic review, pass, finding or score.

## Impact on the UX

For example, an analyst can assess the name of an Add button, then request a keyboard check that takes another picture. Independent review now receives the earlier Add-button picture, its original measurement and the exact proposed result alongside the new picture. A review of the earlier screen does not settle any of the new screen's checks.

No component, layout, image treatment, customer default or host delivery field changes.

## Validation

The new recapture check fails on the previous selection because its exact criterion proposal is missing. It passes after the correction. Controlled saved responses separately prove supported, unresolved and empty review outcomes through the actual runner and report reader. Reopening the saved run keeps the same report. Only the independently supported original check can settle; the new screen and overall score remain incomplete. No browser input or provider request is performed by these controls.

Further controls cover complete source chains, matching saved read lists, the 60-proposal batch and the 50-picture limit, preservation of mandatory findings, damaged or missing records and images, and exact image restoration. Original records are not rewritten. Deliberate removals of the selection, source-version check and image check must fail their corresponding controls before restoration.

Read-only investigation of two retained real runs reproduced all four historical reviewer selections with zero criterion proposals. Separate temporary copies using the correction select five exact proposals per checkpoint and supply two or three original pictures. The later checkpoint explicitly leaves five older proposals unassessed under the unchanged bound. All original record and request rows remain unchanged. Their original empty reviewer outputs remain empty, all 150 and 255 required checks remain incomplete, and neither original report gains a score.

## Still pending

An actual model review on the corrected selection is not established by these offline controls. The existing proof ticket tracks that separately after review and owner-approved merge, with any paid check separately bounded by the owner. Human finding quality, full public task completion, actual model-generated bubbles/grouping and native screen-reader proof remain separate work.
