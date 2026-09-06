import assert from "node:assert/strict";
import test from "node:test";
import { buildAlignment, finalTextTargets, normalizeForAlignment } from "../src/dataset-store.mjs";

test("normalization removes punctuation and preserves readable characters", () => {
  assert.equal(normalizeForAlignment("疑雨集：其一。"), "疑雨集其一");
});

test("final text is divided into addressable targets", () => {
  const targets = finalTextTargets([{
    id: "entry-0001",
    title: "題名",
    series: { title: "組詩" },
    lines: ["第一句。", "第二句。"],
    prose: "甲。乙！\n\n丙。",
    notes: [{ text: "一條注文" }],
    source_pages: [1]
  }]);
  assert.deepEqual(targets.map((target) => target.id), [
    "entry-0001:series",
    "entry-0001:title",
    "entry-0001:line-1",
    "entry-0001:line-2",
    "entry-0001:prose-1",
    "entry-0001:prose-2",
    "entry-0001:prose-3",
    "entry-0001:note-1"
  ]);
});

test("alignment creates bidirectional exact and fuzzy links", () => {
  const entries = [{
    id: "entry-0001",
    title: "春日即事",
    series: null,
    lines: ["花落水流紅"],
    prose: "",
    notes: [],
    source_pages: [1]
  }];
  const page = (id, title, line) => ({
    id: "page-001",
    page_number: 1,
    regions: [
      { id: `${id}-r1`, order: 1, bbox: [1, 2, 3, 4], raw_text: title },
      { id: `${id}-r2`, order: 2, bbox: [5, 6, 7, 8], raw_text: line }
    ]
  });
  const result = buildAlignment(entries, [
    { id: "ocr-a", pages: [page("a", "春日即事", "花落水流紅")] },
    { id: "ocr-b", pages: [page("b", "春日卽事", "花落水流江")] }
  ]);
  assert.equal(result.summary.targets, 2);
  assert.equal(result.summary.linked_targets, 2);
  assert.equal(result.summary.two_source_targets, 2);
  assert.deepEqual(result.by_region["ocr-a/page-001/a-r2"], ["entry-0001:line-1"]);
  assert.equal(result.by_target["entry-0001:line-1"][1].match_method, "fuzzy-region");
});
