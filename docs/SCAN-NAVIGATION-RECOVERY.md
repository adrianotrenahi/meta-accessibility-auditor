# Recovering a scan when the website changes pages

## Impact on the system

A website can reload while its automatic accessibility scan is reading it. For
example, the Booking.com entry can disappear before the scan finishes. The
browser's document-replacement error now enters the existing observation recovery
instead of ending the run with an internal error.

Only the existing, recognised document-replacement errors qualify. Original
capture validation still runs first. A closed page, stopped run, unknown scan
failure or damaged original remains a refusal. Prior input is never repeated.
Recovery retains the old original and reads a fresh state through the existing
bounded capture path. Action, screenshot, time and spending limits stay the same.

## Waiting for reloads, then trying again (owner decision, 30 October)

Before measuring, the robot now waits until the page has stopped loading new
documents for a quiet moment: 2.5 seconds after arriving at a real website,
1 second otherwise, and not at all when nothing loaded recently. It never waits
more than 10 seconds. On Booking.com this lets its robot-check reload
(`?chal_t=…`) finish before the first screenshot and scan.

If the page still reloads during a scan, the robot records that attempt as
unknown, waits, observes the page again and scans again, up to three attempts;
after the third it continues with the check unknown, as before. Clearing banners
and popups gets the same three attempts, clearing again on the new page. A scan
sends no input, so repeating it never repeats a step of the journey. Every attempt
stays saved.

## Impact on the UX

The robot can continue from the website's new page without duplicating the input
that reached it. The interrupted check remains untested or inconclusive, with no
invented scan result, finding or score. Existing host components, layout and
customer browser defaults are unchanged.

## Still pending

The local browser regression deliberately holds axe's script-injection read
across an actual controlled navigation, producing Chromium's real destroyed-
document error. It proves recovery, retained originals, no repeated input, no accepted result
from the interrupted check, and one new scan of the page it reached
(tests/scan-navigation.test.ts). tests/page-reloads.test.ts covers a page that
reloads itself after arrival, a scan or banner clearing cut short by a reload,
and the three-attempt limits. Additional checks cover a
replacement before scanning and refusal after close/stop or an unrelated failure.

A current public-site entry check is separate from this controlled regression.
Recovering the scan does not establish that Booking.com's flight journey can be
completed, that a site challenge can be passed, or that a complete analysis/report
will be produced. Human-quality, native-reader and broader public-flow proofs
remain separate work.
