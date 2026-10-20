import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HistoryStore } from "../../oldbook-core/src/change-history.mjs";
import { EbookReview } from "../../oldbook-core/src/ebook-review.mjs";
import { safeId } from "../../oldbook-core/src/project-store.mjs";
import { ProjectStore } from "../../oldbook-core/src/project-store.mjs";
import { EbookStore } from "../../oldbook-core/src/ebook-store.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const help = `Usage: node packages/oldbook-cli/src/ebook.mjs <generate|evaluate|list|show|approve|apply|abandon> --project <id> [options]

generate --task <task.json> [--cases <cases.json>] [--previous <run-id>]
         [--skill <SKILL.md>] [--model <model-id>]
  One external-model call; candidate only. Retries require changed rules/code; maximum 3 rounds.
evaluate --run <run-id> [--cases <cases.json>]
  Offline evaluation. Never calls a model or changes production JSON.
list     [--state awaiting_approval|approved|abandoned] [--limit 50]
show     --run <run-id>
approve  --run <run-id> --approve <candidate-sha256> --note <explicit-approval>
apply    Alias for approve.
abandon  --run <run-id> --note <reason>
         [--api http://127.0.0.1:3100]
  Candidate commands use the local API. Approval requires a matching hash and unchanged baseline.
  Agent calls should add --actor ai:codex --channel agent --requested-by human.

See packages/oldbook-cli/README.md for task modes, evidence and regression cases.`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, project: { type: "string" }, task: { type: "string" },
    cases: { type: "string" }, previous: { type: "string" }, skill: { type: "string" }, model: { type: "string" },
    run: { type: "string" }, approve: { type: "string" }, note: { type: "string" }, api: { type: "string" },
    state: { type: "string" }, limit: { type: "string" }, actor: { type: "string" }, channel: { type: "string" },
    "requested-by": { type: "string" }
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command] = positionals;
  const allowed = {
    generate: ["project", "task", "cases", "previous", "skill", "model"],
    evaluate: ["project", "run", "cases"],
    list: ["project", "state", "limit", "api"],
    show: ["project", "run", "api"],
    approve: ["project", "run", "approve", "note", "api", "actor", "channel", "requested-by"],
    apply: ["project", "run", "approve", "note", "api", "actor", "channel", "requested-by"],
    abandon: ["project", "run", "note", "api", "actor", "channel", "requested-by"]
  };
  if (positionals.length !== 1 || !allowed[command] || Object.keys(values).some(k => !allowed[command].includes(k))) {
    throw new Error(help);
  }
  const projectId = safeId(values.project);
  const required = command === "generate" ? ["task"]
    : ["approve", "apply"].includes(command) ? ["run", "approve", "note"]
      : command === "abandon" ? ["run", "note"]
        : command === "list" ? [] : ["run"];
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
    const task = await read(values.task);
    const output = await review.generate(projectId, task, {
      suite, previousRunId: values.previous, config: { model: values.model }
    });
    if (task.apply_mode === "direct_overwrite") {
      const history = new HistoryStore(projects);
      const ebookStore = new EbookStore(projects, new ProjectStore(projects, history), history);
      await review.apply(projectId, output.run_id, {
        candidate_hash: output.candidate_hash,
        note: "用户要求单次修订后直接覆盖并自动批准",
        channel: "agent", requested_by: "human"
      }, ebookStore, { actor: "ai:codex", channel: "agent", requested_by: "human" });
    }
    console.log(JSON.stringify({ run_id: output.run_id, round: output.round, candidate_hash: output.candidate_hash,
      approved: task.apply_mode === "direct_overwrite",
      evaluation: output.evaluation, model_issues: output.model_issues,
      artifacts: path.join(projects, projectId, "history/runs", output.run_id) }, null, 2));
    if (!output.evaluation.mechanical_pass) process.exitCode = 1;
  } else if (command === "evaluate") {
    const report = await review.evaluate(projectId, values.run, suite);
    console.log(JSON.stringify(report, null, 2));
    if (!report.mechanical_pass) process.exitCode = 1;
  } else {
    const api = (values.api || "http://127.0.0.1:3100").replace(/\/$/, "");
    const base = `${api}/api/projects/${projectId}/ebook/candidates`;
    const headers = {
      "Content-Type": "application/json",
      "X-Oldbook-Actor": values.actor || "human",
      "X-Oldbook-Source": "oldbook-cli",
      "X-Oldbook-Channel": values.channel || "cli",
      "X-Oldbook-Requested-By": values["requested-by"] || (values.actor?.startsWith("ai:") ? "unspecified" : "human")
    };
    let url = base;
    let init = { headers, signal: AbortSignal.timeout(60_000) };
    if (command === "list") {
      const query = new URLSearchParams();
      if (values.state) query.set("state", values.state);
      if (values.limit) query.set("limit", values.limit);
      url += query.size ? `?${query}` : "";
    } else if (command === "show") {
      url += `/${encodeURIComponent(values.run)}`;
    } else {
      const action = command === "abandon" ? "abandon" : "approve";
      url += `/${encodeURIComponent(values.run)}/${action}`;
      init = { ...init, method: "POST", body: JSON.stringify({
        ...(action === "approve" ? { candidate_hash: values.approve } : {}),
        note: values.note,
        channel: values.channel || "cli",
        requested_by: values["requested-by"] || (values.actor?.startsWith("ai:") ? "unspecified" : "human")
      }) };
    }
    const response = await fetch(url, init);
    const body = await response.text();
    if (!response.ok) throw new Error(`${command} HTTP ${response.status}: ${body}`);
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
