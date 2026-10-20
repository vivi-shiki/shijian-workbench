import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { safeId } from "../../oldbook-core/src/project-store.mjs";
import { validateEbook } from "../../oldbook-core/src/ebook-store.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({ options: { project: { type: "string" },
  "from-page": { type: "string" } } });
const id = safeId(values.project || "yiyuji-four-volumes");
const fromPage = Number(values["from-page"] || 43);
const directory = path.join(root, "data/projects", id);
const read = async filename => JSON.parse(await fs.readFile(filename, "utf8"));
const plan = await read(path.join(directory, `references/match-plan-from-${fromPage}.json`));
const progress = await read(path.join(directory, `references/revision-progress-from-${fromPage}.json`));
const reference = await read(path.join(directory, "references/yiyuji-txt.json"));
const document = validateEbook(await read(path.join(directory, "ebook/structured.json")), id);
const expected = new Set(document.entries.filter(entry => entry.kind === "poem" &&
  entry.source_pages.some(page => page >= fromPage)).map(entry => entry.id));
const planned = new Set(plan.matches.map(item => item.entry_id));
const completed = new Map();
const errors = [];
for (const record of progress.completed) {
  if (completed.has(record.entry_id)) errors.push(`duplicate completion: ${record.entry_id}`);
  completed.set(record.entry_id, record);
}
for (const entryId of expected) if (!planned.has(entryId)) errors.push(`missing from plan: ${entryId}`);
for (const entryId of planned) if (!expected.has(entryId)) errors.push(`stale plan entry: ${entryId}`);
for (const entryId of planned) if (!completed.has(entryId)) errors.push(`not revised: ${entryId}`);
const checkedRuns = new Map();
const runDirectory = path.join(directory, "history/runs");
for (const record of progress.completed) {
  let run = checkedRuns.get(record.run_id);
  if (!run) {
    const location = path.join(runDirectory, record.run_id);
    const [manifest, output] = await Promise.all([
      read(path.join(location, "manifest.json")), read(path.join(location, "output.json"))]);
    run = { manifest, output };
    checkedRuns.set(record.run_id, run);
  }
  if (run.manifest.status !== "complete" || run.output.approval?.decision !== "approved") {
    errors.push(`unapproved run: ${record.entry_id} ${record.run_id}`);
  }
  if (!record.reference_ids?.length) errors.push(`missing reference: ${record.entry_id}`);
}
const modelRuns = new Set(progress.completed.map(item => item.model_run_id ||
  checkedRuns.get(item.run_id)?.manifest.options?.source_run_id || item.run_id));
for (const runId of modelRuns) {
  const manifest = await read(path.join(runDirectory, runId, "manifest.json"));
  const responseCount = (manifest.artifacts || []).filter(item =>
    /\/\d+-model-response\.json$/u.test(item.path)).length;
  if (responseCount !== 1) errors.push(`model calls ${responseCount}: ${runId}`);
  if (manifest.options?.revision_mode !== "single_revision" ||
      manifest.options?.apply_mode !== "direct_overwrite") {
    errors.push(`mode not recorded: ${runId}`);
  }
}
const report = { project_id: id, from_page: fromPage, reference_works: reference.work_count,
  expected_poems: expected.size, planned_poems: planned.size, approved_poems: completed.size,
  approved_runs: checkedRuns.size, model_runs: modelRuns.size,
  unresolved: [...planned].filter(entryId => !completed.has(entryId)),
  errors };
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
