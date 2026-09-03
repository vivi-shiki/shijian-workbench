import assert from "node:assert/strict";
import test from "node:test";
import {
  annotatedTextSegments,
  chineseNumber,
  circledNumber,
  displayedNoteText,
  displayedSeriesTitle,
  poemParagraphs,
  proseParagraphs,
  seriesOrdinal
} from "../src/ebook-format.js";

test("series indexes use Chinese ordinals without exposing Arabic numbers", () => {
  assert.equal(seriesOrdinal(1), "其一");
  assert.equal(seriesOrdinal(10), "其十");
  assert.equal(seriesOrdinal(12), "其十二");
  assert.equal(seriesOrdinal(24), "其二十四");
  assert.equal(chineseNumber(null), "");
});

test("series titles hide poem counts only in the formatted view", () => {
  assert.equal(displayedSeriesTitle("催粧詩六首"), "催粧詩");
  assert.equal(displayedSeriesTitle("無題12首"), "無題");
  assert.equal(displayedSeriesTitle("燈宵記事"), "燈宵記事");
});

test("regulated verse renders two lines per paragraph without changing source lines", () => {
  const lines = ["第一句，", "第二句。", "第三句，", "第四句。"];
  assert.deepEqual(poemParagraphs(lines, "七言絕句"), [
    [{ text: "第一句，", line: 1 }, { text: "第二句。", line: 2 }],
    [{ text: "第三句，", line: 3 }, { text: "第四句。", line: 4 }]
  ]);
  assert.deepEqual(lines, ["第一句，", "第二句。", "第三句，", "第四句。"]);
});

test("non-regulated verse retains one source line per paragraph", () => {
  assert.deepEqual(poemParagraphs(["上句", "下句"], "詞"), [
    [{ text: "上句", line: 1 }],
    [{ text: "下句", line: 2 }]
  ]);
});

test("classical and extended regulated verse render two lines per paragraph", () => {
  const lines = ["第一句，", "第二句。", "第三句，", "第四句。"];
  assert.equal(poemParagraphs(lines, "五排").length, 2);
  assert.equal(poemParagraphs(lines, "古詩").length, 2);
});

test("annotation segments insert numbered callouts at exact character offsets", () => {
  const notes = [
    { position: { field: "lines", line: 1, offset: 2 }, text: "甲注" },
    { position: { field: "lines", line: 1, offset: 4 }, text: "乙注" }
  ];
  assert.deepEqual(annotatedTextSegments("甲乙丙丁", notes, "lines", 1), [
    { text: "甲乙" }, { noteNumber: 1 }, { text: "丙丁" }, { noteNumber: 2 }
  ]);
});

test("notes use literal circled-number characters and display terminal punctuation", () => {
  assert.equal(circledNumber(1), "①");
  assert.equal(circledNumber(20), "⑳");
  assert.equal(circledNumber(21), "㉑");
  assert.equal(displayedNoteText("庾信詩洞房花燭明"), "庾信詩洞房花燭明。");
  assert.equal(displayedNoteText("原注已具。"), "原注已具。");
  assert.equal(displayedNoteText("庾信詩：“洞房花燭明。”"), "庾信詩：“洞房花燭明。”");
});

test("classical prose blank lines become semantic display paragraphs", () => {
  assert.deepEqual(proseParagraphs("第一段。\n\n第二段。\n\n\n第三段。"), ["第一段。", "第二段。", "第三段。"]);
});
