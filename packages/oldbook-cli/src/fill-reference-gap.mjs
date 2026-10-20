import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, ProjectStore } from "../../oldbook-core/src/project-store.mjs";
import { HistoryStore, hashJson } from "../../oldbook-core/src/change-history.mjs";
import { EbookStore, validateEbook } from "../../oldbook-core/src/ebook-store.mjs";
import { EbookCandidates, buildCandidateOutput } from "../../oldbook-core/src/ebook-candidates.mjs";
import { normalizeVerse } from "../../oldbook-core/src/poetry-reference.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const id = "yiyuji-four-volumes";
const projects = path.join(root, "data/projects");
const directory = path.join(projects, id);
const reference = JSON.parse(await fs.readFile(path.join(directory, "references/yiyuji-txt.json"), "utf8"));
const current = JSON.parse(await fs.readFile(path.join(directory, "ebook/structured.json"), "utf8"));
const ocr = await Promise.all(["paddleocr-vl", "pp-ocrv6"].map(async name =>
  JSON.parse(await fs.readFile(path.join(directory, `results/${name}.json`), "utf8"))));
const works = reference.works.slice(276, 436);
const pages = Array.from({ length: 68 }, (_, index) => index + 131);
const pageTexts = pages.map(number => normalizeVerse(ocr.map(result => {
  const page = result.pages.find(item => item.page_number === number);
  return page?.regions?.map(region => region.edited_text || region.reading_text || region.raw_text || "").join("") || "";
}).join("")));
const grams = value => {
  const set = new Set();
  for (let index = 0; index < value.length - 1; index++) set.add(value.slice(index, index + 2));
  return set;
};
const pageGrams = pageTexts.map(grams);
const score = (work, pageIndex) => {
  const verse = normalizeVerse(work.text);
  const pairs = grams(verse);
  let hits = 0;
  for (const pair of pairs) if (pageGrams[pageIndex].has(pair)) hits++;
  const first = verse.slice(0, 14);
  const last = verse.slice(-14);
  const start = pageTexts[pageIndex].includes(first) ? .16 : 0;
  const end = pageTexts[pageIndex].includes(last) ? .08 : 0;
  return hits / (pairs.size || 1) + start + end;
};
const matrix = works.map(work => pages.map((_, index) => score(work, index)));
// Each poem receives one anchor page. The sequence constraint keeps repeated verses
// and OCR commentary from moving a poem to another part of the volume.
const dp = works.map(() => pages.map(() => -Infinity));
const back = works.map(() => pages.map(() => -1));
dp[0][0] = matrix[0][0];
for (let i = 1; i < works.length; i++) {
  for (let j = 0; j < pages.length; j++) {
    for (let k = Math.max(0, j - 3); k <= j; k++) {
      const gapPenalty = Math.max(0, j - k - 1) * .16;
      const value = dp[i - 1][k] + matrix[i][j] - gapPenalty;
      if (value > dp[i][j]) { dp[i][j] = value; back[i][j] = k; }
    }
  }
}
let cursor = pages.length - 1;
const anchors = works.map(() => 0);
for (let i = works.length - 1; i >= 0; i--) {
  anchors[i] = cursor;
  cursor = back[i][cursor];
}
const splitLines = text => String(text).match(/[^，。！？；]+[，。！？；]?/gu)?.map(line => line.trim()).filter(Boolean) || [];
const newEntries = works.map((work, index) => {
  const anchor = anchors[index];
  const selectedPages = [pages[anchor]];
  // A long work can continue across adjacent pages. Require independent verse overlap.
  if (normalizeVerse(work.text).length > 110) {
    for (const adjacent of [anchor - 2, anchor - 1, anchor + 1, anchor + 2]) {
      if (adjacent >= 0 && adjacent < pages.length && matrix[index][adjacent] >= .13) selectedPages.push(pages[adjacent]);
    }
  }
  // The long 栎园姨翁 poem starts on P195 and continues through P197;
  // commentary dilutes page-level overlap, so retain all three OCR pages.
  if (work.id === "work-0435") selectedPages.push(195, 196, 197);
  const lines = splitLines(work.text);
  const width = lines.map(normalizeVerse).map(line => line.length);
  const form = lines.length === 8 && width.every(value => value === 5) ? "五律"
    : lines.length === 8 && width.every(value => value === 7) ? "七律"
    : lines.length === 4 && width.every(value => value === 5) ? "五絕"
    : lines.length === 4 && width.every(value => value === 7) ? "七絕" : "";
  return { id: `entry-${String(805 + index).padStart(4, "0")}`, kind: "poem",
    title: work.series_index === 1 ? work.title : "", subtitle: "", author: "", form,
    heading_level: null, series: work.series_total > 1 ? { title: work.title,
      index: work.series_index, total: work.series_total } : null,
    lines, prose: "", notes: [], source_pages: [...new Set(selectedPages)].sort((a, b) => a - b),
    confidence: Math.max(.2, Math.min(.75, matrix[index][anchor])), review_status: "needs_review" };
});
const report = { schema_version: 1, project_id: id, work_range: [works[0].id, works.at(-1).id],
  page_range: [pages[0], pages.at(-1)], poem_count: newEntries.length,
  mapping: works.map((work, index) => ({ work_id: work.id, entry_id: newEntries[index].id,
    source_pages: newEntries[index].source_pages, score: Math.round(matrix[index][anchors[index]] * 1000) / 1000,
    first_verse: normalizeVerse(work.text).slice(0, 16) })) };
await atomicJson(path.join(directory, "references/gap-mapping-report.json"), report);
console.log(JSON.stringify({ count: report.poem_count,
  low_score: report.mapping.filter(item => item.score < .16).length,
  page_131: report.mapping.filter(item => item.source_pages.includes(131)),
  page_198: report.mapping.filter(item => item.source_pages.includes(198)),
  samples: report.mapping.filter((_, index) => index % 20 === 0) }, null, 2));
if (!process.argv.includes("--apply")) process.exit(0);
if (newEntries.some(entry => current.entries.some(existing => existing.id === entry.id))) {
  throw new Error("Gap entries already exist; review the approved insertion run before applying again");
}
const repaired = structuredClone(current);
const insertAt = repaired.entries.findIndex(entry => entry.source_pages.some(page => page >= 203));
repaired.entries.splice(insertAt, 0, ...newEntries);
validateEbook(repaired, id);
const history = new HistoryStore(projects);
const ebookStore = new EbookStore(projects, new ProjectStore(projects, history), history);
const candidates = new EbookCandidates(history);
const run = await history.startRun(id, { actor: "ai:codex", source: "reference-gap-structure",
  provider: "local", model: "TXT-OCR-sequence-alignment",
  note: "按参考 TXT 与双 OCR 顺序对齐补录卷二第 131–198 页缺失的诗歌",
  input: { source_sha256: reference.source_sha256, baseline_hash: hashJson(current),
    work_ids: works.map(work => work.id), mapping: report.mapping } });
const output = buildCandidateOutput({ kind: "ebook-generation-candidate", baseline: current,
  candidate: repaired, page_range: { start: 131, end: 198 },
  new_entry_ids: newEntries.map(entry => entry.id) });
await history.finishRun(id, run.id, { status: "awaiting_approval", output });
await candidates.approve(id, run.id, { candidate_hash: output.candidate_hash,
  note: "用户授权补齐第 43 页以后全部诗歌并自动覆盖，先补录缺失作品，随后逐首模型修订",
  channel: "agent", requested_by: "human" }, ebookStore,
{ actor: "ai:codex", channel: "agent", requested_by: "human" });
console.log(JSON.stringify({ approved_run_id: run.id, inserted_poems: newEntries.length }));
