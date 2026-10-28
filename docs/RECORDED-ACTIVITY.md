# Recorded activity for an existing host feed

## Impact on the system

The optional `activity` field in `access-walk/host-v1` carries a versioned
`recorded-activity/1` envelope bound to its run. At most forty recent original
progress, input-result, navigation-preparation and limit records are projected.
Each retains its original identity, record number, fingerprint and timestamp.
Activity-only changes advance the normal saved delivery revision without a new
screenshot, website action or model request.

Public rows never contain provider responses, prompts or private model reasoning.
Input-result rows contain no typed value or action-note text. Only the known fixed
initial-capture sentence is published immediately. Freeform progress notes wait
until the next navigation read or ended run closes their input interval, and need
a matching capture-linked input. All known typed values through that boundary and
the same key and Bearer-token scrub as logs are applied before publication. This
can delay a note until the next read, especially during an analysis checkpoint.
An unrelated later input cannot rewrite an already exported row. A preparation is explicitly named
Preparing next action and does not claim a model decision or sent request.
Later activity waits behind a note that may still become safe to publish, so the
delta cursor cannot pass it. A later navigation read or ended run permanently
closes a note with no matching input and releases the genuine limits behind it.
This barrier is applied before selecting the forty-row window; run/stop state
itself is always delivered independently of the activity suffix.

## Impact on the UX

For example, a run stopped before its first navigation request can show its
initial capture, preparation and actual limit in a host's existing progress feed.
That is recorded activity, not evidence of successful navigation or a finding.
The host can use the strictly increasing original record numbers as its delta
cursor, including when several records share one timestamp.

## Still pending

The host reader must accept the optional field before this exporter is enabled;
older strict readers reject unknown fields. Updated readers continue to accept
older snapshots without activity and can show their stored stop reason.
Foreign envelopes, duplicate/reordered rows and rewriting an overlapping retained
row are refused. Progress does not establish findings, full assessment or journey
completion. Customer dispatch and an actual model-driven flow require their own
proofs; the activity read starts none of that work.
