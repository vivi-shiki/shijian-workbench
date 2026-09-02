import path from "node:path";
import { HistoryStore } from "../server/change-history.mjs";

const [command = "show", ...argumentsList] = process.argv.slice(2);

function argument(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = argumentsList.find(value => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argumentsList.indexOf(`--${name}`);
  return index >= 0 ? argumentsList[index + 1] || fallback : fallback;
}

const projectId = argument("project", process.env.OLDBOOK_PROJECT_ID || "yiyuji-four-volumes");
const history = new HistoryStore(path.resolve("data", "projects"));

if (!/^[a-z0-9][a-z0-9-]*$/i.test(projectId)) throw new Error("--project must be a valid project id");

if (command === "begin") {
  const pending = await history.beginAttribution(projectId, {
    actor: argument("actor", "ai:codex"),
    source: argument("source", "codex-direct-edit"),
    note: argument("note", "Codex 直接修改项目 JSON")
  });
  console.log(JSON.stringify({ ok: true, command, attribution: pending }, null, 2));
} else if (command === "commit") {
  const events = await history.commitAttribution(projectId);
  console.log(JSON.stringify({ ok: true, command, project_id: projectId,
    events: events.map(event => ({ id: event.id, target: event.target, changes: event.summary.operations })) }, null, 2));
} else if (command === "reconcile") {
  const actor = argument("actor", "");
  const attribution = actor ? {
    actor,
    source: argument("source", "manual-reconcile"),
    note: argument("note", "手动补记 JSON 修改")
  } : undefined;
  const events = await history.reconcileProject(projectId, attribution);
  console.log(JSON.stringify({ ok: true, command, project_id: projectId,
    events: events.map(event => ({ id: event.id, target: event.target, changes: event.summary.operations })) }, null, 2));
} else if (command === "bootstrap") {
  const result = await history.bootstrapProject(projectId);
  console.log(JSON.stringify({ ok: true, command, project_id: projectId, total: result.total,
    totals: result.overview.totals }, null, 2));
} else if (command === "show") {
  const result = await history.read(projectId, Number(argument("limit", "20")));
  console.log(JSON.stringify(result, null, 2));
} else {
  throw new Error("Usage: node scripts/history.mjs <bootstrap|begin|commit|reconcile|show> --project <id>");
}
