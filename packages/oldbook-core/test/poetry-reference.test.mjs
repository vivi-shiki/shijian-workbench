import test from "node:test";
import assert from "node:assert/strict";
import { parsePoetryReference, findReferenceVerses } from "../src/poetry-reference.mjs";
import { buildReviewMessages, validateTask } from "../src/ebook-review.mjs";

test("reference parser separates series poems and joins wrapped notes", () => {
  const source = "甲子年\n无题二首\n春风花月夜，诗酒故人来。清风明月在，一梦到江南。\n秋雨梧桐落，故人千里遥。昨夜庭中月，今朝照旧桥。\n别题\n山色入帘青，流水绕门前。何人来问字，归去种桑田。（旧注正\n似前人所云。）";
  const reference = parsePoetryReference(source, "sample.txt");
  assert.equal(reference.work_count, 3);
  assert.deepEqual(reference.works.slice(0, 2).map(work => work.series_index), [1, 2]);
  assert.equal(reference.works[0].series_total, 2);
  assert.equal(reference.works[2].source_lines[1], 7);
  assert.match(reference.works[2].text, /似前人所云/u);
  const matches = findReferenceVerses({ lines: ["春風花月夜，", "詩酒故人來。", "清風明月在，", "一夢到江南。"] }, reference);
  assert.equal(matches[0].work_id, "work-0001");
});

test("single revision and direct overwrite are explicit task modes in the prompt", () => {
  const task = { schema_version: 1, id: "sample", mode: "structure", scope: "local",
    category: "poem", entry_ids: ["entry-0001"], result_ids: ["ocr-a"], rules: ["保留作品边界"],
    revision_mode: "single_revision", apply_mode: "direct_overwrite",
    reference_verses: [{ entry_id: "entry-0001", matches: [{ work_id: "work-0001", text: "参考诗句" }] }] };
  assert.equal(validateTask(task), task);
  const messages = buildReviewMessages("Book", task, [], []);
  assert.match(messages[0].content, /参考文档/u);
  assert.match(messages[1].content, /参考诗句/u);
  assert.throws(() => validateTask({ ...task, revision_mode: "unknown" }), /revision_mode/u);
});
