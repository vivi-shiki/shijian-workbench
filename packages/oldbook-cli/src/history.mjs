import path from "node:path";
import { HistoryStore } from "../../oldbook-core/src/change-history.mjs";

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
} else if (command === "seal") {
  const result = await history.reseal(projectId);
  console.log(JSON.stringify({ ok: true, command, project_id: projectId, ...result }, null, 2));
} else if (command === "show") {
  const result = await history.read(projectId, Number(argument("limit", "20")));
  const output = argumentsList.includes("--full") ? result : {
    total: result.total,
    integrity: result.integrity,
    overview: {
      totals: result.overview.totals,
      by_actor: result.overview.by_actor,
      by_source: result.overview.by_source,
      frequent_fields: Object.fromEntries(Object.entries(result.overview.by_field).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      repeated_patterns: result.overview.patterns.filter(item => item.count >= 2).slice(0, 12),
      cases: result.overview.cases.slice(0, 6)
    },
    events: result.events.map(event => ({
      id: event.id,
      timestamp: event.timestamp,
      actor: event.actor,
      source: event.source,
      operation: event.operation,
      target: event.target,
      note: event.note,
      run_id: event.run_id,
      summary: {
        operations: event.summary.operations,
        text_changes: event.summary.text_changes,
        fields: Object.fromEntries(Object.entries(event.summary.fields).sort((a, b) => b[1] - a[1]).slice(0, 12)),
        pages: event.summary.pages.length,
        entities: event.summary.entities.length
      }
    }))
  };
  console.log(JSON.stringify(output, null, 2));
} else {
  throw new Error("Usage: node packages/oldbook-cli/src/history.mjs <bootstrap|begin|commit|reconcile|seal|show> --project <id>");
}
