import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 80;
const MAX_CASES = 24;
const MAX_PATTERNS = 120;
const VOLATILE_MEMORY_FIELDS = new Set([
  "updated_at", "started_at", "completed_at", "created_at", "revision", "completed_through"
]);

function isoNow() {
  return new Date().toISOString();
}

function safePart(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw Object.assign(new Error("Invalid history identifier"), { status: 400 });
  }
  return value;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, filename);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 8) throw error;
      await delay(Math.min(800, 40 * 2 ** attempt));
    }
  }
}

function pointerPart(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function isIdentifiedArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item =>
    item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string"
  ) && new Set(value.map(item => item.id)).size === value.length;
}

function valuesEqual(before, after) {
  if (Object.is(before, after)) return true;
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
  return JSON.stringify(before) === JSON.stringify(after);
}

export function diffJson(before, after, currentPath = "") {
  if (valuesEqual(before, after)) return [];
  if (before === undefined) return [{ op: "add", path: currentPath || "/", after: clone(after) }];
  if (after === undefined) return [{ op: "remove", path: currentPath || "/", before: clone(before) }];

  if (Array.isArray(before) && Array.isArray(after)) {
    if (isIdentifiedArray(before) && isIdentifiedArray(after)) {
      const oldItems = new Map(before.map(item => [item.id, item]));
      const newItems = new Map(after.map(item => [item.id, item]));
      const ids = [...new Set([...oldItems.keys(), ...newItems.keys()])];
      return ids.flatMap(id => diffJson(oldItems.get(id), newItems.get(id), `${currentPath}/${pointerPart(id)}`));
    }
    if (before.length === after.length) {
      return before.flatMap((value, index) => diffJson(value, after[index], `${currentPath}/${index}`));
    }
    return [{ op: "replace", path: currentPath || "/", before: clone(before), after: clone(after) }];
  }

  if (before && after && typeof before === "object" && typeof after === "object" &&
      !Array.isArray(before) && !Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap(key => diffJson(before[key], after[key], `${currentPath}/${pointerPart(key)}`));
  }

  return [{ op: "replace", path: currentPath || "/", before: clone(before), after: clone(after) }];
}

function pathDetails(pointer) {
  const parts = pointer.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const detail = { field: parts.at(-1) || "root" };
  for (const [container, key] of [["pages", "page_id"], ["regions", "region_id"], ["entries", "entry_id"], ["issues", "issue_id"]]) {
    const index = parts.indexOf(container);
    if (index >= 0 && parts[index + 1]) detail[key] = parts[index + 1];
  }
  return detail;
}

function summarizeChanges(changes) {
  const fields = {};
  const pages = new Set();
  const entities = new Set();
  let textChanges = 0;
  for (const change of changes) {
    const detail = pathDetails(change.path);
    change.field = detail.field;
    Object.assign(change, detail);
    fields[detail.field] = (fields[detail.field] || 0) + 1;
    if (detail.page_id) pages.add(detail.page_id);
    for (const id of [detail.region_id, detail.entry_id, detail.issue_id]) if (id) entities.add(id);
    if (typeof change.before === "string" || typeof change.after === "string") textChanges += 1;
  }
  return {
    operations: changes.length,
    text_changes: textChanges,
    fields,
    pages: [...pages],
    entities: [...entities]
  };
}

function actorRecord(actor) {
  if (actor && typeof actor === "object") {
    return {
      type: String(actor.type || "external"),
      id: String(actor.id || actor.type || "external"),
      label: String(actor.label || actor.id || actor.type || "外部修改")
    };
  }
  const id = String(actor || "external");
  const type = id === "human" ? "human" : id.startsWith("ai:") ? "ai" : id === "system" ? "system" : "external";
  return { type, id, label: id };
}

function newId(prefix) {
  return `${prefix}-${isoNow().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function targetKey(target) {
  if (target.kind === "result") return `result--${safePart(target.result_id)}`;
  if (!["project", "ebook"].includes(target.kind)) throw new Error(`Unsupported history target: ${target.kind}`);
  return target.kind;
}

function targetRelativePath(target) {
  if (target.kind === "project") return "project.json";
  if (target.kind === "ebook") return "ebook/structured.json";
  return `results/${safePart(target.result_id)}.json`;
}

function shorten(value, maximum = 180) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text == null) return "";
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function minimalReplacement(before, after) {
  if (typeof before !== "string" || typeof after !== "string" || before === after) return null;
  const oldChars = [...before];
  const newChars = [...after];
  let start = 0;
  while (start < oldChars.length && start < newChars.length && oldChars[start] === newChars[start]) start += 1;
  let oldEnd = oldChars.length;
  let newEnd = newChars.length;
  while (oldEnd > start && newEnd > start && oldChars[oldEnd - 1] === newChars[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const from = oldChars.slice(start, oldEnd).join("");
  const to = newChars.slice(start, newEnd).join("");
  if (from.length > 16 || to.length > 16) return null;
  return { from, to };
}

function memoryWeight(actor) {
  if (actor.id === "human") return 4;
  if (actor.id === "ai:codex") return 3;
  if (actor.type === "ai") return 2;
  return 1;
}

function emptyOverview(projectId) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    updated_at: isoNow(),
    totals: { events: 0, changes: 0, text_changes: 0 },
    by_actor: {},
    by_source: {},
    by_field: {},
    patterns: [],
    cases: []
  };
}

function increment(map, key, amount = 1) {
  if (key) map[key] = (map[key] || 0) + amount;
}

function updateOverview(overview, event) {
  overview.updated_at = event.timestamp;
  overview.totals.events += 1;
  overview.totals.changes += event.summary.operations;
  overview.totals.text_changes += event.summary.text_changes;
  increment(overview.by_actor, event.actor.id);
  increment(overview.by_source, event.source);
  for (const [field, count] of Object.entries(event.summary.fields)) increment(overview.by_field, field, count);

  const patterns = new Map(overview.patterns.map(item => [`${item.from}\u0000${item.to}`, item]));
  const additions = [];
  for (const change of event.changes) {
    if (VOLATILE_MEMORY_FIELDS.has(change.field)) continue;
    const textChange = minimalReplacement(change.before, change.after);
    if (textChange && (textChange.from || textChange.to)) {
      const key = `${textChange.from}\u0000${textChange.to}`;
      const item = patterns.get(key) || { ...textChange, count: 0, actors: {}, fields: {}, last_seen: event.timestamp };
      item.count += 1;
      item.last_seen = event.timestamp;
      increment(item.actors, event.actor.id);
      increment(item.fields, change.field);
      patterns.set(key, item);
    }
    if ((typeof change.before === "string" || typeof change.after === "string") && additions.length < 6) {
      additions.push({
        event_id: event.id,
        timestamp: event.timestamp,
        actor: event.actor.id,
        source: event.source,
        target: event.target,
        path: change.path,
        field: change.field,
        page_id: change.page_id,
        region_id: change.region_id,
        entry_id: change.entry_id,
        before: shorten(change.before),
        after: shorten(change.after),
        note: event.note || "",
        weight: memoryWeight(event.actor)
      });
    }
  }
  overview.patterns = [...patterns.values()]
    .sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen))
    .slice(0, MAX_PATTERNS);
  overview.cases = [...additions, ...overview.cases]
    .sort((a, b) => b.weight - a.weight || b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_CASES);
  return overview;
}

function renderMemory(overview) {
  const actorText = Object.entries(overview.by_actor).sort((a, b) => b[1] - a[1])
    .map(([actor, count]) => `${actor} ${count}`).join("；") || "暂无";
  const fieldText = Object.entries(overview.by_field)
    .filter(([field]) => !VOLATILE_MEMORY_FIELDS.has(field))
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([field, count]) => `${field} ${count}`).join("；") || "暂无";
  const patterns = overview.patterns.filter(item => item.count >= 2).slice(0, 16)
    .map(item => `- ${JSON.stringify(item.from)} → ${JSON.stringify(item.to)}（${item.count} 次；${Object.keys(item.actors).join("、")}）`);
  const cases = overview.cases.slice(0, 12).map(item => {
    const location = [item.page_id, item.region_id || item.entry_id, item.field].filter(Boolean).join(" / ");
    return `- [${item.actor}] ${location || item.path}：${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}`;
  });
  return [
    "# 项目校订经验摘要",
    "",
    `更新时间：${overview.updated_at}`,
    `累计：${overview.totals.events} 次记录，${overview.totals.changes} 个字段变化，其中 ${overview.totals.text_changes} 个文本变化。`,
    `来源：${actorText}`,
    `高频字段：${fieldText}`,
    "",
    "使用原则：原图与明确人工校订优先；这些历史案例只作候选和一致性提示，不得据此脱离当前页证据批量替字。AI 产生的修改不是人工定论。",
    "",
    "## 重复出现的改法",
    "",
    ...(patterns.length ? patterns : ["- 暂无达到两次的重复模式。"]),
    "",
    "## 简略案例",
    "",
    ...(cases.length ? cases : ["- 暂无文本修改案例。"]),
    ""
  ].join("\n");
}

function inferSnapshotSource(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes("note-punctuation")) return { actor: "ai:siliconflow", source: "deepseek-note-punctuation", note: "从旧备份重建：注文标点" };
  if (lower.includes("preface-format") || lower.includes("prose-format")) return { actor: "ai:siliconflow", source: "deepseek-prose-format", note: "从旧备份重建：散文句读" };
  if (lower.includes("round2") || lower.includes("review")) return { actor: "ai:codex", source: "codex-review-script", note: "从旧备份重建：Codex 校订脚本" };
  return { actor: "external", source: "legacy-snapshot", note: "从旧备份重建" };
}

export class HistoryStore {
  constructor(projectsRoot) {
    this.projectsRoot = projectsRoot;
    this.locks = new Map();
    this.monitor = null;
  }

  projectDirectory(projectId) { return path.join(this.projectsRoot, safePart(projectId)); }
  historyDirectory(projectId) { return path.join(this.projectDirectory(projectId), "history"); }
  eventsPath(projectId) { return path.join(this.historyDirectory(projectId), "events.jsonl"); }
  overviewPath(projectId) { return path.join(this.projectDirectory(projectId), "ai-memory", "overview.json"); }
  memoryPath(projectId) { return path.join(this.projectDirectory(projectId), "ai-memory", "AI_CONTEXT.md"); }
  statePath(projectId, target) { return path.join(this.historyDirectory(projectId), "state", `${targetKey(target)}.json`); }
  pendingPath(projectId) { return path.join(this.historyDirectory(projectId), "active-attribution.json"); }

  async locked(projectId, operation) {
    const id = safePart(projectId);
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  async readJson(filename, fallback = null) {
    try { return JSON.parse(await fs.readFile(filename, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }

  async appendEventUnlocked(projectId, event) {
    await fs.mkdir(this.historyDirectory(projectId), { recursive: true });
    await fs.appendFile(this.eventsPath(projectId), `${JSON.stringify(event)}\n`, "utf8");
    const overview = await this.readJson(this.overviewPath(projectId), emptyOverview(projectId));
    updateOverview(overview, event);
    await atomicJson(this.overviewPath(projectId), overview);
    await fs.mkdir(path.dirname(this.memoryPath(projectId)), { recursive: true });
    await fs.writeFile(this.memoryPath(projectId), renderMemory(overview), "utf8");
  }

  async baseline(projectId, target, value, note = "建立历史追踪基线") {
    return this.locked(projectId, async () => {
      if (await this.readJson(this.statePath(projectId, target), null) != null) return false;
      const timestamp = isoNow();
      const event = {
        schema_version: SCHEMA_VERSION,
        id: newId("event"), timestamp, project_id: projectId,
        actor: actorRecord("system"), source: "history-bootstrap", operation: "baseline",
        target: { ...target, path: targetRelativePath(target) }, note,
        before_hash: null, after_hash: hashJson(value),
        summary: { operations: 0, text_changes: 0, fields: {}, pages: [], entities: [] }, changes: []
      };
      await this.appendEventUnlocked(projectId, event);
      await atomicJson(this.statePath(projectId, target), value);
      return true;
    });
  }

  async recordChange({ projectId, target, before, after, actor = "external", source = "unknown", operation = "update", note = "", runId = null, metadata = {} }) {
    return this.locked(projectId, async () => {
      const changes = diffJson(before, after);
      if (!changes.length) {
        await atomicJson(this.statePath(projectId, target), after);
        return null;
      }
      const timestamp = isoNow();
      const event = {
        schema_version: SCHEMA_VERSION,
        id: newId("event"), timestamp, project_id: projectId,
        actor: actorRecord(actor), source, operation,
        target: { ...target, path: targetRelativePath(target) },
        ...(runId ? { run_id: runId } : {}),
        ...(note ? { note } : {}),
        ...(Object.keys(metadata).length ? { metadata } : {}),
        before_hash: before == null ? null : hashJson(before),
        after_hash: hashJson(after),
        summary: summarizeChanges(changes), changes
      };
      await this.appendEventUnlocked(projectId, event);
      await atomicJson(this.statePath(projectId, target), after);
      return event;
    });
  }

  async attribution(projectId) {
    const pending = await this.readJson(this.pendingPath(projectId), null);
    if (!pending || Date.parse(pending.expires_at) <= Date.now()) return null;
    return pending;
  }

  async beginAttribution(projectId, details = {}) {
    await this.reconcileProject(projectId);
    const pending = {
      schema_version: SCHEMA_VERSION,
      id: newId("change"), project_id: projectId,
      actor: actorRecord(details.actor || "ai:codex"),
      source: details.source || "codex-direct-edit",
      note: details.note || "",
      started_at: isoNow(),
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    };
    await atomicJson(this.pendingPath(projectId), pending);
    return pending;
  }

  async commitAttribution(projectId) {
    const pending = await this.attribution(projectId);
    const events = await this.reconcileProject(projectId, pending || undefined);
    await fs.rm(this.pendingPath(projectId), { force: true });
    return events;
  }

  async managedTargets(projectId) {
    const directory = this.projectDirectory(projectId);
    const targets = [];
    if (await fs.stat(path.join(directory, "project.json")).catch(() => null)) targets.push({ kind: "project" });
    const results = await fs.readdir(path.join(directory, "results"), { withFileTypes: true }).catch(() => []);
    for (const entry of results) {
      if (entry.isFile() && entry.name.endsWith(".json")) targets.push({ kind: "result", result_id: entry.name.slice(0, -5) });
    }
    if (await fs.stat(path.join(directory, "ebook", "structured.json")).catch(() => null)) targets.push({ kind: "ebook" });
    return targets;
  }

  async reconcileTarget(projectId, target, attribution) {
    const filename = path.join(this.projectDirectory(projectId), targetRelativePath(target));
    let current;
    try { current = JSON.parse(await fs.readFile(filename, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    const previous = await this.readJson(this.statePath(projectId, target), null);
    if (previous == null) {
      await this.baseline(projectId, target, current);
      return null;
    }
    if (hashJson(previous) === hashJson(current)) return null;
    const active = attribution || await this.attribution(projectId);
    return this.recordChange({
      projectId, target, before: previous, after: current,
      actor: active?.actor || "external",
      source: active?.source || "filesystem-reconcile",
      operation: "external_edit",
      note: active?.note || "检测到绕过 API 的 JSON 修改",
      metadata: active?.id ? { attribution_id: active.id } : {}
    });
  }

  async reconcileProject(projectId, attribution) {
    const events = [];
    for (const target of await this.managedTargets(projectId)) {
      const event = await this.reconcileTarget(projectId, target, attribution);
      if (event) events.push(event);
    }
    return events;
  }

  async reconcileAll() {
    const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/i.test(entry.name)) continue;
      await this.reconcileProject(entry.name).catch(error => console.error(`History reconcile failed for ${entry.name}:`, error.message));
    }
  }

  startMonitoring(intervalMs = 3000) {
    if (this.monitor) return;
    this.reconcileAll().catch(error => console.error("Initial history reconcile failed:", error.message));
    this.monitor = setInterval(() => {
      this.reconcileAll().catch(error => console.error("History reconcile failed:", error.message));
    }, intervalMs);
    this.monitor.unref?.();
  }

  async read(projectId, limit = DEFAULT_LIMIT) {
    await this.reconcileProject(projectId);
    const content = await fs.readFile(this.eventsPath(projectId), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const events = content.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const requested = Math.max(1, Math.min(500, Number(limit) || DEFAULT_LIMIT));
    return {
      events: events.slice(-requested).reverse(),
      total: events.length,
      overview: await this.readJson(this.overviewPath(projectId), emptyOverview(projectId))
    };
  }

  async aiContext(projectId, maximumCharacters = 7000) {
    await this.reconcileProject(projectId);
    const content = await fs.readFile(this.memoryPath(projectId), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return content.slice(0, maximumCharacters);
  }

  async startRun(projectId, details = {}) {
    const runId = details.runId || newId("run");
    const directory = path.join(this.historyDirectory(projectId), "runs", safePart(runId));
    const manifest = {
      schema_version: SCHEMA_VERSION,
      id: runId, project_id: projectId,
      actor: actorRecord(details.actor || "ai:siliconflow"),
      source: details.source || "ai-run",
      status: "running", started_at: isoNow(),
      model: details.model || null,
      provider: details.provider || null,
      options: details.options || {},
      note: details.note || "",
      steps: 0
    };
    await atomicJson(path.join(directory, "manifest.json"), manifest);
    if (details.input !== undefined) await atomicJson(path.join(directory, "input.json"), details.input);
    return manifest;
  }

  async recordRunStep(projectId, runId, step) {
    const directory = path.join(this.historyDirectory(projectId), "runs", safePart(runId));
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = await this.readJson(manifestPath);
    if (!manifest) throw new Error(`History run not found: ${runId}`);
    manifest.steps += 1;
    manifest.updated_at = isoNow();
    const filename = `${String(manifest.steps).padStart(4, "0")}-${safePart(step.kind || "step")}.json`;
    await atomicJson(path.join(directory, "steps", filename), { ...step, recorded_at: manifest.updated_at });
    await atomicJson(manifestPath, manifest);
    return manifest.steps;
  }

  async finishRun(projectId, runId, details = {}) {
    const directory = path.join(this.historyDirectory(projectId), "runs", safePart(runId));
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = await this.readJson(manifestPath);
    if (!manifest) return null;
    Object.assign(manifest, {
      status: details.status || "complete",
      completed_at: isoNow(),
      ...(details.error ? { error: details.error } : {})
    });
    await atomicJson(manifestPath, manifest);
    if (details.output !== undefined) await atomicJson(path.join(directory, "output.json"), details.output);
    return manifest;
  }

  async bootstrapProject(projectId) {
    const ebookTarget = { kind: "ebook" };
    const ebookState = await this.readJson(this.statePath(projectId, ebookTarget), null);
    if (ebookState == null) {
      const ebookDirectory = path.join(this.projectDirectory(projectId), "ebook");
      const candidates = [];
      for (const directory of [ebookDirectory, path.join(ebookDirectory, "backups")]) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "structured.json") continue;
          const filename = path.join(directory, entry.name);
          const stat = await fs.stat(filename);
          candidates.push({ filename, name: entry.name, mtime: stat.mtimeMs });
        }
      }
      candidates.sort((a, b) => a.mtime - b.mtime);
      const currentFilename = path.join(ebookDirectory, "structured.json");
      if (await fs.stat(currentFilename).catch(() => null)) candidates.push({ filename: currentFilename, name: "structured.json", mtime: Infinity });
      if (candidates.length) {
        let previous = JSON.parse(await fs.readFile(candidates[0].filename, "utf8"));
        await this.baseline(projectId, ebookTarget, previous, `由旧快照 ${candidates[0].name} 建立基线`);
        for (let index = 1; index < candidates.length; index += 1) {
          const current = JSON.parse(await fs.readFile(candidates[index].filename, "utf8"));
          const inferred = inferSnapshotSource(candidates[index - 1].name);
          await this.recordChange({ projectId, target: ebookTarget, before: previous, after: current,
            ...inferred, operation: "legacy_reconstruction", metadata: { from: candidates[index - 1].name, to: candidates[index].name } });
          previous = current;
        }
      }
    }
    await this.reconcileProject(projectId);
    return this.read(projectId, 20);
  }
}
