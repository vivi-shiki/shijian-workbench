import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnotationReviewPrompt,
  buildCanonicalPage,
  buildClassificationPrompt,
  buildGroupingPrompt,
  dedupeExactCandidateNotes,
  demoteInvalidRegulatedForms,
  mergeExactCandidateEntries,
  normalizeDeterministicCitationMarks,
  materializeReferencePlan,
  normalizeClassifications
} from "../src/tri-pass-structuring.mjs";

const finePage = {
  page_number: 43, width: 1000, height: 2000,
  regions: [
    { id: "fine-a", bbox: [800, 100, 80, 700], edited_text: "甲乙丙丁戊己庚辛壬癸子丑寅卯", confidence: 0.98 },
    { id: "fine-b", bbox: [680, 120, 70, 300], edited_text: "小注原文", confidence: 0.91 }
  ]
};
const broadPage = {
  page_number: 43, width: 1000, height: 2000,
  regions: [
    { id: "broad-a", bbox: [650, 80, 250, 800], edited_text: "題名\n甲乙丙丁戊己庚辛壬癸子丑寅卯\n小注原文" }
  ]
};

test("canonical regions preserve both OCR sources and explicit layout relations", () => {
  const page = buildCanonicalPage(43, [
    { resultId: "paddleocr-vl", page: broadPage },
    { resultId: "pp-ocrv6", page: finePage }
  ]);
  assert.equal(page.anchor_result_id, "pp-ocrv6");
  assert.equal(page.regions.length, 2);
  assert.equal(page.regions[0].sources[0].result_id, "pp-ocrv6");
  assert.equal(page.regions[0].sources[1].result_id, "paddleocr-vl");
  assert.equal(page.regions[0].spatial.x_rank_from_right, 1);
  assert.equal(page.regions[0].spatial.nearest_left, "p43:r002");
  assert.ok(page.regions[0].spatial.relative_height > 0);
});

test("invalid regulated-form claims are demoted without changing OCR text", () => {
  const candidate = { entries: [{ form: "七律", lines: ["甲乙丙丁戊己庚。"], source_pages: [46] }], issues: [] };
  const result = demoteInvalidRegulatedForms(candidate, [{
    code: "regulated_verse_line_count", entry_index: 0, expected: 8, actual: 1
  }]);
  assert.equal(result.changed, true);
  assert.equal(result.candidate.entries[0].form, "");
  assert.deepEqual(result.candidate.entries[0].lines, ["甲乙丙丁戊己庚。"]);
  assert.match(result.candidate.issues[0].description, /体裁降级为待复核/);
  assert.equal(demoteInvalidRegulatedForms(candidate, [{ code: "context_leak", entry_index: 0 }]).changed, false);
});

test("only exact duplicate notes at the same position are removed", () => {
  const duplicate = { position: { field: "lines", line: 1, offset: 2 }, text: "同注。" };
  const candidate = { entries: [{ notes: [duplicate, structuredClone(duplicate),
    { position: { field: "lines", line: 1, offset: 3 }, text: "同注。" }] }] };
  const result = dedupeExactCandidateNotes(candidate);
  assert.equal(result.changed, true);
  assert.equal(result.candidate.entries[0].notes.length, 2);
  assert.equal(result.repairs[0].code, "exact_duplicate_note_removed");
});

test("exact duplicate entries merge evidence and keep the non-empty title", () => {
  const body = ["甲乙丙丁戊己庚，", "辛壬癸子丑寅卯。"];
  const candidate = { entries: [
    { kind: "poem", title: "", lines: body, notes: [], source_pages: [49], evidence_refs: ["a"] },
    { kind: "poem", title: "死別", lines: [...body], notes: [{ text: "注", position: { field: "lines", line: 1, offset: 1 } }],
      source_pages: [49], evidence_refs: ["b"] }
  ] };
  const result = mergeExactCandidateEntries(candidate);
  assert.equal(result.changed, true);
  assert.equal(result.candidate.entries.length, 1);
  assert.equal(result.candidate.entries[0].title, "死別");
  assert.deepEqual(result.candidate.entries[0].evidence_refs, ["a", "b"]);
  assert.equal(result.candidate.entries[0].notes.length, 1);
});

test("deterministic citation marks change punctuation but preserve source characters", () => {
  const candidate = { entries: [{ notes: [
    { text: "吳錄張紘言於孫。", position: { field: "lines", line: 1, offset: 1 } },
    { text: "一作纏綿晉，書王蘊傳與。", position: { field: "lines", line: 1, offset: 1 } },
    { text: "李賀詩：屋窄。", position: { field: "lines", line: 1, offset: 1 } }
  ] }] };
  const result = normalizeDeterministicCitationMarks(candidate);
  assert.equal(result.candidate.entries[0].notes[0].text, "《吳錄》張紘言於孫。");
  assert.equal(result.candidate.entries[0].notes[1].text, "一作纏綿《晉書·王蘊傳》與。");
  assert.equal(result.candidate.entries[0].notes[2].text, "李賀詩：屋窄。");
  assert.equal(result.repairs.length, 2);
});

test("classification normalization makes omissions explicit instead of inventing text", () => {
  const page = buildCanonicalPage(43, [{ resultId: "pp-ocrv6", page: finePage }]);
  const normalized = normalizeClassifications({ regions: [
    { region_id: "p43:r001", role: "main_text", confidence: 0.95 },
    { region_id: "p99:r999", role: "header", confidence: 1 }
  ] }, [page]);
  assert.equal(normalized.regions.length, 2);
  assert.equal(normalized.regions[1].role, "uncertain");
  assert.deepEqual(new Set(normalized.warnings.map(item => item.code)), new Set(["unknown_region", "missing_classification"]));
});

test("reference plans materialize OCR characters and permit punctuation insertions only", () => {
  const page = buildCanonicalPage(43, [{ resultId: "pp-ocrv6", page: finePage }]);
  const sourceId = page.regions[0].sources[0].source_id;
  const field = (start, end, punctuation) => ({
    parts: [{ region_id: "p43:r001", source_id: sourceId, start, end }],
    insertions: punctuation ? [{ offset: end - start, text: punctuation }] : []
  });
  const output = materializeReferencePlan({ entries: [{
    action: "create", boundary_state: "closed", kind: "poem", title: { parts: [], insertions: [] },
    subtitle: { parts: [], insertions: [] }, author: { parts: [], insertions: [] }, form: "七絕",
    series: null, lines: [field(0, 7, "，"), field(7, 14, "。")], prose: [], notes: [], confidence: 0.9
  }] }, [page]);
  assert.deepEqual(output.entries[0].lines, ["甲乙丙丁戊己庚，", "辛壬癸子丑寅卯。"]);
  assert.deepEqual(output.entries[0].evidence_refs, [sourceId]);
  const repaired = materializeReferencePlan({ entries: [{
    kind: "other", title: field(0, 15), lines: [], prose: [], notes: []
  }] }, [page]);
  assert.equal(repaired.entries[0].title, "甲乙丙丁戊己庚辛壬癸子丑寅卯");
  assert.deepEqual(repaired.materialization_repairs, [{
    code: "full_span_off_by_one", source_id: sourceId, requested_end: 15, applied_end: 14, page_number: 43
  }]);
  const repairedPunctuation = materializeReferencePlan({ entries: [{
    kind: "other", title: {
      parts: [{ region_id: "p43:r001", source_id: sourceId, start: 0, end: 14 }],
      insertions: [{ offset: 15, text: "。" }]
    }, lines: [], prose: [], notes: []
  }] }, [page]);
  assert.equal(repairedPunctuation.entries[0].title, "甲乙丙丁戊己庚辛壬癸子丑寅卯。");
  assert.deepEqual(repairedPunctuation.materialization_repairs, [{
    code: "terminal_insertion_off_by_one", requested_offset: 15, applied_offset: 14, text: "。"
  }]);
  const droppedTail = materializeReferencePlan({ entries: [{
    kind: "other", title: {
      parts: [
        { region_id: "p43:r001", source_id: sourceId, start: 0, end: 14 },
        { region_id: "p43:r001", source_id: sourceId, start: 14, end: 21 }
      ]
    }, lines: [], prose: [], notes: []
  }] }, [page]);
  assert.equal(droppedTail.entries[0].title, "甲乙丙丁戊己庚辛壬癸子丑寅卯");
  assert.equal(droppedTail.materialization_repairs[0].code, "empty_out_of_range_span_dropped");
  assert.match(droppedTail.issues[0].description, /未生成越界文字/);
  const emptySpan = materializeReferencePlan({ entries: [{
    kind: "other", title: {
      parts: [
        { region_id: "p43:r001", source_id: sourceId, start: 0, end: 14 },
        { region_id: "p43:r001", source_id: sourceId, start: 14, end: 14 }
      ]
    }, lines: [], prose: [], notes: []
  }] }, [page]);
  assert.equal(emptySpan.materialization_repairs.at(-1).code, "empty_text_span_dropped");
  assert.throws(() => materializeReferencePlan({ entries: [{
    kind: "poem", title: field(0, 1, "新"), lines: [], prose: [], notes: []
  }] }, [page]), /OCR 证据不支持/);
  const formattingProjection = materializeReferencePlan({ entries: [{
    kind: "other", title: {
      parts: [{ region_id: "p43:r001", source_id: sourceId, start: 0, end: 14 }],
      insertions: [{ offset: 0, text: "《甲乙丙丁戊己庚辛壬癸子丑寅卯》" }]
    }, lines: [], prose: [], notes: []
  }] }, [page]);
  assert.equal(formattingProjection.entries[0].title, "《甲乙丙丁戊己庚辛壬癸子丑寅卯》");
  assert.equal(formattingProjection.materialization_repairs.at(-1).code, "full_text_insertion_projected_as_formatting");
  const contextPrefixProjection = materializeReferencePlan({ entries: [{
    kind: "other", title: {
      parts: [{ region_id: "p43:r001", source_id: sourceId, start: 7, end: 14 }],
      insertions: [{ offset: 0, text: "只讀上下文。辛壬癸，子丑寅卯。" }]
    }, lines: [], prose: [], notes: []
  }] }, [page]);
  assert.equal(contextPrefixProjection.entries[0].title, "辛壬癸，子丑寅卯。");
  assert.equal(contextPrefixProjection.materialization_repairs.at(-1).code,
    "context_prefix_or_suffix_removed_by_format_projection");
});

test("three prompts keep the stages separate and require reference-only output", () => {
  const target = buildCanonicalPage(43, [{ resultId: "pp-ocrv6", page: finePage }]);
  const context = buildCanonicalPage(44, [{ resultId: "pp-ocrv6", page: { ...finePage, page_number: 44 } }], true);
  const classification = buildClassificationPrompt("疑雨集注", [target, context]);
  const grouping = buildGroupingPrompt("疑雨集注", [target, context], { regions: [] });
  const review = buildAnnotationReviewPrompt("疑雨集注", [target, context], { regions: [] }, { entries: [] });
  assert.match(classification, /只判断 region 的版面角色/);
  assert.match(grouping, /只负责卷\/年标题、作品边界、跨页续接、组诗关系和正文分句/);
  assert.match(review, /主要负责把所有注文放回所属作品和精确锚点/);
  assert.match(review, /机器诊断指出句数不足.*必须将 form 留空/);
  for (const prompt of [classification, grouping, review]) {
    assert.match(prompt, /任何原文都不得由你重新抄写/);
    assert.match(prompt, /char_count 是程序计算的权威 Unicode 字符数/);
    assert.match(prompt, /不得假设一个 region 必然能均分为 7\+7/);
    assert.match(prompt, /上下文页只用于判断跨页边界，不得引用到输出/);
  }
});
