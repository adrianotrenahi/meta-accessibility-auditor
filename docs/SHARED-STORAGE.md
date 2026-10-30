# Shared storage

Every audit is saved on the Mac first, exactly as before. When shared storage is set up, the engine also copies each audit while it runs: the text (steps, findings, notes, costs) to a Neon database, and the screenshots to a private Cloudflare R2 bucket. Any working copy of this code — any branch, Claude's or Codex's — can then pull those audits in and open them.

Without the settings, nothing is shared and the engine behaves as before. Tests and proof scripts never share, even when the settings exist.

## What is copied, and when

- **While an audit runs:** every few seconds, the new steps and screenshots since the last copy. The audit never waits for this. If the internet or Neon is down, the copy pauses, says so once in the engine's log, and catches up when the connection returns.
- **Finished, stopped, interrupted and failed audits:** copied in full like any other.
- **Discarded audits:** the audit leaves every list and report, but its evidence is kept for investigating what went wrong (owner decision, 30 October). It first moves to `.discarded/<run id>` inside the data folder. With shared storage, the full copy is sent and marked as discarded, and only then removed from the Mac. Without shared storage it stays in `.discarded/`.
- **Discard in one copy applies everywhere:** if an audit is discarded from a copy that pulled it, the copy that ran it also removes it from its lists, and the evidence stays kept.

## Setting it up

1. **Neon:** create a project (region: Frankfurt, closest to Madrid). Copy its connection address, the one that starts with `postgresql://`.
2. **Cloudflare R2:** create a private bucket, for example `access-walk-screenshots`. Do not turn on public access. Then create an R2 API token with **Object Read & Write** limited to that bucket only, and note its Access Key ID and Secret Access Key. The account id is the 32-character id on the R2 overview page.
3. **Settings file:** create `~/.access-walk/storage.env` with these five lines and your own values:

   ```
   ACCESS_WALK_DATABASE_URL=postgresql://…
   ACCESS_WALK_R2_ACCOUNT_ID=…
   ACCESS_WALK_R2_BUCKET=access-walk-screenshots
   ACCESS_WALK_R2_ACCESS_KEY_ID=…
   ACCESS_WALK_R2_SECRET_ACCESS_KEY=…
   ```

   The file lives outside every working copy, so no branch can commit it. If only some of the five lines are present, the engine refuses to start and names the missing ones, without printing any value.
4. **Restart the engine.** It creates its tables in Neon on the first copy and then copies every audit in its data folder, including older ones.

## Opening shared audits in another copy

```bash
npm run storage -- pull --data data
```

This adds or updates read copies of every shared audit in that folder. Add `--follow` to keep pulling every few seconds while an audit runs elsewhere, and `--include-discarded` to also pull discarded audits for investigation. Each screenshot is checked against its saved fingerprint before it is written; a mismatch stops the pull. A folder an engine is currently using is refused, so pull into a separate folder or stop that engine first.

A read copy is never sent back: only the copy that ran an audit changes its saved state. The Cavioo audits page lists only the audits started from it, so pulled audits open in this engine's own viewer.
