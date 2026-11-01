# Analysis track and strip screens

Owner decisions, 30 October 2026, after a Booking.com audit stood still for minutes on
its home page.

## The robot keeps walking while screens are checked

The robot and the analysis run on separate tracks. When the robot finishes an instruction
(or every third decision in a walk with no plan), it scans the page, reads its journey
context and hands the screenshot to the analysis track. It then decides its next step at
once. The analyst and reviewer check handed-over screens one at a time, in the order they
were reached (`src/analysis-track.ts`).

- **The track never touches the browser.** It reads saved originals only. A focused check
  the analyst asks for (for example, Tab to a control) is handed back to the robot, which
  performs it between its own steps only if the page still matches that screenshot;
  otherwise it is saved as not tested, with no input sent.
- **Each check reads the walk as it stood at hand-over.** Later robot steps, notes,
  screen-reader results and limits never become evidence for an earlier screen
  (`requestEvidence(..., throughSeq)` and `Store.snapshot(..., walkThroughSeq)`). Claims and
  proposals are still read in full.
- **Failures.** A hard failure on the track stops the robot at its next step, as it did
  inline; at most the decision already under way finishes first. A hard failure of the walk
  cancels the track: no waiting screen starts a paid check, and the check in progress starts
  no reviewer or pinpointing request (its request already in flight finishes and is kept). A dropped connection
  leaves that checkpoint unknown and never makes the robot refresh or wait.
- **End of the walk.** Every handed-over screen is checked before the final checkpoint and
  the final review. Stop and abort still end the run; no new paid request starts after them.
- **Money.** The navigator and the analysis track may each have one request in flight in
  the same run. Every in-flight charge is held before sending, so the run, phase and
  project limits still hold. Another run's request still blocks.

## The analyst reads the screens on the strip

Each analyst request now carries only the screens a customer sees on the strip:

- the screen being checked;
- after an input on that same page that is not a Tab move, the screen just before it (the
  cookie pop-up before it was dismissed).

Two exceptions add earlier pictures:

- a recorded price, choice or other change between screens (the latest two comparisons).
  Owner, 31 October ("those are different screens"): moving to another page is not a change
  by itself, and a choice that exists on only one of the two pages is not either. A change is
  a real price comparison, a price that appeared, disappeared or differs, a choice present on
  both screens whose state differs, or anything that cannot be read cleanly;
- a control Tab never reached (`keyboard_reach/1` with `reached: false`, latest two). Since 1 November a Tab walk keeps going until it reaches the control or focus returns to a control it already visited (a full loop, up to 300 presses; each press records where focus landed, not a screenshot, unless the page changes), and an arrow walk tries up to 62 presses. The evidence also includes a try that ran out of its presses without reaching the control (`fullCycle: false`, with `keysPressed`), not only one where focus went round the whole page; it is not keyboard-failure evidence, since the control may be reachable with more presses: the analyst may report at most a minor, criterion-free finding stating the measured fact ("focus did not reach Departure after 24 Tab presses") and must not settle C05 from it; only a full cycle supports a C05 failure. A Tab walk compares each step with the one before it, so promotions that keep rotating (eDreams' banner behind the search form) no longer stop it before its full loop, and the next key after a focus note is no longer refused for such a swap, while a popup, a new page or a changed target still stops it (owner, 1 November; on eDreams the full loop now completes, 90 Tabs in about a minute). Two such Tab tries in a row end navigation, as two full cycles do (an arrow-key try that runs out is saved and counts too: "we should not miss anything") (owner, 1 November: eDreams' date field spent the whole step retrying).

Tab steps, earlier pages and comparisons that recorded no change are not sent as
pictures. The walk's actions and notes still reach the analyst as text, and the reviewer
still reads every claim with its own original pictures. On the 30 October Booking.com
audit this means 2 pictures for the home page and 1 for the Flights page, instead of 2
and 3.

## Still pending

A live public-site run with these changes has not been made yet; it needs the owner's
spending approval.

## Tab steps save focus notes, not screenshots

Owner decision, 31 October 2026: on Booking.com each Tab press took a full screenshot
(about 7 seconds each, 16 presses = 108 seconds), and none of those pictures reached the
strip.

- **Tab and Shift+Tab** now save where focus landed (`keyboard_focus/1`) and take a real
  screenshot only when the screen visibly changes, on pages with prices or choices too,
  whenever their prices and choices were read cleanly.
- **Prices and choices are read as text after each Tab** on such pages. If they differ from
  the last real screenshot, or cannot be read, a screenshot is taken. Within a run of Tabs
  there is no picture of the moment before, so the change is saved as an unconfirmed
  `tab_price_change/1` note with the before and after prices; it never counts as a price
  comparison (C11 stays unknown for it).
- **Pages that do not declare all their prices and choices** (Booking.com) save one
  `tab_prices_unread/1` note per page address: price changes during its Tab steps were not
  checked. The strict path could not read those prices either.
- **Pages that declare every price and choice** (the controlled shops) keep the strict
  before/after screenshots for Tab, so a price result there can still be proved.
- **A Tab from a real screenshot that changes the screen** keeps the full price and choice
  comparison, as before.
- **Space, Enter, typing and every other input** keep their before-and-after screenshots,
  because they can change a choice.
