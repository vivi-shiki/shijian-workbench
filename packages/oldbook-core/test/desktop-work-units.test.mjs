import assert from "node:assert/strict";
import test from "node:test";
import { assembleCandidate } from "../src/ebook-review.mjs";
import { planEntryRevision, planPageCorrection, assertSingleEntryCandidate,
  DEFAULT_REVISION_OPTIONS } from "../src/desktop-work-units.mjs";

const document = {
  entries: [
    { id: "poem-before", kind: "poem", title: "前诗", source_pages: [10], lines: ["前诗正文"] },
    { id: "poem-target", kind: "poem", title: "目标诗", source_pages: [11, 12], lines: ["上页一句", "下页一句"] },
    { id: "poem-same-page", kind: "poem", title: "同页他诗", source_pages: [12], lines: ["不得修改"] },
    { id: "poem-after", kind: "poem", title: "后诗", source_pages: [13], lines: ["后诗正文"] }
  ]
};

test("page OCR correction identifies one page and never masquerades as a poem revision", () => {
  const plan = planPageCorrection({ pageId: "page-011", resultId: "ocr-a" });
  assert.deepEqual(plan, { kind: "page_ocr", page_id: "page-011", result_id: "ocr-a" });
  assert.throws(() => planPageCorrection({ pageId: "poem-target", resultId: "ocr-a" }), /page/i);
});

test("poem action targets only the selected entry while gathering every source page", () => {
  const plan = planEntryRevision(document, "poem-target", ["ocr-a", "ocr-b"]);
  assert.equal(plan.kind, "entry_revision");
  assert.deepEqual(plan.entry_ids, ["poem-target"]);
  assert.deepEqual(plan.source_pages, [11, 12]);
  assert.deepEqual(plan.evidence_pages, [10, 11, 12, 13]);
  assert.deepEqual(plan.context_entry_ids, ["poem-before", "poem-same-page", "poem-after"]);
  assert.deepEqual(plan.result_ids, ["ocr-a", "ocr-b"]);
  assert.ok(!plan.entry_ids.includes("poem-same-page"));
});

test("revision of one work rejects unknown, non-poem, and unsourced targets", () => {
  assert.throws(() => planEntryRevision(document, "missing", ["ocr-a"]), /not found|不存在/i);
  assert.throws(() => planEntryRevision({ entries: [{ id: "heading", kind: "heading", source_pages: [2] }] },
    "heading", ["ocr-a"]), /poem|作品/i);
  assert.throws(() => planEntryRevision({ entries: [{ id: "empty", kind: "poem", source_pages: [] }] },
    "empty", ["ocr-a"]), /source|来源/i);
});

test("candidate approval and automatic overwrite start disabled in the basic workflow", () => {
  assert.equal(DEFAULT_REVISION_OPTIONS.single_revision, false);
  assert.equal(DEFAULT_REVISION_OPTIONS.direct_overwrite, false);
  assert.equal(DEFAULT_REVISION_OPTIONS.require_approval, true);
});

test("a poem candidate leaves the other poem on the same page untouched", () => {
  const plan = planEntryRevision(document, "poem-target", ["ocr-a", "ocr-b"]);
  const task = { mode: "structure", entry_ids: plan.entry_ids };
  const replacement = { ...document.entries[1], lines: ["新校正文", "下页一句"] };
  const candidate = assembleCandidate(document, task, { entries: [replacement], issues: [] });
  assert.deepEqual(candidate.entries[2], document.entries[2]);
  assert.deepEqual(candidate.entries[1].lines, replacement.lines);
  assert.equal(assertSingleEntryCandidate(document, candidate, "poem-target"), candidate);
  const expanded = structuredClone(candidate);
  expanded.entries.splice(2, 0, { id: "new-poem", kind: "poem", source_pages: [12] });
  assert.throws(() => assertSingleEntryCandidate(document, expanded, "poem-target"), /outside/);
  assert.throws(() => assembleCandidate(document, task, {
    entries: [replacement, { ...document.entries[2], lines: ["越界修改"] }], issues: []
  }), /out-of-scope/);
});
