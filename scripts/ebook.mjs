import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HistoryStore } from "../server/change-history.mjs";
import { EbookReview } from "../server/ebook-review.mjs";
import { safeId } from "../server/project-store.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const help = `Usage: node scripts/ebook.mjs <generate|evaluate|apply> --project <id> [options]

generate --task <task.json> [--cases <cases.json>] [--previous <run-id>]
         [--skill <SKILL.md>] [--model <model-id>]
  One external-model call; candidate only. Retries require changed rules/code; maximum 3 rounds.
evaluate --run <run-id> [--cases <cases.json>]
  Offline evaluation. Never calls a model or changes production JSON.
apply    --run <run-id> --approve <candidate-sha256> --note <human-approval>
         [--api http://127.0.0.1:3100]
  Requires the local API, explicit approval, passing checks and an unchanged baseline.

See scripts/README.md for task modes, evidence and regression cases.`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, project: { type: "string" }, task: { type: "string" },
    cases: { type: "string" }, previous: { type: "string" }, skill: { type: "string" }, model: { type: "string" },
    run: { type: "string" }, approve: { type: "string" }, note: { type: "string" }, api: { type: "string" }
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command] = positionals;
  const allowed = {
    generate: ["project", "task", "cases", "previous", "skill", "model"],
    evaluate: ["project", "run", "cases"],
    apply: ["project", "run", "approve", "note", "api"]
  };
  if (positionals.length !== 1 || !allowed[command] || Object.keys(values).some(k => !allowed[command].includes(k))) {
    throw new Error(help);
  }
  const projectId = safeId(values.project);
  const required = command === "generate" ? ["task"] : command === "apply" ? ["run", "approve", "note"] : ["run"];
  for (const key of required) if (!values[key]?.trim()) throw new Error(`Missing --${key}`);
  const projects = path.join(root, "data/projects");
  const review = new EbookReview(projects, new HistoryStore(projects), { skillPath: values.skill });
  const read = async filename => JSON.parse(await fs.readFile(path.resolve(filename), "utf8"));
  const suite = values.cases ? await read(values.cases) : null;
  if (command === "generate") {
    for (const name of [".env.local", ".env"]) {
      try { process.loadEnvFile(path.join(root, name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const output = await review.generate(projectId, await read(values.task), {
      suite, previousRunId: values.previous, config: { model: values.model }
    });
    console.log(JSON.stringify({ run_id: output.run_id, round: output.round, candidate_hash: output.candidate_hash,
      evaluation: output.evaluation, model_issues: output.model_issues,
      artifacts: path.join(projects, projectId, "history/runs", output.run_id) }, null, 2));
    if (!output.evaluation.mechanical_pass) process.exitCode = 1;
  } else if (command === "evaluate") {
    const report = await review.evaluate(projectId, values.run, suite);
    console.log(JSON.stringify(report, null, 2));
    if (!report.mechanical_pass) process.exitCode = 1;
  } else {
    const api = (values.api || "http://127.0.0.1:3100").replace(/\/$/, "");
    const response = await fetch(`${api}/api/projects/${projectId}/ebook/candidates/${encodeURIComponent(values.run)}/apply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate_hash: values.approve, note: values.note }), signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`Apply HTTP ${response.status}: ${await response.text()}`);
    console.log(JSON.stringify({ project_id: projectId, run_id: values.run, status: "applied" }));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
