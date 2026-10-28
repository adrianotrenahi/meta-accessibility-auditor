# Separate local public-website batch approval

The separately launched public-website host can accept a current Adriano approval of at most $10 across its complete local history, with at most $3 for any one run. It only uses this ceiling when the server's explicit `publicWebsites` option is exactly true. The existing `--public-websites` launcher supplies that option; no key, environment setting or browser request selects this mode.

This is a ceiling on an owner's approval, not a new spending permission. For example, a private $5 approval still limits the whole local history to $5, including earlier model costs and money held for an unknown answer. Starting another run does not reset or replace that history. The key and current owner approval are both required; a key alone cannot authorise a run.

The ordinary controlled-shop host retains its existing $3 total and $3 per-run approval ceiling and its original refusal wording. Offline remains the default, and the ordinary frontend cannot turn on paid host mode. The existing owner, expiry, run, phase, request-count, final-review, project and routine spending checks in Store are unchanged. Earlier uncertain charges remain held.

The startup guard refuses missing, malformed, expired, non-owner, non-finite, zero or excessive allowances. A public approval over $10, a per-run approval over $3, or a per-run allowance above its total is refused. Failure messages contain fixed wording, without copying a key or approval contents.

Offline validation covers both startup modes, the real explicit server wiring, synthetic private files, zero provider/website requests, and retention of earlier known and unknown ledger rows. A deliberate missing public flag must make the wiring check fail. This change does not alter Cavioo's layout, components, customer defaults, runtime files or a private approval. Actual public-site journey proof belongs to the separately approved run after review and merge.
