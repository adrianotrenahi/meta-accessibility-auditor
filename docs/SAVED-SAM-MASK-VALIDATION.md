# Decode saved SAM outlines without a new model request

28 October 2026. This separate offline change is stacked above the reviewed same-button grouping proposal. It introduces no new customer screen or Cavioo layout change.

## Impact on the system

The two actual retained Day 4 SAM replies now decode into complete shapes, rather than remaining encoded text attached to rectangles. A reusable check reads the existing local records in read-only mode, verifies each original screenshot and target, and writes new derived proof files outside the original data folder. It cannot start a browser walk or make a provider request.

The decoder uses Meta's official `@meta-sam/parser` pinned to 0.1.0, with its original license included in THIRD-PARTY-NOTICES.md and third-party/SAM-LICENSE.txt. This external dependency is identified separately from hackathon-authored code. Its encoding marker must remain in the payload passed to the decoder; the mask type comment alone is misleading. The executable helper and documented example confirm that requirement.

Every derived shape retains the saved SAM record's identity and fingerprint, exact capture identity and fingerprint, original image fingerprint, target, image dimensions and original source-pixel box. The complete raw reply must agree with its saved parsed objects, target prompt and image. A changed or foreign original, ambiguous target, wrong prompt, mismatched geometry, incomplete encoding, unsupported dimensions or excessive data refuses the shape. Empty and unresolved results remain explicitly empty or unresolved.

Bounds are deliberately limited to the current controlled image scale: 1.5 million source pixels, 4 MiB per original image, 200,000 reply characters, sixteen objects and 200,000 path characters. The file check refuses oversized images before reading them; the decoder refuses oversized bytes before copying them. These allowances are local decoding limits, not larger model/image/request allowances. The shape's path includes a half-pixel translation because Meta's path describes pixel centers; this aligns its edge with the original screenshot pixels. No accessibility conclusion follows from decoding or overlap.

Repeat the read-only proof with an existing saved local run:

```sh
npm ci
npm run proof:sam-masks -- --data /path/to/saved/data --run SAVED_RUN --out /path/to/new-proof-folder
```

The output folder must be new, have an existing parent and lie outside the original data folder. Existing proofs are never overwritten. Original image paths cannot escape the selected data folder through a symbolic link. A bad source produces an explicit error entry and no outline for that source; other verified results remain individually labelled. The saved records and ledger are checked again before writing outputs.

Keep the whole saved data folder together. SQLite can keep its newest committed records in matching `runs.sqlite-wal` and `runs.sqlite-shm` companion files. A copy of only `runs.sqlite` can omit those originals. The existing read-only open supports a complete readable set, following [SQLite's read-only WAL guidance](https://sqlite.org/wal.html); a source that cannot be opened is refused with clear guidance. The proof does not delete companion files, rewrite the database or assume it is immutable. A missing output parent also gives a direct instruction before any source decoding begins.

Validation:

- The corrected `npm run check` passes 259 tests including types; build and formatting pass. The generated client files retain the same fingerprints as the reviewed grouping version, consistent with no product presentation change.
- Synthetic conformance tests cover a nonrectangular binary shape, a complete empty shape, documented lossless encoding, no-match replies, foreign/changed/unstable originals, duplicate or wrong targets, raw-object disagreement, malformed/truncated payloads, source/image quotas, geometry and source-pixel placement. These are labelled synthetic tests, not new model results.
- The actual earlier Day 4 replies both decode as 62×51 shapes, with 2,908 and 2,957 foreground pixels respectively. Their shape dimensions match their own returned original boxes. Both source pictures and records pass exact fingerprint checks; the original run and ledger remain unchanged. This is saved-response decoding, not a new recognition or accuracy result.
- The proof test opens a local database read-only, keeps its bytes unchanged, refuses output within original data, refuses overwrites and escaped image paths, and exports no shape from a changed image.
- A real SQLite conformance test saves the required originals only in an uncheckpointed WAL, copies the whole set and marks its files read-only. The outline and its original records remain readable without changing the main or WAL bytes. Reading a main-file-only copy returns zero originals, demonstrating why that fallback is rejected. Another test pins the exact parser version and its uppercase M/L/Z path commands; no speculative command expansion is accepted.
- Isolated removal of the original-image, target-prompt, raw-object, source-reference, encoding-marker, reply-size or shape-size guard makes the conformance tests fail. Working files remain unchanged; the local receipt is `/private/tmp/meta-sam-mask-break-proof.json`.
- A retained browser screenshot verifies that one actual derived outline renders in a standalone loopback preview. This is not Cavioo viewer or phone-layout proof.

## Impact on the UX

For example, the saved Add-button outline can now be inspected as its actual shape on the exact original, with no extra charge. Cavioo's existing browser, bubbles, report, default worker and screenshot viewer remain unchanged. The new command is an engineering proof, not a replacement product interface.

## Still pending

- Reviewers: complete required external review and any confirmed correction verification. Adriano decides the merge; stacked children must be retargeted before their parent merges.
- Codex: connect and prove the decoded shapes through the existing Cavioo screenshot viewer at desktop/320px in [ADR-908 (keep decoded outlines on their exact original screens)](https://linear.app/adrianotrenahi/issue/ADR-908). Any visible treatment remains a local proposal for Adriano's choice before publication.
- Codex: keep actual model-driven active bubbles/grouping, larger changing-context cases, customer access/controls/performance, human expected labels and reader comparison, final report reconciliation and the video/submission work open in the build plan. No general accuracy improvement is established.

This change adds **$0 provider spend**. Recorded Meta usage remains an estimated **$5.291118 of $150**, pending Billing reconciliation; Baseten remains unused.
