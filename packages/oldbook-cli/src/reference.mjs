import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { atomicJson, safeId } from "../../oldbook-core/src/project-store.mjs";
import { parsePoetryReference, findReferenceVerses } from "../../oldbook-core/src/poetry-reference.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({ options: { project: { type: "string" }, input: { type: "string" },
  output: { type: "string" }, "from-page": { type: "string" } } });
const project = safeId(values.project);
const source = await fs.readFile(path.resolve(values.input), "utf8");
const reference = parsePoetryReference(source, path.basename(values.input));
const directory = path.join(root, "data/projects", project);
const output = values.output ? path.resolve(values.output) : path.join(directory, "references/yiyuji-txt.json");
await atomicJson(output, reference);
const ebook = JSON.parse(await fs.readFile(path.join(directory, "ebook/structured.json"), "utf8"));
const fromPage = Number(values["from-page"] || 43);
const targetEntries = ebook.entries.filter(entry => entry.kind === "poem" &&
  entry.source_pages.some(page => page >= fromPage));
const matches = targetEntries.map(entry => ({ entry_id: entry.id, source_pages: entry.source_pages,
  method: "verse_similarity", matches: findReferenceVerses(entry, reference) }));
const ordinal = item => Number(item?.matches?.[0]?.work_id?.slice(5));
for (let index = 0; index < matches.length; index++) {
  if ((matches[index].matches[0]?.score || 0) >= 0.2) continue;
  let before = index - 1;
  while (before >= 0 && (matches[before].matches[0]?.score || 0) < 0.35) before--;
  let after = index + 1;
  while (after < matches.length && (matches[after].matches[0]?.score || 0) < 0.35) after++;
  const lower = before >= 0 ? ordinal(matches[before]) : 1;
  const upper = after < matches.length ? ordinal(matches[after]) : reference.work_count;
  if (lower > upper) continue;
  const local = findReferenceVerses(targetEntries[index], reference, {
    minWork: Math.max(1, lower - 2), maxWork: Math.min(reference.work_count, upper + 2)
  });
  if (local.length) {
    matches[index].matches = local;
    matches[index].method = "sequence_window";
  }
}
const plan = path.join(directory, "references", `match-plan-from-${fromPage}.json`);
await atomicJson(plan, { schema_version: 1, project_id: project, from_page: fromPage,
  source_sha256: reference.source_sha256, entry_count: matches.length, matches });
console.log(JSON.stringify({ output, work_count: reference.work_count, match_plan: plan,
  entry_count: matches.length, low_score: matches.filter(item => (item.matches[0]?.score || 0) < 0.2).length }, null, 2));
