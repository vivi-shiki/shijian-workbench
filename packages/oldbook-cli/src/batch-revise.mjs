import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { atomicJson, ProjectStore, safeId } from "../../oldbook-core/src/project-store.mjs";
import { HistoryStore, hashJson } from "../../oldbook-core/src/change-history.mjs";
import { EbookStore } from "../../oldbook-core/src/ebook-store.mjs";
import { buildCandidateOutput } from "../../oldbook-core/src/ebook-candidates.mjs";
import { EbookReview } from "../../oldbook-core/src/ebook-review.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({ options: { project: { type: "string" },
  "from-page": { type: "string" }, parallel: { type: "string" }, limit: { type: "string" } } });
const id = safeId(values.project || "yiyuji-four-volumes");
for (const name of [".env.local", ".env"]) {
  try { process.loadEnvFile(path.join(root, name)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const directory = path.join(root, "data/projects", id);
const fromPage = Number(values["from-page"] || 43);
const plan = JSON.parse(await fs.readFile(path.join(directory, `references/match-plan-from-${fromPage}.json`), "utf8"));
const progressFile = path.join(directory, `references/revision-progress-from-${fromPage}.json`);
const progress = JSON.parse(await fs.readFile(progressFile, "utf8"));
const done = new Set(progress.completed.map(item => item.entry_id));
const priorFailures = new Set(progress.failures.map(item => item.entry_id));
const failedThisRun = new Set();
const projects = path.join(root, "data/projects");
const history = new HistoryStore(projects);
const review = new EbookReview(projects, history);
const ebookStore = new EbookStore(projects, new ProjectStore(projects, history), history);
const parallel = Math.max(1, Math.min(4, Number(values.parallel || 3)));
const cap = Math.max(1, Number(values.limit || Number.MAX_SAFE_INTEGER));
let attempted = 0;

const readDocument = async () => JSON.parse(await fs.readFile(path.join(directory, "ebook/structured.json"), "utf8"));
function makeGroups(document) {
  const groups = [];
  const indices = new Map(document.entries.map((entry, index) => [entry.id, index]));
  for (let at = 0; at < plan.matches.length;) {
    const first = plan.matches[at];
    if (done.has(first.entry_id) || failedThisRun.has(first.entry_id) || !indices.has(first.entry_id)) { at++; continue; }
    const selected = [first];
    const firstIndex = indices.get(first.entry_id);
    let lastIndex = firstIndex;
    const ordinal = Number(first.entry_id.slice(6));
    const maxSelected = ordinal >= 962 ? 1 : ordinal >= 805 ? 2 : 5;
    while (!priorFailures.has(first.entry_id) && selected.length < maxSelected &&
        at + selected.length < plan.matches.length) {
      const next = plan.matches[at + selected.length];
      const index = indices.get(next.entry_id);
      if (done.has(next.entry_id) || failedThisRun.has(next.entry_id) ||
          priorFailures.has(next.entry_id) || index == null || index < lastIndex ||
          JSON.stringify(document.entries.slice(firstIndex, index + 1)).length > 8500) break;
      selected.push(next);
      lastIndex = index;
    }
    groups.push({ selected, targetEntries: document.entries.slice(firstIndex, lastIndex + 1) });
    at += selected.length;
  }
  return groups;
}
function makeTask(group) {
  const { selected, targetEntries } = group;
  return { schema_version: 1,
    id: `reference-revise-${selected[0].entry_id}-${selected.at(-1).entry_id}`,
    mode: "structure", scope: "local", category: "逐首诗歌单次修订",
    entry_ids: targetEntries.map(entry => entry.id), result_ids: ["paddleocr-vl", "pp-ocrv6"],
    revision_mode: "single_revision", apply_mode: "direct_overwrite",
    reference_verses: selected.map(item => ({ entry_id: item.entry_id, matches: item.matches })),
    rules: ["本轮每首诗都修订一次，保留所有目标 id、原有作品边界及夹在诗歌之间的 heading；不增删条目。对照各自 entry_id 的参考诗句、页面 OCR 及现有注释核对文字。",
      "参考本为另一文字版本。相似度低、内容冲突或无法对应时，优先保留有原页 OCR 支持的文字，把疑点写入 issues。",
      "本项目为繁体印本，参考 TXT 含简体。新结果须采用原页 OCR 支持的繁体字形，不要直接沿用参考 TXT 的简体字形。",
      "保留原有注文，不因参考 TXT 没有注文而删除；根据实际修改重核注码。"] };
}
async function applyGroup(group, task, output) {
  const current = await readDocument();
  const repaired = structuredClone(current);
  for (const item of group.selected) {
    const revised = output.candidate.entries.find(entry => entry.id === item.entry_id);
    const index = repaired.entries.findIndex(entry => entry.id === item.entry_id);
    if (!revised || index < 0) throw new Error(`Candidate removed ${item.entry_id}; run=${output.run_id}`);
    repaired.entries[index] = revised;
  }
  const derived = await history.startRun(id, { actor: "ai:codex", source: "reference-poem-scope",
    provider: "siliconflow", model: process.env.SILICONFLOW_MODEL || "deepseek-ai/DeepSeek-V3.2",
    note: "按当前正式本保留模型修订的目标诗歌，恢复非目标条目",
    options: { source_run_id: output.run_id, revision_mode: "single_revision",
      apply_mode: "direct_overwrite", task_id: task.id },
    input: { task, source_run_id: output.run_id, source_candidate_hash: output.candidate_hash,
      baseline_hash: hashJson(current) } });
  const scoped = buildCandidateOutput({ kind: "ebook-candidate", baseline: current,
    candidate: repaired, model_run_id: output.run_id, page_range: output.page_range,
    target_entry_ids: group.selected.map(item => item.entry_id) });
  await history.finishRun(id, derived.id, { status: "awaiting_approval", output: scoped });
  await review.apply(id, derived.id, { candidate_hash: scoped.candidate_hash,
    note: `用户要求 ${group.selected.map(item => item.entry_id).join(",")} 单次修订、参考 TXT 并直接覆盖`,
    channel: "agent", requested_by: "human" }, ebookStore,
  { actor: "ai:codex", channel: "agent", requested_by: "human" });
  await review.candidates.abandon(id, output.run_id, {
    note: `已由 ${derived.id} 基于当前正式本批准目标诗歌`, channel: "agent", requested_by: "human"
  }, { actor: "ai:codex", channel: "agent", requested_by: "human" });
  for (const item of group.selected) {
    progress.completed.push({ entry_id: item.entry_id, source_pages: item.source_pages,
      run_id: derived.id, model_run_id: output.run_id,
      reference_ids: item.matches.map(match => match.work_id),
      top_score: item.matches[0]?.score ?? 0 });
    done.add(item.entry_id);
  }
  await atomicJson(progressFile, progress);
  console.log(`${progress.completed.length}/${plan.entry_count} ${group.selected.map(item => item.entry_id).join(",")} approved ${derived.id}`);
}

while (attempted < cap) {
  const document = await readDocument();
  const groups = makeGroups(document).slice(0, Math.min(parallel, cap - attempted));
  if (!groups.length) break;
  attempted += groups.reduce((sum, group) => sum + group.selected.length, 0);
  const tasks = groups.map(makeTask);
  const results = await Promise.allSettled(tasks.map(task => review.generate(id, task)));
  for (let index = 0; index < groups.length; index++) {
    const result = results[index];
    try {
      if (result.status === "rejected") throw result.reason;
      await applyGroup(groups[index], tasks[index], result.value);
    } catch (error) {
      for (const item of groups[index].selected) {
        progress.failures.push({ entry_id: item.entry_id,
          error: error.message, at: new Date().toISOString() });
        priorFailures.add(item.entry_id);
        failedThisRun.add(item.entry_id);
      }
      await atomicJson(progressFile, progress);
      console.error(`${groups[index].selected.map(item => item.entry_id).join(",")} failed: ${error.message}`);
    }
  }
}
console.log(JSON.stringify({ total: plan.entry_count, approved: progress.completed.length,
  unresolved: plan.matches.filter(item => !done.has(item.entry_id)).length,
  failures: progress.failures.length }));
