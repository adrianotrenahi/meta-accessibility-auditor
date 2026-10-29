# Saved SAM association behind the existing finding treatment

## Impact on the system

An accepted finding can now carry a `prompted-sam-association/1` receipt inside
its existing `anchor.sam`. The exporter independently verifies one complete
saved SAM reply, its exact original image, target and decoded binary shape.
Only source identities/fingerprints, original image size, original target box,
mask bounds and binary-shape fingerprint cross the host connection. The raw
reply and outline path stay outside it. No model is constructed or requested.

An unavailable, changed, empty, unresolved or ambiguous saved reply provides no
SAM receipt. Its separately reviewed finding and ordinary marker remain usable.
Original-image withdrawal continues to withhold the whole dependent finding.
For example, a receipt for an Add button on the product screen cannot attach to
a basket screen that happens to contain the same pixels or a reused target name.

The receiver must support the optional receipt before this exporter is merged;
an older strict `host-v1` receiver will refuse the new field. Old snapshots
without the optional field remain supported.

## Impact on the UX

The existing anchor rectangle is unchanged. The host can check the SAM geometry
association while retaining its existing screenshot, pin, finding and report
appearance. This change exports no outline path and paints no alternative visual.
The global SAM coverage field stays `not-established`: prompted geometry does
not establish autonomous recognition, keyboard/reader operation or an
accessibility defect.

## Still pending

Review and owner-authorised merge of the compatible receiver must precede the
exporter. This code does not activate customer services or start a fresh SAM
request. Broad recognition and finding-quality evaluation still require their
separate evidence and approval.
