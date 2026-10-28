# Recovering a scan when the website changes pages

## Impact on the system

A website can reload while its automatic accessibility scan is reading it. For
example, the Booking.com entry can disappear before the scan finishes. The
browser's document-replacement error now enters the existing observation recovery
instead of ending the run with an internal error.

Only the existing, recognised document-replacement errors qualify. Original
capture validation still runs first. A closed page, stopped run, unknown scan
failure or damaged original remains a refusal. The scan and prior input are not
repeated. Recovery retains the old original and reads a fresh state through the
existing bounded capture path. Action, screenshot, time and spending limits stay
the same.

## Impact on the UX

The robot can continue from the website's new page without duplicating the input
that reached it. The interrupted check remains untested or inconclusive, with no
invented scan result, finding or score. Existing host components, layout and
customer browser defaults are unchanged.

## Still pending

The local browser regression deliberately holds axe's script-injection read
across an actual controlled navigation, producing Chromium's real destroyed-
document error. It proves recovery, retained originals, no repeated input or scan,
and no accepted result from the interrupted check. Additional checks cover a
replacement before scanning and refusal after close/stop or an unrelated failure.

A current public-site entry check is separate from this controlled regression.
Recovering the scan does not establish that Booking.com's flight journey can be
completed, that a site challenge can be passed, or that a complete analysis/report
will be produced. Human-quality, native-reader and broader public-flow proofs
remain separate work.
