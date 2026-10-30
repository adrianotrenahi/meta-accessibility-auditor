# An approved journey, one instruction at a time

## Impact on the system

The local public-website host prepares a structured Meta proposal before Start.
For a return-flight brief, the proposed instructions can separate reaching the
search, entering the supplied route, entering dates and checking usable results.
The exact returned steps are retained; a missing or invalid answer never becomes
the old two-row “open the site / follow the brief” substitute.

`POST /api/host/journey-plans` takes a durable draft identity, an opaque owner
fingerprint and the original URL and goal. New drafts still require a checked
public destination and a current bounded approval. The planner uses one request
from the existing driver allowance, without visiting the website or supplying
images. A proposal is intended work, not observed site information.

The same saved run moves through `planning`, `prepared` and, only on explicit
Start, `running`. Planning keeps its charge in that run. It does not reset the
existing total, per-run or twenty-request driver ceilings. Starting after planning
therefore leaves at most nineteen further driver requests. A repeated draft
reads the same result or uncertainty; it never silently generates again.
If only the input-count request failed and no generation was ever sent or
reserved, an explicit same-draft retry may resume preparation with current
approval. It keeps the same run and failed records. A sent or uncertain generation
and an owner-stopped proposal cannot use that recovery path.

Start names the exact saved proposal and owner. Owner edits, removals or changes
of order are saved in a separate approved execution plan. The generated proposal
and its completed response remain unchanged. A changed brief needs a new draft;
a changed Start retry is refused. Existing direct host clients and retained older
runs keep their former behavior.
An owner-added instruction may contain only its identity and text, matching the
existing editor. Missing intent or success metadata is not invented. Generated
proposals still require both; an owner-written instruction without a separate
condition must have its requested visible outcome before completion is recorded.
Completion keeps accepted step identities verbatim.
Reading a proposal after Start returns `started` and the actual saved run state,
instead of labelling that used proposal a failed preparation. It starts no work.
If Start fails after that saved request is accepted, the host records an ended
partial attempt and returns its stable run identity. Its report and Discard stay
available; the same Start never launches again. Only that attempt's browser may
be stopped during cleanup. Owner-authenticated deletion does not require a damaged
proposal or receipt to pass execution checks, while owner/brief checks, physical
cleanup and charge preservation remain mandatory.

The navigator receives the original shared records plus one current instruction
and its observable success condition. A `step_done` answer names that instruction
and the current stable original capture. The engine checks freshness and approved
order before recording completion. This is a navigator claim, not an independent
accessibility pass or proof of usable search results. An unfinished instruction
prevents a whole-journey finish claim. For ordered journeys, analysis checkpoints
follow completed tasks and the end of the walk, rather than interrupting every
three decisions while a dialog is being handled.

A checkpoint on the exact screenshot that was already scanned or checked, with no
new screenshot, input or observation since (apart from the check's own settled
reading of that screenshot's journey context), reuses that scan and records a
`repeat_checkpoint/1` coverage note instead of sending the same screenshot to the
analyst and reviewer again (owner, 30 October). Two instructions finished on one
Booking.com home page otherwise spent the analyst's whole allowance on the same
picture, leaving the next page unanalysed. Any new evidence brings a full check
back; the final review still runs.

The optional `ordered-journey-progress/1` host reply carries the exact approved
steps and completion records, bound to the original captures. Readers reject
unverified progress while retaining independently valid screenshots and findings.
The core `access-walk/host-v1` contract and uncertainty remain intact.

Stop retains the attempt and any known or uncertain charge. A confirmed discard
waits for planning to settle and removes the proposal from every list; its
records and raw files are kept in `.discarded/` for investigation.
Failed physical cleanup remains pending and retryable; it is not reported as
successful deletion. Restart recovery never starts a prepared
journey or regenerates an interrupted proposal by itself.

## Impact on the UX

The private host keeps the existing setup, editable plan, browser view, finding
bubbles, Audits list and report components. It replaces placeholder plan rows with
the actual proposed instructions and shows recorded progress for the exact steps
approved by the owner. For example, the route instruction can be recorded complete
while the date instruction remains unfinished; neither state supplies a criterion
pass. A stopped unfinished instruction remains incomplete.

Private components, browser code, prompts, data and credentials are not copied
into this public repository. Cavioo behavior was consulted privately as a design
reference; the public planning and execution code was written for this engine.

## Still pending

- The offline checks use synthetic returned plans and controlled browser pages.
  They establish lifecycle, evidence and connection behavior, not Meta planning
  quality or completion of Booking.com.
- One separately authorised bounded real run must check useful generated steps,
  actual one-instruction progress, meaningful screen capture and usable results
  with the requested route and dates. It must stop before selection or booking.
- Customer dispatch, billing, wider native-reader acceptance, human finding
  quality and the submission video retain their separate outstanding scope.
