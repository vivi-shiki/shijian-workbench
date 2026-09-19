import assert from "node:assert/strict";
import test from "node:test";
import { applyManualPageRevision, buildClassicPoetryPrompt, buildClassicRetryPrompt, buildEbookPrompt, emptyEbook, mergeGenerated, migrateLegacyNotePositions, parseModelJson, trimClassicContextOutput, validateEbook, validationDiagnosticsToIssues, warningOnlyGenerationPolicy } from "../src/ebook-store.mjs";
import { validateGeneratedChunk, validateGeneratedDocument } from "../src/ebook-generation-validation.mjs";

const project = { id: "book", title: "Book", results: [{ page_count: 30 }] };

test("model JSON parser accepts fenced and surrounding content", () => {
  assert.deepEqual(parseModelJson("```json\n{\"entries\":[],\"issues\":[]}\n```"), { entries: [], issues: [] });
  assert.deepEqual(parseModelJson("回答如下：{\"entries\":[],\"issues\":[]}"), { entries: [], issues: [] });
});

test("ebook prompt uses the current title and supports broad poetry genres", () => {
  const prompt = buildEbookPrompt("詞稿測試", [], [], "人工曾将『雨集』校为『疑雨集』");
  assert.match(prompt, /詞稿測試/);
  assert.match(prompt, /古体诗、乐府、词、曲、联句/);
  assert.match(prompt, /人工曾将『雨集』校为『疑雨集』/);
  assert.match(prompt, /不得机械套用/);
  assert.match(prompt, /组题下注为 \{field:'series'/);
  assert.match(prompt, /不得为省事统一挂在诗句末尾/);
  assert.match(prompt, /每个缺字保留一个“□”/);
  assert.match(prompt, /allowed_evidence_ids/);
  assert.match(prompt, /context_after（正文已隔离/);
  assert.match(prompt, /《晋书·阮籍传》/);
  assert.match(prompt, /《诗·魏风·葛屦》：掺掺女手/);
  assert.match(prompt, /《韩非子》有《孤愤》篇/);
  assert.match(prompt, /《楚辞》有《卜居》篇/);
  assert.match(prompt, /《虞翻别传》/);
  assert.match(prompt, /title=''、series\.title='感怀杂咏'/);
  assert.match(prompt, /不得用注文补成八句/);
  assert.match(prompt, /“陆游诗：……”或“李贺诗：……”不加书名号/);
  assert.doesNotMatch(prompt, /疑雨集注/);
});

test("classic poetry prompt restores the early generic workflow with full boundary context", () => {
  const prompt = buildClassicPoetryPrompt([
    { page_number: 42, context_only: true, results: [{ result_id: "ocr", regions: [{ text: "前页续文" }] }] },
    { page_number: 43, context_only: false, results: [{ result_id: "ocr", regions: [{ text: "本页正文" }] }] },
    { page_number: 44, context_only: false, results: [{ result_id: "ocr", regions: [{ text: "第二页正文" }] }] },
    { page_number: 45, context_only: false, results: [{ result_id: "ocr", regions: [{ text: "第三页正文" }] }] },
    { page_number: 46, context_only: true, results: [{ result_id: "ocr", regions: [{ text: "后页续文" }] }] }
  ], []);
  assert.match(prompt, /中国诗词类古籍/);
  assert.match(prompt, /目标页 \[43,44,45\]/);
  assert.match(prompt, /前页续文/);
  assert.match(prompt, /后页续文/);
  assert.match(prompt, /context_only=true 的前后页只用于判断跨页续接/);
  assert.match(prompt, /不得出现完全相同的重复诗句/);
  assert.match(prompt, /不得把作品第一句复制到 title/);
  assert.match(prompt, /不得把长题序切碎、并入或改写成诗句来凑格律/);
  assert.match(prompt, /不得因换页提前关闭作品/);
  assert.match(prompt, /不得为了符合已猜测的体裁而补造、复制或挪用诗句/);
  assert.match(prompt, /每一个数组元素只能保存一个完整诗句/);
  assert.match(prompt, /最终阅读版必须把相邻两句组成一个排版段落/);
  assert.match(prompt, /长篇排律也必须一句一项、两句成联/);
  assert.match(prompt, /boundary_state/);
  assert.doesNotMatch(prompt, /疑雨集/);
  assert.doesNotMatch(prompt, /旅夢初囘|自悼|鰥緒|漳南/);
  assert.doesNotMatch(prompt, /当前项目书名/);
  assert.doesNotMatch(prompt, /evidence_refs/);
});

test("manual page revision prompt puts human instructions last and at highest priority", () => {
  const prompt = buildClassicPoetryPrompt([
    { page_number: 9, context_only: true, results: [{ result_id: "ocr", regions: [{ text: "前页" }] }] },
    { page_number: 10, context_only: false, results: [{ result_id: "ocr", regions: [{ evidence_id: "p10:ocr:r1", text: "本页" }] }] },
    { page_number: 11, context_only: true, results: [{ result_id: "ocr", regions: [{ text: "后页" }] }] }
  ], [], {
    current_entries: [{ id: "entry-0001", kind: "poem", source_pages: [10], lines: ["本页正文。"] }],
    context_entries: [{ id: "entry-0002", kind: "poem", source_pages: [11], lines: ["后页正文。"] }],
    manual_prompt: "请重新判断题名与正文边界。"
  });
  assert.match(prompt, /单页人工修订模式/);
  assert.match(prompt, /当前页正式 JSON（允许修订）/);
  assert.match(prompt, /前后页正式 JSON（只读上下文）/);
  assert.match(prompt, /人工输入提示词（最高优先级）/);
  assert.match(prompt, /不得把这段要求原样写入正文或 issues/);
  assert.ok(prompt.endsWith("请重新判断题名与正文边界。"));
});

test("manual page revision only updates target entries and target-page evidence", () => {
  const document = emptyEbook(project);
  document.entries = [{
    id: "entry-0001", kind: "poem", title: "旧题", subtitle: "", author: "", form: "七言絕句",
    heading_level: null, series: null, lines: ["第一句，", "第二句。", "第三句，", "第四句。"], prose: "",
    notes: [], source_pages: [10], evidence_refs: ["p10:ocr:r1"], confidence: 0.7, review_status: "needs_review"
  }, {
    id: "entry-0002", kind: "poem", title: "后页", subtitle: "", author: "", form: "",
    heading_level: null, series: null, lines: ["后页正文。"], prose: "", notes: [], source_pages: [11],
    evidence_refs: ["p11:ocr:r1"], confidence: 0.8, review_status: "needs_review"
  }];
  const result = applyManualPageRevision(document, { entries: [{
    id: "entry-0001", title: "新题", source_pages: [10], evidence_refs: ["p10:ocr:r1"]
  }], delete_entry_ids: [], issues: [] }, { pageNumber: 10, allowedEvidenceRefs: ["p10:ocr:r1"] });
  assert.equal(result.document.entries[0].title, "新题");
  assert.equal(result.document.entries[1].title, "后页");
  assert.equal(document.entries[0].title, "旧题");
  const outside = applyManualPageRevision(document, { entries: [{
    id: "entry-0002", title: "越界修改"
  }] }, { pageNumber: 10, allowedEvidenceRefs: ["p10:ocr:r1"] });
  assert.equal(outside.document.entries[1].title, "后页");
  assert.ok(outside.warnings.some(warning => warning.code === "revision_out_of_scope_update_ignored"));
  const evidence = applyManualPageRevision(document, { entries: [{
    id: "entry-0001", evidence_refs: ["p11:ocr:r1"]
  }] }, { pageNumber: 10, allowedEvidenceRefs: ["p10:ocr:r1"] });
  assert.deepEqual(evidence.document.entries[0].evidence_refs, ["p10:ocr:r1"]);
  assert.ok(evidence.warnings.some(warning => warning.code === "revision_external_evidence_ignored"));
  assert.ok(evidence.document.issues.some(issue => issue.description.includes("revision_external_evidence_ignored")));
});

test("all model generation uses one warning-only attempt", () => {
  assert.deepEqual(warningOnlyGenerationPolicy(), { validation_mode: "warnings", max_attempts: 1 });
});

test("invalid continuation is retained as a new entry and warning instead of rejected", () => {
  const document = emptyEbook(project);
  const warnings = [];
  mergeGenerated(document, { entries: [{
    action: "continue", continuation_of: "entry-missing", kind: "poem", title: "保留候选",
    lines: ["候选正文。"], source_pages: [10], notes: []
  }] }, 10, 10, { warningDiagnostics: warnings });
  assert.equal(document.entries[0].title, "保留候选");
  assert.ok(warnings.some(warning => warning.code === "invalid_continuation"));
});

test("classic retry guidance contains only generic diagnostics", () => {
  const prompt = buildClassicRetryPrompt([{ code: "duplicate_line", entry_index: 2,
    text: "SPECIFIC-VERSE", title: "SPECIFIC-TITLE", expected: 8, actual: 4 }]);
  assert.match(prompt, /四句，应按绝句判断/);
  assert.match(prompt, /duplicate_line/);
  assert.match(prompt, /散文式长题序误放进了 lines/);
  assert.match(prompt, /"expected":8/);
  assert.doesNotMatch(prompt, /SPECIFIC-VERSE|SPECIFIC-TITLE/);
});

test("warning-mode diagnostics become review issues without candidate content", () => {
  assert.deepEqual(validationDiagnosticsToIssues([{
    code: "regulated_verse_line_count", message: "句数需要复核", source_pages: [73, 99]
  }], 73, 75), [{
    source_pages: [73],
    description: "[自动校验警示:regulated_verse_line_count] 句数需要复核",
    candidates: []
  }]);
});

test("classic workflow removes context-only entries and trims cross-boundary lines", () => {
  const bundles = [
    { page_number: 45, context_only: false, results: [{ regions: [{ text: "旅夢初囘百恨新寸腸焚絶淚成冰" }] }] },
    { page_number: 46, context_only: true, results: [{ regions: [{ text: "多愁髀肉空如削躍馬何曾及病身梯攻百道是愁心映月熒熒燭凝寒瑟瑟稠" }] }] }
  ];
  const payload = { entries: [
    { title: "旅夢初囘百恨新", source_pages: [45, 46], lines: [
      "旅夢初囘百恨新，寸腸焚絶淚成冰。", "多愁髀肉空如削，躍馬何曾及病身。"
    ], notes: [] },
    { title: "梯攻百道是愁心", source_pages: [46], lines: ["梯攻百道是愁心。"], notes: [] },
    { title: "鰥緒", source_pages: [46], lines: ["映月熒熒燭，凝寒瑟瑟稠。"], notes: [] }
  ] };
  bundles[0].results[0].regions.push({ text: "鰥緒" });
  trimClassicContextOutput(payload, bundles, 43, 45);
  assert.equal(payload.entries.length, 2);
  assert.deepEqual(payload.entries[0].source_pages, [45]);
  assert.deepEqual(payload.entries[0].lines, ["旅夢初囘百恨新，寸腸焚絶淚成冰。"]);
  assert.equal(payload.entries[0].boundary_state, "open");
  assert.deepEqual(payload.entries[1].source_pages, [45]);
  assert.deepEqual(payload.entries[1].lines, []);
  assert.equal(payload.entries[1].boundary_state, "open");
  assert.deepEqual(payload.classic_repairs.map(item => item.code), [
    "context_only_content_removed", "context_only_entry_removed", "context_only_content_removed"
  ]);
});

test("classic workflow removes exact continuation overlap and a copied first-line title", () => {
  const document = emptyEbook(project);
  document.entries = [{ id: "entry-0001", kind: "poem", title: "前題", form: "", lines: [
    "前頁第一句。", "前頁第二句。"
  ], notes: [], source_pages: [4] }];
  const bundles = [{ page_number: 5, context_only: false, results: [{ regions: [{
    text: "前頁第二句新作第一句新作第二句"
  }] }] }];
  const payload = { entries: [{
    continuation_of: "entry-0001", boundary_state: "open", kind: "poem", form: "七絕",
    title: "", lines: ["前頁第二句。"], source_pages: [5], notes: []
  }, {
    continuation_of: "", boundary_state: "closed", kind: "poem", title: "新作第一句",
    lines: ["新作第一句。", "新作第二句。"], source_pages: [5], notes: []
  }] };

  trimClassicContextOutput(payload, bundles, 5, 5, document);
  assert.deepEqual(payload.entries[0].lines, []);
  assert.equal(payload.entries[0].form, "");
  assert.equal(payload.entries[0].boundary_state, "closed");
  assert.equal(payload.entries[1].title, "");
  assert.deepEqual(payload.classic_repairs.map(item => item.code), [
    "continuation_overlap_removed", "first_line_title_removed"
  ]);
});

test("generated group-title notes retain series positions", () => {
  const document = emptyEbook(project);
  mergeGenerated(document, {
    entries: [{
      kind: "poem", title: "", series: { title: "王敬宏夫人", index: 1, total: 2 },
      lines: ["第一句。"], source_pages: [1],
      notes: [{ position: { field: "series", offset: 3 }, text: "组题注" }]
    }],
    issues: []
  }, 1, 5);
  assert.deepEqual(document.entries[0].notes[0].position, { field: "series", offset: 3 });
  assert.equal(validateEbook(document, "book"), document);
});

test("generated entries are normalized and can continue the previous chunk", () => {
  const document = emptyEbook(project);
  mergeGenerated(document, {
    entries: [{ kind: "poem", title: "花燭詞", series: { title: "無題", index: 1, total: 2 }, lines: ["第一句"],
      source_pages: [4], boundary_state: "open", confidence: 0.9 }],
    issues: []
  }, 1, 5);
  assert.equal(document.entries[0].id, "entry-0001");
  assert.deepEqual(document.entries[0].lines, ["第一句"]);
  assert.deepEqual(document.entries[0].series, { title: "無題", index: 1, total: 2 });

  mergeGenerated(document, {
    entries: [{ continuation_of: "entry-0001", kind: "poem", lines: "第二句\n第三句", notes: ["原注"], source_pages: [6] }],
    issues: [{ source_pages: [6], description: "一字待核", candidates: ["甲", "乙"] }]
  }, 6, 10);
  assert.equal(document.entries.length, 1);
  assert.deepEqual(document.entries[0].lines, ["第一句", "第二句", "第三句"]);
  assert.deepEqual(document.entries[0].source_pages, [4, 6]);
  assert.equal(document.entries[0].notes[0].text, "原注");
  assert.deepEqual(document.entries[0].notes[0].position, { field: "lines", line: 2, offset: 0 });
  assert.equal(document.issues[0].description, "一字待核");
});

test("a continuation can attach a new-page note to an existing combined line", () => {
  const document = emptyEbook(project);
  mergeGenerated(document, { entries: [{
    kind: "poem", title: "跨頁詩", lines: ["第一句。", "第二句。"],
    source_pages: [4], boundary_state: "open"
  }] }, 4, 4);

  mergeGenerated(document, { entries: [{
    continuation_of: "entry-0001", kind: "poem", lines: [], source_pages: [5],
    notes: [{ position: { field: "lines", line: 2, offset: 3 }, text: "次頁注文。" }]
  }] }, 5, 5);

  assert.deepEqual(document.entries[0].notes, [{
    position: { field: "lines", line: 2, offset: 3 }, text: "次頁注文。"
  }]);
  assert.equal(validateEbook(document, "book"), document);
});

test("legacy note markers migrate to exact title and line positions", () => {
  const document = emptyEbook(project);
  document.entries = [{
    id: "entry-0001", kind: "poem", title: "有所窺", lines: ["楚雲入夢渾迷曉，", "琅玕清影。"], source_pages: [1],
    notes: [
      { marker: "題注", text: "題下注" },
      { marker: "楚雲入夢", text: "句注" },
      { marker: "琅玕", text: "詞注" }
    ]
  }];
  migrateLegacyNotePositions(document);
  assert.deepEqual(document.entries[0].notes, [
    { position: { field: "title", offset: 3 }, text: "題下注" },
    { position: { field: "lines", line: 1, offset: 4 }, text: "句注" },
    { position: { field: "lines", line: 2, offset: 2 }, text: "詞注" }
  ]);
  assert.equal(validateEbook(document, "book"), document);
});

test("generated notes recover from an out-of-range position", () => {
  const document = emptyEbook(project);
  mergeGenerated(document, {
    entries: [{
      kind: "poem", title: "無題", lines: ["第一句。"], source_pages: [1],
      notes: [{ position: { field: "lines", line: 9, offset: 99 }, marker: "第一", text: "句注" }]
    }],
    issues: []
  }, 1, 5);
  assert.deepEqual(document.entries[0].notes[0].position, { field: "lines", line: 1, offset: 2 });
  assert.equal(validateEbook(document, "book"), document);
});

test("book text and biography are valid entry kinds", () => {
  const document = emptyEbook(project);
  document.entries = [
    { id: "entry-0001", kind: "book_text", lines: ["卷一"], notes: [], source_pages: [1] },
    { id: "entry-0002", kind: "biography", lines: [], prose: "作者小傳", notes: [], source_pages: [2] }
  ];
  assert.equal(validateEbook(document, "book"), document);
});

test("heading hierarchy uses editable numeric levels and accepts legacy aliases", () => {
  const document = emptyEbook(project);
  mergeGenerated(document, {
    entries: [{ kind: "heading", heading_level: "year", title: "戊午年", lines: [], source_pages: [1] }],
    issues: []
  }, 1, 5);
  assert.equal(document.entries[0].heading_level, 2);
  assert.equal(validateEbook(document, "book"), document);
  document.entries[0].heading_level = 5;
  assert.equal(validateEbook(document, "book"), document);
  document.entries[0].heading_level = 7;
  assert.throws(() => validateEbook(document, "book"), /heading_level/);
});

test("manual JSON validation protects project identity and entry arrays", () => {
  const document = emptyEbook(project);
  assert.equal(validateEbook(document, "book"), document);
  assert.throws(() => validateEbook({ ...document, project_id: "other" }, "book"), /project_id/);
  assert.throws(() => validateEbook({ ...document, entries: [{ id: "bad", kind: "poem" }] }, "book"), /数组字段/);
});

const bundles = [
  { page_number: 47, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p47:ocr:title", text: "衢州見橘樹纍纍" }
  ] }] },
  { page_number: 48, context_only: true, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:body", text: "笑蹙長蛾熨齒酸酒闌常記手摻摻" }
  ] }] }
];

test("prompt exposes target OCR but redacts context-page text", () => {
  const prompt = buildEbookPrompt("Book", bundles, []);
  assert.match(prompt, /衢州見橘樹纍纍/);
  assert.doesNotMatch(prompt, /笑蹙長蛾熨齒酸/);
  assert.match(prompt, /"page_number":48,"context_only":true/);
});

test("chunk validation rejects context-page output before source pages can be clipped", () => {
  const document = emptyEbook(project);
  assert.throws(() => validateGeneratedChunk(document, { entries: [{
    action: "create", kind: "poem", title: "衢州見橘樹纍纍", lines: ["笑蹙長蛾熨齒酸。"],
    source_pages: [48], evidence_refs: ["p48:ocr:body"]
  }] }, { pageStart: 47, pageEnd: 47, pageBundles: bundles, openEntryIds: [] }), error =>
    error.diagnostics.some(item => item.code === "context_leak"));
});

test("chunk validation catches content supported only by context even with a false target reference", () => {
  const document = emptyEbook(project);
  assert.throws(() => validateGeneratedChunk(document, { entries: [{
    action: "create", kind: "poem", title: "衢州見橘樹纍纍", lines: ["笑蹙長蛾熨齒酸。", "酒闌常記手摻摻。"],
    source_pages: [47], evidence_refs: ["p47:ocr:title"]
  }] }, { pageStart: 47, pageEnd: 47, pageBundles: bundles, openEntryIds: [] }), error =>
    error.diagnostics.some(item => item.code === "context_leak" && item.target_score === 0));
});

test("only explicitly open entries can continue", () => {
  const document = emptyEbook(project);
  document.entries.push({ id: "entry-0001", kind: "poem", title: "自悼", lines: ["第一句"], prose: "", notes: [], source_pages: [47] });
  assert.throws(() => validateGeneratedChunk(document, { entries: [{
    action: "continue", continuation_of: "entry-0001", kind: "poem", lines: ["第二句"],
    source_pages: [48], evidence_refs: ["p48:ocr:body"]
  }] }, { pageStart: 48, pageEnd: 48, pageBundles: [{ ...bundles[1], context_only: false }], openEntryIds: [] }), error =>
    error.diagnostics.some(item => item.code === "invalid_continuation"));
});

test("open regulated verse skips line count but still enforces line width", () => {
  const document = emptyEbook(project);
  const pageBundles = [{ page_number: 48, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:body", text: "甲乙丙丁戊己庚辛壬癸子丑寅卯" }
  ] }] }];
  assert.throws(() => validateGeneratedChunk(document, { entries: [{
    action: "create", boundary_state: "open", kind: "poem", title: "", form: "七律",
    lines: ["甲乙丙丁戊己庚辛壬癸子丑寅卯。"], source_pages: [48], evidence_refs: ["p48:ocr:body"]
  }] }, { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }), error => {
    const codes = new Set(error.diagnostics.map(item => item.code));
    return codes.has("regulated_verse_line_width") && !codes.has("regulated_verse_line_count");
  });
});

test("continuations cannot repeat any line already stored in the open entry", () => {
  const document = emptyEbook(project);
  document.entries = [{ id: "entry-0001", kind: "poem", title: "", form: "七律",
    lines: ["甲乙丙丁戊己庚，", "辛壬癸子丑寅卯。"], prose: "", notes: [], source_pages: [47] }];
  const pageBundles = [{ page_number: 48, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:body", text: "辛壬癸子丑寅卯辰巳午未申酉戌" }
  ] }] }];
  assert.throws(() => validateGeneratedChunk(document, { entries: [{
    action: "continue", continuation_of: "entry-0001", boundary_state: "open", kind: "poem", form: "七律",
    lines: ["辛壬癸子丑寅卯。", "辰巳午未申酉戌，"], source_pages: [48], evidence_refs: ["p48:ocr:body"]
  }] }, { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: ["entry-0001"] }), error =>
    error.diagnostics.some(item => item.code === "continuation_overlap"));
});

test("continuation diagnostics use candidate-local line indexes", () => {
  const document = emptyEbook(project);
  document.entries = [{ id: "entry-0001", kind: "poem", title: "", form: "七律",
    lines: ["甲乙丙丁戊己庚，", "辛壬癸子丑寅卯。", "辰巳午未申酉戌，", "亥天地玄黃宇宙。"],
    prose: "", notes: [], source_pages: [47] }];
  const pageBundles = [{ page_number: 48, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:body", text: "日月盈昃辰宿列張寒來暑往秋收冬藏" }
  ] }] }];
  assert.throws(() => validateGeneratedChunk(document, { entries: [{
    action: "continue", continuation_of: "entry-0001", boundary_state: "open", kind: "poem", form: "七律",
    lines: ["日月盈昃辰宿列張寒來暑往秋收冬藏。"], source_pages: [48], evidence_refs: ["p48:ocr:body"]
  }] }, { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: ["entry-0001"] }), error => {
    const width = error.diagnostics.find(item => item.code === "regulated_verse_line_width");
    return width?.invalid_lines?.[0]?.index === 0 && width.invalid_lines[0].scope === "candidate";
  });
});

test("duplicate entries and repeated line runs fail the final hard check", () => {
  const document = emptyEbook(project);
  const entry = (id, lines) => ({ id, kind: "poem", title: "", lines, prose: "", notes: [], source_pages: [48] });
  document.entries = [
    entry("entry-0001", ["甲乙丙丁，", "戊己庚辛。", "甲乙丙丁，", "戊己庚辛。"]),
    entry("entry-0002", ["春夏秋冬，", "東南西北。"]),
    entry("entry-0003", ["春夏秋冬，", "東南西北。"])
  ];
  assert.throws(() => validateGeneratedDocument(document, { pageStart: 48, pageEnd: 48 }), error => {
    const codes = new Set(error.diagnostics.map(item => item.code));
    return codes.has("duplicate_line_run") && codes.has("duplicate_entry");
  });
});

test("a repeated single line in regulated verse is a hard error", () => {
  const document = emptyEbook(project);
  document.entries = [{ id: "entry-0001", kind: "poem", title: "", form: "七律",
    lines: ["甲乙丙丁戊己庚，", "辛壬癸子丑寅卯。", "辰巳午未申酉戌，", "甲乙丙丁戊己庚，"],
    prose: "", notes: [], source_pages: [48] }];
  assert.throws(() => validateGeneratedDocument(document, { pageStart: 48, pageEnd: 48 }), error =>
    error.diagnostics.some(item => item.code === "duplicate_line"));
});

test("poetry validation rejects a first-line title, merged lines and missing punctuation", () => {
  const document = emptyEbook(project);
  const pageBundles = [{ page_number: 48, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:body", text: "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌" }
  ] }] }];
  assert.throws(() => validateGeneratedChunk(document, { entries: [{
    action: "create", kind: "poem", title: "甲乙丙丁戊己庚", form: "七絕",
    lines: ["甲乙丙丁戊己庚", "辛壬癸子丑寅卯辰巳午未申酉戌"], source_pages: [48], evidence_refs: ["p48:ocr:body"]
  }] }, { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }), error => {
    const codes = new Set(error.diagnostics.map(item => item.code));
    return codes.has("title_matches_first_line") && codes.has("missing_line_punctuation") &&
      codes.has("regulated_verse_line_count") && codes.has("regulated_verse_line_width");
  });
});

test("pailu validation requires one punctuated sentence per line and complete couplets", () => {
  const document = emptyEbook(project);
  document.entries = [{ id: "entry-0001", kind: "poem", title: "長篇", form: "五言排律",
    lines: ["甲乙丙丁戊，", "己庚辛壬癸。", "子丑寅卯辰，"],
    prose: "", notes: [], source_pages: [48] }];
  assert.throws(() => validateGeneratedDocument(document, { pageStart: 48, pageEnd: 48 }), error =>
    error.diagnostics.some(item => item.code === "regulated_verse_pairing"));
});

test("citation titles in notes require consistent Chinese title marks", () => {
  const document = emptyEbook(project);
  const pageBundles = [{ page_number: 48, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:note", text: "晉書阮籍傳車駕所窮輒痛哭而返陸游詩屋窄似僧寮" }
  ] }] }];
  const candidate = text => ({ entries: [{
    action: "create", kind: "poem", title: "", lines: ["甲乙丙丁戊己庚。"], source_pages: [48],
    evidence_refs: ["p48:ocr:note"], notes: [{ position: { field: "lines", line: 1, offset: 7 }, text }]
  }] });

  assert.throws(() => validateGeneratedChunk(document,
    candidate("晉書阮籍傳：車駕所窮，輒痛哭而返。"),
    { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }), error =>
    error.diagnostics.some(item => item.code === "unmarked_citation_title"));

  assert.doesNotThrow(() => validateGeneratedChunk(document,
    candidate("書：蠶生九日不食。《晉書·阮籍傳》：車駕所窮，輒痛哭而返。陸游詩：屋窄似僧寮。"),
    { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }));
});

test("citation validation checks both the source book and named chapter", () => {
  const document = emptyEbook(project);
  const pageBundles = [{ page_number: 48, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:note", text: "楚辭有卜居篇虞翻別傳死以青蠅為弔客" }
  ] }] }];
  const candidate = text => ({ entries: [{
    action: "create", kind: "poem", lines: ["甲乙丙丁戊己庚。"], source_pages: [48],
    evidence_refs: ["p48:ocr:note"], notes: [{ position: { field: "lines", line: 1, offset: 7 }, text }]
  }] });

  assert.throws(() => validateGeneratedChunk(document,
    candidate("楚辭有《卜居》篇。《虞翻別傳》：死以青蠅為弔客。"),
    { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }), error =>
    error.diagnostics.some(item => item.excerpt === "楚辭"));
  assert.doesNotThrow(() => validateGeneratedChunk(document,
    candidate("《楚辭》有《卜居》篇。《虞翻別傳》：死以青蠅為弔客。"),
    { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }));
});

test("a group title printed once cannot be copied into multiple poem titles", () => {
  const document = emptyEbook(project);
  const pageBundles = [{ page_number: 48, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p48:ocr:group", text: "感懷雜咏第一首正文第二首正文" }
  ] }] }];
  const poem = (title, lines, series = null) => ({
    action: "create", kind: "poem", title, series, lines, source_pages: [48], evidence_refs: ["p48:ocr:group"]
  });

  assert.throws(() => validateGeneratedChunk(document, { entries: [
    poem("感懷雜咏", ["第一首正文。"]), poem("感懷雜咏", ["第二首正文。"]) ]
  }, { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }), error =>
    error.diagnostics.some(item => item.code === "repeated_work_title"));

  assert.doesNotThrow(() => validateGeneratedChunk(document, { entries: [
    poem("", ["第一首正文。"], { title: "感懷雜咏", index: 1, total: 2 }),
    poem("", ["第二首正文。"], { title: "感懷雜咏", index: 2, total: 2 }) ]
  }, { pageStart: 48, pageEnd: 48, pageBundles, openEntryIds: [] }));
});

test("a closed regulated verse cannot merge multiple poems or note prose", () => {
  const document = emptyEbook(project);
  document.entries = [{ id: "entry-0001", kind: "poem", title: "", form: "七律",
    lines: Array.from({ length: 16 }, (_, index) => `甲乙丙丁戊己${index % 10}`),
    prose: "", notes: [], source_pages: [45, 46] }];
  assert.throws(() => validateGeneratedDocument(document, { pageStart: 45, pageEnd: 46 }), error =>
    error.diagnostics.some(item => item.code === "regulated_verse_line_count" && item.actual === 16));

  document.entries[0].lines = ["甲乙丙丁戊己庚", "甲乙丙丁戊己庚", "甲乙丙丁戊己庚", "甲乙丙丁戊己庚",
    "甲乙丙丁戊己庚", "注文混入字數太長", "甲乙丙丁戊己庚", "甲乙丙丁戊己庚"];
  assert.throws(() => validateGeneratedDocument(document, { pageStart: 45, pageEnd: 46 }), error =>
    error.diagnostics.some(item => item.code === "regulated_verse_line_width"));
});

test("an open regulated verse may be incomplete but cannot exceed its fixed line count", () => {
  const document = emptyEbook(project);
  const verseLines = [..."庚辛壬癸子丑寅卯辰"].map(character => `甲乙丙丁戊己${character}。`);
  const pageBundles = [{ page_number: 46, context_only: false, results: [{ result_id: "ocr", regions: [
    { evidence_id: "p46:ocr:verse", text: verseLines.join("") }
  ] }] }];
  const poem = lineCount => ({
    action: "create", kind: "poem", title: "", form: "七言律詩", boundary_state: "open",
    lines: verseLines.slice(0, lineCount),
    source_pages: [46], evidence_refs: ["p46:ocr:verse"]
  });

  assert.doesNotThrow(() => validateGeneratedChunk(document, { entries: [poem(7)] }, {
    pageStart: 46, pageEnd: 46, pageBundles, openEntryIds: []
  }));
  assert.throws(() => validateGeneratedChunk(document, { entries: [poem(9)] }, {
    pageStart: 46, pageEnd: 46, pageBundles, openEntryIds: []
  }), error => error.diagnostics.some(item =>
    item.code === "regulated_verse_line_count" && item.expected === 8 && item.actual === 9));
});

test("full regulated-form names are validated and complete works cannot remain open", () => {
  const document = emptyEbook(project);
  mergeGenerated(document, { entries: [{
    kind: "poem", title: "長題", form: "七言律詩", boundary_state: "open",
    lines: Array.from({ length: 8 }, (_, index) => `甲乙丙丁戊己${index}。`), source_pages: [5], notes: []
  }] }, 5, 5);
  assert.deepEqual(document.generation.open_entries, []);

  document.entries[0].form = "七言絕句";
  assert.throws(() => validateGeneratedDocument(document, { pageStart: 5, pageEnd: 5 }), error =>
    error.diagnostics.some(item => item.code === "regulated_verse_line_count" && item.expected === 4));
});

test("prompt exposes exact remaining line count for open regulated verse", () => {
  const prompt = buildEbookPrompt("Book", bundles, [{
    id: "entry-0009", kind: "poem", form: "七律", lines: ["第一句", "第二句", "第三句"],
    line_count: 3, expected_line_count: 8, remaining_line_count: 5, boundary_state: "open"
  }]);
  assert.match(prompt, /"line_count":3/);
  assert.match(prompt, /"remaining_line_count":5/);
});
