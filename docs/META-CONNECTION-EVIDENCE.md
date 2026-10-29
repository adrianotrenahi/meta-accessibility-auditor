# Evidence for investigating a lost Meta connection

## Impact on the system

When Cavioo cannot receive the next model response, future saved failure notes include how many milliseconds that particular connection attempt took. This separates a quick lost connection from waiting for an answer. The duration covers the attempted request and, when reached, reading its response; it excludes earlier request preparation and reconnect waiting.

Exception notes also retain at most sixteen distinct pairs of recognised error category and operation: connect, read, write, lookup or unknown. Only fixed words pass through. Exception messages, addresses, hostnames, request text, credentials and arbitrary categories never pass through. Traversal has depth, node and branch limits; cut-off, circular or unreadable details are explicitly incomplete. Property getters are not invoked.

These are observed diagnostic details, not proof that Meta did or did not receive a request. They never change retry decisions, release an uncertain charge, raise a limit or modify an earlier record. For example, if the next Booking.com navigation answer is lost, a connect-labelled failure still stops with its possible charge held under the same rules as before. A code or operation string alone cannot establish the historical network cause.

The existing generation rule still permits another connection attempt only for its prior narrow proof of failure before connection. Count preparation retains its existing three-attempt limit. Model requests, bodies, approval checks, Stop and source guards are unchanged. Older records without the additional optional fields remain valid.

## Impact on the UX

Cavioo's current browser, activity feed, report, components and layout stay the same. No raw connection detail appears in a new customer surface. This improves the saved evidence available for an investigation.

## Still pending

Offline tests prove bounded, secret-free diagnostics, actual local Node connection-refusal details, and unchanged request/charge behavior. They do not repair or establish the cause of a real Meta connection failure. A future owner-approved real run is still needed to observe its own current diagnostic evidence; old incomplete connection details cannot be reconstructed or used to release held charges.
