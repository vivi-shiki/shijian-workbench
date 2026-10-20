import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { atomicJson, ProjectStore, safeId } from "../../oldbook-core/src/project-store.mjs";
import { HistoryStore, hashJson } from "../../oldbook-core/src/change-history.mjs";
import { EbookStore } from "../../oldbook-core/src/ebook-store.mjs";
import { EbookCandidates, buildCandidateOutput } from "../../oldbook-core/src/ebook-candidates.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({ options: { project: { type: "string" }, run: { type: "string" },
  "from-page": { type: "string" } } });
const id = safeId(values.project);
const runId = safeId(values.run);
const fromPage = Number(values["from-page"] || 43);
const projects = path.join(root, "data/projects");
const directory = path.join(projects, id);
const history = new HistoryStore(projects);
const candidates = new EbookCandidates(history);
const run = await history.readRun(id, runId);
if (run.manifest.source !== "ebook-candidate" || run.manifest.status !== "awaiting_approval") {
  throw new Error("Only a pending model candidate may be recovered");
}
const progressFile = path.join(directory, "references", `revision-progress-from-${fromPage}.json`);
const plan = JSON.parse(await fs.readFile(path.join(directory, "references", `match-plan-from-${fromPage}.json`), "utf8"));
const progress = JSON.parse(await fs.readFile(progressFile, "utf8"));
const task = run.input.task;
const poems = task.reference_verses.map(item => item.entry_id);
const current = JSON.parse(await fs.readFile(path.join(directory, "ebook/structured.json"), "utf8"));
const repaired = structuredClone(current);
for (const entryId of poems) {
  if (progress.completed.some(item => item.entry_id === entryId)) throw new Error(`${entryId} already completed`);
  const revised = run.output.candidate.entries.find(entry => entry.id === entryId);
  const index = repaired.entries.findIndex(entry => entry.id === entryId);
  if (!revised || index < 0) throw new Error(`${entryId} missing in model candidate or current book`);
  repaired.entries[index] = revised;
}
const derived = await history.startRun(id, {
  actor: "ai:codex", source: "reference-poem-scope", provider: run.manifest.provider,
  model: run.manifest.model,
  note: "从单次模型结果保留目标诗歌，恢复模型误改的非目标条目",
  options: { source_run_id: runId, revision_mode: "single_revision", apply_mode: "direct_overwrite" },
  input: { task, source_run_id: runId, source_candidate_hash: run.output.candidate_hash,
    baseline_hash: hashJson(current) }
});
const output = buildCandidateOutput({ kind: "ebook-candidate", baseline: current, candidate: repaired,
  model_run_id: runId, target_entry_ids: poems, page_range: run.output.page_range });
await history.finishRun(id, derived.id, { status: "awaiting_approval", output });
const ebookStore = new EbookStore(projects, new ProjectStore(projects, history), history);
await candidates.approve(id, derived.id, {
  candidate_hash: output.candidate_hash, note: `用户要求 ${poems.join(",")} 单次修订并直接覆盖；恢复非目标条目`,
  channel: "agent", requested_by: "human"
}, ebookStore, { actor: "ai:codex", channel: "agent", requested_by: "human" });
await candidates.abandon(id, runId, { note: `非目标条目已由 ${derived.id} 恢复`,
  channel: "agent", requested_by: "human" }, { actor: "ai:codex", channel: "agent", requested_by: "human" });
for (const entryId of poems) {
  const match = plan.matches.find(item => item.entry_id === entryId);
  progress.completed.push({ entry_id: entryId, source_pages: match.source_pages,
    run_id: derived.id, model_run_id: runId, reference_ids: match.matches.map(item => item.work_id),
    top_score: match.matches[0]?.score || 0 });
}
await atomicJson(progressFile, progress);
console.log(JSON.stringify({ recovered: poems, run_id: derived.id, model_run_id: runId,
  approved: progress.completed.length }));
