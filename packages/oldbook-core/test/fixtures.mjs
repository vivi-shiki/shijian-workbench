import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyEbook } from "../src/ebook-store.mjs";
import { HistoryStore } from "../src/change-history.mjs";
import { EbookReview } from "../src/ebook-review.mjs";

export function entry(id = "entry-0001", page = 2) {
  return { id, kind: "poem", title: "測試", subtitle: "", author: "", form: "五絕", prose: "",
    series: null, heading_level: null, lines: ["甲乙丙丁戊，", "己庚辛壬癸。", "子丑寅卯辰，", "巳午未申酉。"],
    notes: [], source_pages: [page], review_status: "needs_review" };
}

export function baseline() {
  return { ...emptyEbook({ id: "book", title: "測試書" }), entries: [entry(), entry("entry-0002", 3)] };
}

export const task = () => ({ schema_version: 1, id: "test-boundary", mode: "structure", scope: "general",
  category: "cross_page_boundary", entry_ids: ["entry-0001"], result_ids: ["vl", "ocr"],
  rules: ["Check boundaries against both OCR sources; retain uncertain text."] });

export const suite = () => ({ schema_version: 1, project_id: "book", cases: [
  { id: "line-count", status: "proposed", pages: [2], selector: { id: "entry-0001" }, expect: { count: 1, line_count: 4 } }
] });

export async function workspace(t, fetchImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oldbook-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "book");
  await fs.mkdir(path.join(project, "ebook"), { recursive: true });
  await fs.mkdir(path.join(project, "results"));
  const document = baseline();
  const filename = path.join(project, "ebook/structured.json");
  await fs.writeFile(filename, JSON.stringify(document));
  const result = { pages: [1, 2, 3].map(n => ({ page_number: n, image_path: `page-${n}.png`, width: 100, height: 200,
    regions: [{ id: "r1", order: 1, bbox: [1, 2, 3, 4], raw_text: "raw OCR", edited_text: n === 2 ? "" : "edited OCR" }] })) };
  for (const id of ["vl", "ocr"]) await fs.writeFile(path.join(project, "results", `${id}.json`), JSON.stringify(result));
  const skillPath = path.join(root, "SKILL.md");
  await fs.writeFile(skillPath, "Test-only skill revision");
  const history = new HistoryStore(root);
  const calls = [];
  const review = new EbookReview(root, history, { skillPath, fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    if (fetchImpl) return fetchImpl(url, options);
    const targets = JSON.parse(request.messages[1].content).targets;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entries: targets, issues: [] }) } }] }));
  } });
  return { root, filename, document, history, review, calls, config: { apiKey: "TEST-KEY-NOT-REAL" } };
}
