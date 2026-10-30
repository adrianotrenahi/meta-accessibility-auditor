import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCaviooUi, readCaviooUi } from "./cavioo-ui.mjs";
import { inAccount, TESTING_ACCOUNT } from "./funnel-server.mjs";

const pkg = (files = { "/": { type: "text/html", base64: Buffer.from("<p>screens</p>").toString("base64") } }) =>
  JSON.stringify({ format: "access-walk/cavioo-ui-v1", files, hostLib: Buffer.from("export {}").toString("base64") });
const lockFor = (text) => ({ url: "https://example.org/cavioo-ui.json", sha256: createHash("sha256").update(text).digest("hex") });
const folder = () => mkdtempSync(path.join(tmpdir(), "access-walk-ui-"));
const refuse = async () => { throw Error("no download expected"); };

test("The screens package is used only when its fingerprint matches", () => {
  const text = pkg();
  assert.equal(readCaviooUi(text, lockFor(text)).files.get("/").bytes.toString(), "<p>screens</p>");
  assert.throws(() => readCaviooUi(text + " ", lockFor(text)), /fingerprint/);
});

test("A package naming a file outside its own folder is refused", () => {
  const text = pkg({ "/": { type: "text/html", base64: "" }, "/../escape.js": { type: "text/javascript", base64: "" } });
  assert.throws(() => readCaviooUi(text, lockFor(text)), /unsafe/);
});

test("The first start downloads and keeps a verified copy; later starts need no connection", async () => {
  const text = pkg(), lock = lockFor(text), dir = folder();
  try {
    let downloads = 0;
    const download = async (url) => { downloads++; assert.equal(url, lock.url); return new Response(text); };
    await loadCaviooUi({ cacheDirectory: dir, lock, source: "", download });
    await loadCaviooUi({ cacheDirectory: dir, lock, source: "", download: refuse });
    assert.equal(downloads, 1);
    assert.equal(readFileSync(path.join(dir, `${lock.sha256}.json`), "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A swapped download is refused and never kept; a damaged kept copy is replaced", async () => {
  const text = pkg(), lock = lockFor(text), dir = folder();
  try {
    await assert.rejects(
      loadCaviooUi({ cacheDirectory: dir, lock, source: "", download: async () => new Response(pkg({ "/": { type: "text/html", base64: "" } })) }),
      /fingerprint/,
    );
    writeFileSync(path.join(dir, `${lock.sha256}.json`), "damaged");
    const loaded = await loadCaviooUi({ cacheDirectory: dir, lock, source: "", download: async () => new Response(text) });
    assert.ok(loaded.files.has("/"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Without a connection, the message says what to do and that the engine needs no download", async () => {
  const text = pkg(), dir = folder();
  try {
    await assert.rejects(
      loadCaviooUi({ cacheDirectory: dir, lock: lockFor(text), source: "", download: async () => { throw Error("offline"); } }),
      /could not be downloaded \(offline\).*internet connection/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Testing Account sees its own audits and the older ones saved before accounts, never another account's", () => {
  assert.equal(TESTING_ACCOUNT.name, "Testing Account");
  assert.equal(inAccount({ account: TESTING_ACCOUNT.id }), true);
  assert.equal(inAccount({}), true);
  assert.equal(inAccount({ account: "someone-else" }), false);
});
