import assert from "node:assert/strict";
import test from "node:test";
import { projectFormatting, textSignature } from "./text-formatting.mjs";

test("format projection keeps source characters while adopting punctuation and paragraphs", () => {
  const source = "甲乙丙丁戊己";
  const candidate = "甲乙，丙天。\n\n戊己。";
  const result = projectFormatting(source, candidate);
  assert.equal(textSignature(result.text), source);
  assert.equal(result.text, "甲乙，丙丁。\n\n戊己。");
  assert.ok(result.similarity > 0.8);
});
