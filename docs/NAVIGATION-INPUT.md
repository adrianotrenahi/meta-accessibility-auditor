# Navigation reads and complete audit evidence

## Impact on the system

The navigator receives a versioned navigation view of its one current original:
the unchanged screenshot, focus, complete recorded control list and other capture
metadata. The full page body text and complete accessibility tree are explicitly
not supplied to this role. Large pages can otherwise prevent even the first
navigation decision from fitting its existing 30,000-input limit.

The view also supplies verbatim, source-numbered navigation-role lines from the
original accessibility tree. This retains control names and checked, selected or
expanded states, including controls outside the capture's bounded control list.
Other tree lines stay omitted explicitly. This is neither a rewritten summary nor
a complete tree or a screen-reader test.

This is a derived view, labelled with its original identity and hash. Every
original action, navigator note and other selected record stays unchanged. The
saved read pins both the original records and a hash of the exact navigation
view. Before counting or sending it, the engine checks every original's integrity,
the pinned order and the view's manifest. Changed omitted fields still refuse.
Counting and generation use the same body and original image.

No original is rewritten or deleted. Analysis and independent review retain
their existing full original-text/tree reads. Navigation omission cannot establish
that page content is absent or settle an accessibility criterion. Existing action,
model, output, time and spending limits are unchanged.

## Impact on the UX

For example, the robot can ask for its first keyboard action on a large consent
screen without sending the whole site's text twice. It still sees the current
screen and recorded focus. The browser rechecks the actual control and safety
boundaries before applying an action. This changes no host component or layout.

## Still pending

A request fitting the input limit does not prove that the model returns a useful
action, passes a consent screen or completes a customer journey. Those require an
actual bounded model run. A page with unusually large controls or a long retained
walk can still exceed the unchanged limit and must stop without making a paid
generation request. Old saved reads without a navigation-view manifest remain
readable in their original full form.
