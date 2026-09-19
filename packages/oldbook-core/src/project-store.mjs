import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function safeId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw Object.assign(new Error("Invalid id"), { status: 400 });
  }
  return value;
}

export async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temp, filename); break; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 9) throw error;
      await delay(Math.min(1000, 50 * 2 ** attempt));
    }
  }
}

export class ProjectStore {
  constructor(root, history = null) {
    this.root = root;
    this.history = history;
    this.locks = new Map();
    this.resultCache = new Map();
    this.resultCacheLimit = 4;
  }

  directory(id) { return path.join(this.root, safeId(id)); }
  resultPath(id, resultId) { return path.join(this.directory(id), "results", `${safeId(resultId)}.json`); }
  async json(filename) { return JSON.parse(await fs.readFile(filename, "utf8")); }

  async cachedResult(id, resultId) {
    const filename = this.resultPath(id, resultId);
    const stat = await fs.stat(filename);
    const cached = this.resultCache.get(filename);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.resultCache.delete(filename);
      this.resultCache.set(filename, cached);
      return cached.value;
    }
    const value = await this.json(filename);
    this.resultCache.set(filename, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    while (this.resultCache.size > this.resultCacheLimit) {
      this.resultCache.delete(this.resultCache.keys().next().value);
    }
    return value;
  }

  invalidateResult(id, resultId) {
    this.resultCache.delete(this.resultPath(id, resultId));
  }

  async record(projectId, details) {
    if (!this.history) return null;
    return this.history.recordChange({ projectId, ...details });
  }

  async locked(id, operation) {
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  async legacyResult(project) {
    const sources = (project.pages || []).flatMap(page => page.regions || []).map(region => region.source || {});
    const provider = project.workflow?.ocr_provider || sources.find(s => s.provider && s.provider !== "manual")?.provider;
    let model = project.workflow?.ocr_model || sources.find(s => s.model)?.model;
    if (!model) {
      for (const filename of new Set(sources.map(s => s.json).filter(Boolean))) {
        const resolved = path.resolve(this.root, "../..", filename);
        const relative = path.relative(path.resolve(this.root, "../.."), resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const raw = await this.json(resolved).catch(() => null);
        model = raw?.model || raw?.response?.model;
        if (model) break;
      }
    }
    if (!model && ["ndlkotenocr-lite", "paddleocr-vl-1.6"].includes(provider)) model = provider;
    const id = model ? model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "archive";
    return { id: id || "archive", label: model || "Archive（模型未知）", model: model || null,
      provider: provider || null, archived: !model, status: "complete", page_count: project.pages.length,
      completed_pages: project.pages.length, created_at: project.created_at,
      workflow: project.workflow || {}, pages: project.pages };
  }

  async migrate(id, archive = false) {
    return this.locked(id, async () => {
      const filename = path.join(this.directory(id), "project.json");
      let project = await this.json(filename);
      const originalProject = structuredClone(project);
      if (project.schema_version !== 2) {
        const backup = path.join(this.directory(id), "backups", "project-v1.json");
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(filename, backup, fs.constants.COPYFILE_EXCL).catch(error => {
          if (error.code !== "EEXIST") throw error;
        });
        const result = await this.legacyResult(project);
        await atomicJson(this.resultPath(id, result.id), result);
        await this.record(id, { target: { kind: "result", result_id: result.id }, before: null, after: result,
          actor: "system", source: "schema-migration", operation: "migrate_result" });
        const { pages, ...metadata } = project;
        project = { ...metadata, schema_version: 2, archived: archive || Boolean(project.archived),
          active_result_id: result.id, results: [this.descriptor(result)] };
      } else if (archive) project.archived = true;
      await atomicJson(filename, project);
      await this.record(id, { target: { kind: "project" }, before: originalProject, after: project,
        actor: "system", source: "schema-migration", operation: "migrate_project" });
      return project;
    });
  }

  descriptor(result) {
    const { pages, workflow, ...metadata } = result;
    return { ...metadata, page_count: pages?.length ?? metadata.page_count,
      regions: pages?.reduce((n, page) => n + page.regions.length, 0) ?? metadata.regions ?? 0 };
  }

  async index(id) {
    const project = await this.json(path.join(this.directory(id), "project.json"));
    return project.schema_version === 2 ? project : this.migrate(id);
  }

  async setArchived(id, archived, audit = {}) {
    await this.index(id);
    return this.locked(id, async () => {
      const filename = path.join(this.directory(id), "project.json");
      const project = await this.json(filename);
      if (project.archived === Boolean(archived)) return project;
      const before = structuredClone(project);
      project.archived = Boolean(archived);
      project.updated_at = new Date().toISOString();
      await atomicJson(filename, project);
      await this.record(id, { target: { kind: "project" }, before, after: project,
        actor: audit.actor || "human", source: audit.source || "project-archive",
        operation: project.archived ? "archive_project" : "unarchive_project",
        note: audit.note || "", metadata: audit.metadata || {} });
      return project;
    });
  }

  async view(id, resultId) {
    const project = await this.index(id);
    const selected = resultId || project.active_result_id;
    if (!project.results.some(result => result.id === selected)) {
      throw Object.assign(new Error("Result not found"), { status: 404 });
    }
    const result = await this.json(this.resultPath(id, selected));
    return { ...project, active_result_id: selected, workflow: result.workflow || project.workflow,
      pages: result.pages };
  }

  async readerWindow(id, start, end) {
    const project = await this.index(id);
    const loaded = await Promise.all(project.results.map(async descriptor => ({
      descriptor,
      result: await this.cachedResult(id, descriptor.id)
    })));
    const sourcePages = project.source?.pages?.length ? project.source.pages : loaded[0]?.result.pages || [];
    const summaries = sourcePages.map(page => {
      const { regions, source_pdf, ...summary } = page;
      return summary;
    }).sort((a, b) => a.page_number - b.page_number);
    const firstPage = summaries[0]?.page_number || 1;
    const from = Number.isInteger(start) ? start : firstPage;
    const to = Number.isInteger(end) && end >= from ? end : from + 4;
    const results = loaded.map(({ descriptor, result }) => ({
      ...result,
      id: descriptor.id,
      label: descriptor.label || result.label || descriptor.id,
      pages: result.pages.filter(page => page.page_number >= from && page.page_number <= to)
    }));
    return {
      project: { ...project, source: { ...(project.source || {}), pages: summaries } },
      results,
      window: { from, to }
    };
  }

  async save(id, input, audit = {}) {
    await this.index(id);
    return this.locked(id, async () => {
      const filename = path.join(this.directory(id), "project.json");
      const project = await this.json(filename);
      const originalProject = structuredClone(project);
      const selected = input.active_result_id || (project.results.length === 1 ? project.active_result_id : null);
      const target = input.target_result_id || selected;
      if (!project.results.some(r => r.id === selected) || !project.results.some(r => r.id === target)) {
        throw Object.assign(new Error("Explicit valid model result required"), { status: 400 });
      }
      const result = await this.json(this.resultPath(id, selected));
      const originalResult = structuredClone(result);
      const updates = new Map((input.pages || []).map(page => [page.id, page]));
      for (const [pageId, page] of updates) {
        const old = result.pages.find(p => p.id === pageId);
        if (!old || !Array.isArray(page.regions)) throw Object.assign(new Error("Invalid page"), { status: 400 });
        if ((page.revision ?? 0) !== (old.revision ?? 0)) {
          throw Object.assign(new Error("页面已被更新，请重新载入后再保存。"), { status: 409 });
        }
        if (old.ocr_status === "pending") throw Object.assign(new Error("页面仍在识别中"), { status: 409 });
      }
      result.pages = result.pages.map(page => updates.has(page.id)
        ? { ...updates.get(page.id), revision: (page.revision || 0) + 1 } : page);
      result.updated_at = new Date().toISOString();
      await atomicJson(this.resultPath(id, selected), result);
      this.invalidateResult(id, selected);
      await this.record(id, { target: { kind: "result", result_id: selected }, before: originalResult, after: result,
        actor: audit.actor || "human", source: audit.source || "ocr-workbench", operation: "edit_ocr",
        note: audit.note || "", metadata: audit.metadata || {} });
      project.results = project.results.map(r => r.id === selected ? this.descriptor(result) : r);
      if (typeof input.archived === "boolean") project.archived = input.archived;
      project.active_result_id = target;
      project.updated_at = result.updated_at;
      await atomicJson(filename, project);
      await this.record(id, { target: { kind: "project" }, before: originalProject, after: project,
        actor: audit.actor || "human", source: audit.source || "ocr-workbench", operation: "update_project",
        note: audit.note || "", metadata: audit.metadata || {} });
      return this.view(id, target);
    });
  }

  async importResult(id, input, audit = {}) {
    if (!input?.result || !Array.isArray(input.result.pages) || typeof input.result.label !== "string") {
      throw Object.assign(new Error("Invalid model result"), { status: 400 });
    }
    await this.index(id).catch(error => { if (error.code !== "ENOENT") throw error; });
    return this.locked(id, async () => {
      safeId(input.result.id);
      const filename = path.join(this.directory(id), "project.json");
      let project;
      try { project = await this.json(filename); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!project) project = { schema_version: 2, id, title: input.title, source: input.source,
        archived: false, active_result_id: input.result.id, results: [], created_at: new Date().toISOString() };
      if (project.results.some(r => r.id === input.result.id)) {
        const existing = await this.json(this.resultPath(id, input.result.id));
        if (existing.model !== input.result.model || existing.unwarp !== input.result.unwarp ||
            existing.pages.map(p => p.id).join(",") !== input.result.pages.map(p => p.id).join(",")) {
          throw Object.assign(new Error("Result id already exists with different model/settings/pages; use a new id."), { status: 409 });
        }
        return project;
      }
      await atomicJson(this.resultPath(id, input.result.id), input.result);
      this.invalidateResult(id, input.result.id);
      await this.record(id, { target: { kind: "result", result_id: input.result.id }, before: null, after: input.result,
        actor: audit.actor || "ai:ocr", source: audit.source || "ocr-import", operation: "import_result",
        note: audit.note || "", metadata: audit.metadata || {} });
      const originalProject = structuredClone(project);
      project.results.push(this.descriptor(input.result));
      await atomicJson(filename, project);
      await this.record(id, { target: { kind: "project" }, before: originalProject, after: project,
        actor: audit.actor || "ai:ocr", source: audit.source || "ocr-import", operation: "register_result",
        note: audit.note || "", metadata: audit.metadata || {} });
      return project;
    });
  }

  async importPage(id, resultId, page, audit = {}) {
    return this.locked(id, async () => {
      const filename = path.join(this.directory(id), "project.json");
      const project = await this.json(filename);
      if (!project.results.some(r => r.id === resultId)) throw Object.assign(new Error("Result not found"), { status: 404 });
      const result = await this.json(this.resultPath(id, resultId));
      const originalResult = structuredClone(result);
      const index = result.pages.findIndex(p => p.id === page.id);
      if (index < 0) throw Object.assign(new Error("Page not found"), { status: 404 });
      // Resuming a batch must never replace a page that is already editable.
      if (result.pages[index].ocr_status !== "pending") return { skipped: true };
      result.pages[index] = { ...page, ocr_status: "done", revision: 1 };
      result.completed_pages = result.pages.filter(p => p.ocr_status === "done").length;
      result.status = result.completed_pages === result.pages.length ? "complete" : "running";
      result.updated_at = new Date().toISOString();
      await atomicJson(this.resultPath(id, resultId), result);
      this.invalidateResult(id, resultId);
      await this.record(id, { target: { kind: "result", result_id: resultId }, before: originalResult, after: result,
        actor: audit.actor || "ai:ocr", source: audit.source || "ocr-batch", operation: "import_page",
        note: audit.note || "", metadata: { ...(audit.metadata || {}), page_id: page.id } });
      const originalProject = structuredClone(project);
      project.results = project.results.map(r => r.id === resultId ? this.descriptor(result) : r);
      await atomicJson(filename, project);
      await this.record(id, { target: { kind: "project" }, before: originalProject, after: project,
        actor: audit.actor || "ai:ocr", source: audit.source || "ocr-batch", operation: "update_result_progress",
        note: audit.note || "", metadata: { ...(audit.metadata || {}), page_id: page.id } });
      return { completed_pages: result.completed_pages, status: result.status };
    });
  }
}
