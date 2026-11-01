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
Start, `running`. Planning keeps its charge in that run and the per-audit spending
ceiling. The navigator's decisions are counted per journey step (owner, 31 October):
24 per step, or 32 once the step's page shows a form (somewhere to type, pick a date
or choose an option). The audit-wide limits are 45 minutes and 600 key presses, with
the approved spending ceiling as the money limit. A repeated draft
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
and its observable success condition. Of the walk itself it reads the plan, every
finished step and its recent decisions, each with its key presses,
notes and limits; earlier presses made every decision slower (owner, 31 October: 6 s growing
to 12 s per decision on Booking.com). Analysis and review still read the whole walk.
The recent decisions move in blocks of eight, so the navigator reads the latest 8 to 15 and
each request opens exactly like the previous one for up to eight decisions (owner, 1 November).
Meta reuses an identical opening and bills it at its cached rate ($0.002 instead of $0.10 per
million on Contributor mode); each request carries a `prompt_cache_key` naming its role and
audit so related requests reach the same cache, and the recorded charge uses the cached rate
Meta reports.
A key press that arrives with a stray step or screenshot label is still that key
press; those labels count only on `step_done`. A `step_done` that names no
screenshot means the current one, the only one the navigator sees; the freshness
check still runs before the step is recorded. Any other answer that breaks the
decision rules is not acted on: a `navigator_answer_refused` limit says why, and
the navigator is asked again within its usual allowance. Three refused answers in
a row stop navigation (owner, 31 October). A page slow to become readable after an
input is read again for up to 90 seconds, counted from the first read that ran out of time
(a `slow_page_wait` limit says so; nothing is pressed again), and each screenshot may take
20 seconds instead of the browser's usual 8 (owner, 1 November: the first read of Booking.com's
results page alone used up the earlier 30 seconds). When the page becomes readable, a
`slow_page_readable` note saves how long it really took. If it is still unreadable, navigation
stops cleanly with a `navigation_limit`, like the key-press limit, and what was reached is
still checked and reviewed (owner, 31 October: Booking.com's results page after Search). A `step_done` answer names that instruction
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

The automatic page scan runs once per page (owner, 31 October): a later step on a
page already measured, meaning the same address without its query or fragment,
saves a `page_scan_reused/1` note pointing at the earlier scan instead of waiting
for another one. Booking.com's home page took 12 s per scan. The navigator also
reads each screenshot's page structure without the separate copy of its visible
text, which the structure already holds; analysis and review still read both.
Each screenshot lists up to 500 visible controls (was 60), read in one pass so a
Booking.com screenshot still takes about 2 s with 261 controls. The navigator's
copy of each control keeps its id, role, name, words, kind, state and box, and
leaves out the internal page address and fingerprints only the engine uses.

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

## The browser a real-website audit uses

Real-website audits run in the installed Google Chrome app, hidden, with Chrome's
"controlled by automated software" signal switched off and its own name without
the hidden-window word (owner, 31 October). The audit is meant to read the page a
real visitor gets; a site that serves robots a different page, or refuses them,
would otherwise be audited on the wrong page. Playwright's own Chromium is the
fallback when Chrome is not installed. Nothing else about the visit changes: the
robot still uses only the keyboard, never books, pays or signs in, and takes no
data. It does not route through rented addresses or solve "prove you're human"
checks. The controlled shop keeps Playwright's test browsers.

Findings and the strip also show every screenshot that proved a finished journey
step, marked as not analysed when Meta's analysis of it never came back, so a
failed analysis no longer hides how far the robot got (owner, 31 October).

The robot's typing guard (it types only a short search term into a search box, never
personal, account or payment details) refusing an input no longer ends the audit: an
`input_refused` limit records why, nothing is typed, and the navigator is asked again;
three refused inputs in a row stop navigation. The navigator is told that date
pickers, day and month selectors, dropdowns and option lists are chosen with the arrow
keys and Enter or Space, not typed into (owner, 31 October). Each navigator decision
is one request to Meta: audits estimate its size locally and generously instead of
asking Meta first; the estimate counts text bytes (very likely an upper bound), asks Meta when it looks too big, and records a `reservation_exceeded` warning if a charge ever exceeds what was set aside.

One navigator decision can choose an option in any website's ordinary dropdown
(`choose_option` with the option's exact text, after `focus_target` has reached the
dropdown), for example a day or month of travel, a country or a size (owner,
31 October). On a Mac the arrow keys open a closed dropdown instead of stepping
through it, so the robot presses the option's first character; each press moves to
the next option starting with it, and the robot checks after every press and stops on
the wanted one. Every press is a counted keyboard input; nothing is typed into a text
box. An option the dropdown does not offer, or no focused dropdown, is a refused input:
nothing is pressed and the navigator is asked again.

The analyst checks every screen that goes to the strip and the reviewer reviews each
check (owner, 31 October). Their request counts are only backstops (60 and 61, with
one final review always kept back); the audit's money shares remain the real limit.
