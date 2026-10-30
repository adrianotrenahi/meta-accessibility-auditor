# Cavioo screens package

`npm run audits` shows Cavioo's own audits list, new-audit brief, live run, findings and report screens, signed in as **Testing Account**. Those screens are Cavioo's prior work. Their source is not in this repository: the page downloads them once as a single pre-built file, then keeps a verified copy.

## What is in the package, and what is not

- **In it:** Cavioo's screen code (shortened, without comments), its styles, the Cavioo logo, three openly licensed fonts, and the hackathon-written Meta helpers in finished form for the page server.
- **Not in it:** Cavioo's criteria and their wording, its scoring, its fix advice, its AI prompts and AI settings, and its server code. The builder replaces those files with stand-ins while it builds. A stand-in keeps each name so the screens load; a function does nothing, and a value keeps only its shape, with every sentence blanked and every number set to 0. Free trials, PDF export, comments and workspace switching are trimmed the same way.
- **Instead of Cavioo's criteria**, the report shows this engine's own fifteen criteria (C01–C15), which are hackathon work. The report says "Not scored": Cavioo's scoring stays private.

## How it is checked

- `host/cavioo-ui.lock.json` records the package's address and its SHA-256 fingerprint. The page uses the package only when the fingerprint matches, whether downloaded or kept, so a changed or swapped file is refused.
- The browser only ever loads the screens from this computer, never from the internet.
- Before publishing, `tools/cavioo-ui/leak-check.mjs` takes every text of 24 characters or more from Cavioo's private files (criteria, scoring, advice, prompts, AI settings, server and trimmed files) and confirms that none appears in the package. A few ordinary screen labels shown to every Cavioo user are allowed by name, each with its reason, in `tools/cavioo-ui/leak-allow.json`.

## Rebuilding (needs a Cavioo checkout)

```sh
node tools/cavioo-ui/build.mjs --cavioo <Cavioo checkout> --out dist/cavioo-ui.json
node tools/cavioo-ui/leak-check.mjs --cavioo <Cavioo checkout> --package dist/cavioo-ui.json
```

Publish `dist/cavioo-ui.json` as a release download named `cavioo-ui-<first 12 characters of its SHA-256>`, then record its address and fingerprint in `host/cavioo-ui.lock.json`. `ACCESS_WALK_CAVIOO_UI=<file>` makes the page read a local package instead; it must still match the recorded fingerprint.

Testing the page against the package: `npm run audits`, start the controlled example, advance it to the end, and open its findings and report. Every stand-in a screen calls is listed in the browser's console as "Stand-in used: …".
