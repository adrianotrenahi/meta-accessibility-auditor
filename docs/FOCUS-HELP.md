# Recorded descriptions during keyboard movement

The Booking.com browser observation on 28 October found ordinary-looking text under
the currency, language and help controls. They have no tooltip role. Each control's
`aria-describedby` points to its own display-only description. A separate footer link
has the same words as the help description, so removing matching words is unsafe.

The browser now records a small `focusHelp` list beside the ordinary `focus` field,
both in the saved capture and the state used to check whether that capture is current.
The original ARIA, text, pictures, actions and navigator notes stay complete. Reading
the metadata does not change focus or the page. Missing relationships take one read
and return an empty list.

Each accepted record requires a unique current-focus description ID, visible text,
absolute/fixed positioning, `pointer-events:none`, no hidden/inert ancestor, no
interactive/focusable/form/editable content or ancestor, no error/live relationship, and exactly
one plain-text ARIA leaf. IDs, text and focus are checked again after reading that
leaf. At most four short descriptions are recorded. Hidden retained descriptions are
not visible help, even when an old `aria-describedby` attribute remains.

The optional local comparison removes only one uniquely matching whole top-level
plain-text line per valid record. A duplicate match, invalid/older metadata, multiline
subtree or indented text inside a link leaves the entire input unchanged. Ordinary
record hashes bind the metadata to its complete saved capture. Other prices, names,
checked/selected states, links and content outside the exact description remain
unchanged. `recordedFocusHelpRows` exposes the complete validated rows to the caller.

Structural validity does not establish harmless meaning. A description can say
“Fare EUR 48”, then change to “Fare EUR 99”; both can be structurally valid. Their
rendering projections may match while the retained rows clearly differ. The
controller must remember description IDs and their exact text, owner and qualification
through the intent. A known ID changing any of those stops further keys. A newly
seen description may be projected for focus movement only; it disables any
pre-authorised Enter/Space until a fresh model decision at the reached target. The
projection by itself never authorises activation or establishes semantic equivalence.
It does not remove descriptions from model evidence or provide an accessibility verdict.

The controlled Chromium/WebKit checks cover actual capture metadata and complete
raw evidence, real Tab movement, hidden retention, duplicate IDs, rejected content,
same-word links and unrelated prices. The separate anonymous English Booking.com
observation supports the relationship shape; no new public website/model run is
part of these implementation checks. Full journey and Spanish live-engine proof
remain the parent task's responsibility.
