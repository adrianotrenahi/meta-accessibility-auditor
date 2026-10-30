import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredProofMode } from "./funnel-server.mjs";

const manifest = (mode) => ({
  protocol: "access-walk/host-v1",
  mode,
  capabilities: { manualCheckpoints: mode === "offline" },
});
test("the proof host stays offline unless startup and engine explicitly agree on live mode", () => {
  assert.equal(configuredProofMode(manifest("offline")), "offline");
  assert.equal(configuredProofMode(manifest("offline"), false), "offline");
  assert.equal(configuredProofMode(manifest("live"), true), "live");
  assert.throws(
    () => configuredProofMode(manifest("live")),
    /configured proof mode/,
  );
  assert.throws(
    () => configuredProofMode(manifest("offline"), true),
    /configured proof mode/,
  );
  assert.throws(
    () => configuredProofMode(manifest("live"), "false"),
    /explicitly enabled/,
  );
  assert.throws(
    () =>
      configuredProofMode(
        { ...manifest("live"), capabilities: { manualCheckpoints: true } },
        true,
      ),
    /configured proof mode/,
  );
  assert.throws(
    () =>
      configuredProofMode({ ...manifest("offline"), protocol: "unexpected" }),
    /configured proof mode/,
  );
});
