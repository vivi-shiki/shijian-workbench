import assert from "node:assert/strict";
import test from "node:test";
import { REVISION_PRESETS, revisionPreset } from "../src/revision-presets.js";

test("revision presets expose four distinct follow-up workflows", () => {
  assert.equal(REVISION_PRESETS.length, 4);
  assert.deepEqual(REVISION_PRESETS.map((preset) => preset.id), [
    "boundaries", "lines", "titles-series", "notes"
  ]);
  assert.equal(new Set(REVISION_PRESETS.map((preset) => preset.prompt)).size, 4);
  assert.match(revisionPreset("boundaries").prompt, /跨页续接/);
  assert.match(revisionPreset("lines").prompt, /lines/);
  assert.match(revisionPreset("titles-series").prompt, /series\.index/);
  assert.match(revisionPreset("notes").prompt, /Unicode 字符 offset/);
  assert.equal(revisionPreset("missing"), null);
});
