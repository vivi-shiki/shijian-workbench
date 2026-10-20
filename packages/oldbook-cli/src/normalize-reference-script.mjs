import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicJson, ProjectStore } from "../../oldbook-core/src/project-store.mjs";
import { HistoryStore, hashJson } from "../../oldbook-core/src/change-history.mjs";
import { EbookStore } from "../../oldbook-core/src/ebook-store.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const id = "yiyuji-four-volumes";
const projects = path.join(root, "data/projects");
const directory = path.join(projects, id);
const filename = path.join(directory, "ebook/structured.json");
const document = JSON.parse(await fs.readFile(filename, "utf8"));
const targets = document.entries.filter(entry => entry.kind === "poem" &&
  entry.source_pages.some(page => page >= 43));
const chars = [...new Set([...targets.flatMap(entry => [entry.title, entry.series?.title,
  ...(entry.lines || [])]).join("")].filter(char => /\p{Script=Han}/u.test(char)))];
const ps = [
  "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
  "$chars = $json | ConvertFrom-Json",
  "$map = @{}",
  "foreach ($char in $chars) { $map[$char] = [Microsoft.VisualBasic.Strings]::StrConv([string]$char, [Microsoft.VisualBasic.VbStrConv]::TraditionalChinese, 0) }",
  "$map | ConvertTo-Json -Compress -Depth 3"
].join("; ");
const converted = spawnSync("pwsh", ["-NoProfile", "-Command", ps], {
  input: Buffer.from(JSON.stringify(chars), "utf8").toString("base64"),
  encoding: "utf8", maxBuffer: 2_000_000
});
if (converted.status !== 0 || converted.stderr.trim()) {
  throw new Error(converted.stderr || "Traditional script converter failed");
}
const map = JSON.parse(converted.stdout);
const results = await Promise.all(["paddleocr-vl", "pp-ocrv6"].map(async name =>
  JSON.parse(await fs.readFile(path.join(directory, `results/${name}.json`), "utf8"))));
const pageText = new Map();
for (const entry of targets) for (const number of entry.source_pages) {
  if (pageText.has(number)) continue;
  pageText.set(number, results.map(result => {
    const page = result.pages.find(item => item.page_number === number);
    return page?.regions?.map(region => region.edited_text || region.reading_text || region.raw_text || "").join("") || "";
  }).join("").replace(/\s/gu, ""));
}
function normalizeField(value, ocr) {
  const original = [...String(value || "")];
  const full = original.map(char => map[char] || char);
  return original.map((char, index) => {
    const candidate = full[index];
    if (candidate === char || [...candidate].length !== 1) return char;
    const left = full[index - 1];
    const right = full[index + 1];
    if ((left && ocr.includes(left + candidate)) ||
        (right && ocr.includes(candidate + right))) return candidate;
    return char;
  }).join("");
}
const changes = [];
for (const entry of targets) {
  const ocr = entry.source_pages.map(number => pageText.get(number) || "").join("");
  for (const field of ["title", "subtitle"]) {
    const before = entry[field];
    const after = normalizeField(before, ocr);
    if (after !== before) { entry[field] = after; changes.push({ entry_id: entry.id, field, before, after }); }
  }
  if (entry.series?.title) {
    const before = entry.series.title;
    const after = normalizeField(before, ocr);
    if (after !== before) { entry.series.title = after;
      changes.push({ entry_id: entry.id, field: "series.title", before, after }); }
  }
  entry.lines = entry.lines.map((before, index) => {
    const after = normalizeField(before, ocr);
    if (after !== before) changes.push({ entry_id: entry.id, field: `lines.${index}`, before, after });
    return after;
  });
}
console.log(JSON.stringify({ entries: targets.length, changed_fields: changes.length,
  changed_entries: new Set(changes.map(item => item.entry_id)).size, samples: changes.slice(0, 12) }, null, 2));
await atomicJson(path.join(directory, "references/script-normalization-report.json"), {
  schema_version: 1, project_id: id, changed_fields: changes.length, changes
});
if (!process.argv.includes("--apply") || !changes.length) process.exit(0);
const history = new HistoryStore(projects);
const store = new EbookStore(projects, new ProjectStore(projects, history), history);
const baseline = JSON.parse(await fs.readFile(filename, "utf8"));
await store.save(id, document, { actor: "ai:codex", source: "ocr-supported-script-normalization",
  note: "按原页双 OCR 可见字形，将参考 TXT 留下的简体字形复归为繁体印本字形",
  expected_hash: hashJson(baseline) });
console.log("Script normalization applied with an append-only change record");
