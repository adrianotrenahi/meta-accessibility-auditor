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

- a recorded price, choice or other change between screens (the latest two comparisons);
- a control Tab never reached (`keyboard_reach/1` with `reached: false`, latest two).

Tab steps, earlier pages and comparisons that recorded no change are not sent as
pictures. The walk's actions and notes still reach the analyst as text, and the reviewer
still reads every claim with its own original pictures. On the 30 October Booking.com
audit this means 2 pictures for the home page and 1 for the Flights page, instead of 2
and 3.

## Still pending

A live public-site run with these changes has not been made yet; it needs the owner's
spending approval.
