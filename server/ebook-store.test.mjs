import assert from "node:assert/strict";
import test from "node:test";
import { buildEbookPrompt, emptyEbook, mergeGenerated, migrateLegacyNotePositions, parseModelJson, validateEbook } from "./ebook-store.mjs";

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
  assert.doesNotMatch(prompt, /疑雨集注/);
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
    entries: [{ kind: "poem", title: "花燭詞", series: { title: "無題", index: 1, total: 2 }, lines: ["第一句"], source_pages: [4], confidence: 0.9 }],
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
