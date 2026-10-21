import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { safeId, atomicJson } from "./project-store.mjs";

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

export function summarizeProject({ pages = [], regions = [], entries = [], jobs = [] }) {
  const pendingPages = pages.filter(page => page.ocr_status !== "complete");
  const pendingRegions = regions.filter(region => region.status !== "reviewed");
  const pendingPoems = entries.filter(entry => entry.kind === "poem" && entry.review_status !== "reviewed");
  const failed = jobs.filter(job => job.status === "failed");
  const firstPendingPage = pendingPages[0];
  return {
    total_pages: pages.length,
    pending_ocr_pages: pendingPages.length,
    pending_regions: pendingRegions.length,
    pending_poems: pendingPoems.length,
    failed_jobs: failed.length,
    last_failure: failed.at(-1) || null,
    next_action: firstPendingPage ? { kind: "ocr", page: firstPendingPage.page_number ?? pages.indexOf(firstPendingPage) + 1 }
      : pendingRegions.length ? { kind: "review_region" }
        : pendingPoems.length ? { kind: "review_poem" } : { kind: "complete" }
  };
}

export function estimateModelCost({ pages, tokensPerPage, pricePerMillionTokens, budget, currency = "USD" }) {
  const known = [pages, tokensPerPage, pricePerMillionTokens].every(value => Number.isFinite(value) && value >= 0);
  if (!known) return { known: false, estimated_cost: null, currency, over_budget: false };
  const estimated = Math.round((pages * tokensPerPage * pricePerMillionTokens / 1_000_000) * 1e6) / 1e6;
  return { known: true, estimated_cost: estimated, currency,
    over_budget: Number.isFinite(budget) && estimated > budget };
}

export class JobQueue {
  constructor({ directory, runners = {} }) {
    this.directory = path.resolve(directory);
    this.runners = runners;
    this.active = new Map();
    this.activeRuns = new Map();
    this.projectLocks = new Map();
    this.writeTails = new Map();
  }

  filename(id) { return path.join(this.directory, `${safeId(id)}.json`); }

  async get(id) { return JSON.parse(await fs.readFile(this.filename(id), "utf8")); }

  async list(projectId = null) {
    const names = await fs.readdir(this.directory).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const jobs = await Promise.all(names.filter(name => name.endsWith(".json"))
      .map(name => this.get(name.slice(0, -5))));
    return jobs.filter(job => !projectId || job.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async recoverInterrupted() {
    for (const job of await this.list()) {
      if (!["queued", "running", "pausing"].includes(job.status)) continue;
      job.status = "paused";
      job.error = { message: "上次运行中断，可从检查点继续", at: new Date().toISOString() };
      await this.save(job);
    }
  }

  async save(job) {
    job.updated_at = new Date().toISOString();
    await fs.mkdir(this.directory, { recursive: true });
    const snapshot = structuredClone(job);
    const previous = this.writeTails.get(job.id) || Promise.resolve();
    const write = previous.catch(() => {}).then(() => atomicJson(this.filename(job.id), snapshot));
    this.writeTails.set(job.id, write);
    try { await write; }
    finally { if (this.writeTails.get(job.id) === write) this.writeTails.delete(job.id); }
    return snapshot;
  }

  async assertNoConflict(projectId, excluding = null, reservation = null) {
    if (this.projectLocks.has(projectId) && this.projectLocks.get(projectId) !== reservation) {
      throw new Error("Project already has a running job");
    }
    const jobs = await this.list(projectId);
    if (jobs.some(job => job.id !== excluding && ["running", "queued", "pausing"].includes(job.status))) {
      throw new Error("Project already has a running job");
    }
  }

  async enqueue({ type, project_id: projectId, ...options }) {
    safeId(projectId);
    if (!this.runners[type]) throw new Error(`Unknown job type: ${type}`);
    if (this.projectLocks.has(projectId)) throw new Error("Project already has a running job");
    const reservation = crypto.randomUUID();
    this.projectLocks.set(projectId, reservation);
    try { await this.assertNoConflict(projectId, null, reservation); }
    catch (error) { this.projectLocks.delete(projectId); throw error; }
    const now = new Date().toISOString();
    const job = { id: `job-${crypto.randomUUID()}`, type, project_id: projectId,
      status: "queued", progress: { completed: 0, total: null }, checkpoint: null,
      options, error: null, created_at: now, updated_at: now };
    this.projectLocks.set(projectId, job.id);
    try { await this.save(job); this.start(job); }
    catch (error) { this.projectLocks.delete(projectId); throw error; }
    return structuredClone(job);
  }

  start(job) {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    const run = async () => {
      try {
        job.status = "running";
        await this.save(job);
        if (controller.signal.aborted) return;
        await this.runners[job.type]({ ...job.options, project_id: job.project_id,
          checkpoint: job.checkpoint, signal: controller.signal,
          report: async ({ checkpoint, completed, total, ...other }) => {
            const latest = await this.get(job.id);
            if (latest.status === "cancelled") throw controller.signal.reason || new Error("Job cancelled");
            if (!["running", "paused"].includes(latest.status)) throw new Error("Job stopped");
            job.status = latest.status;
            job.checkpoint = checkpoint ?? job.checkpoint;
            job.progress = { completed, total, ...other };
            await this.save(job);
          } });
        if (!controller.signal.aborted && job.status === "running") { job.status = "complete"; await this.save(job); }
      } catch (error) {
        if (!controller.signal.aborted && job.status === "running") {
          job.status = "failed";
          job.error = { message: error?.message || String(error), at: new Date().toISOString(), checkpoint: job.checkpoint };
          await this.save(job);
        }
      } finally {
        if (this.active.get(job.id) === controller) this.active.delete(job.id);
        if (this.projectLocks.get(job.project_id) === job.id) this.projectLocks.delete(job.project_id);
        this.activeRuns.delete(job.id);
      }
    };
    this.activeRuns.set(job.id, run());
  }

  async stop(id, status) {
    const job = await this.get(id);
    if (TERMINAL.has(job.status) || job.status === "paused") return job;
    job.status = status;
    this.active.get(id)?.abort(new Error(status));
    const saved = await this.save(job);
    await this.activeRuns.get(id)?.catch(() => {});
    this.active.delete(id);
    if (this.projectLocks.get(job.project_id) === id) this.projectLocks.delete(job.project_id);
    return saved;
  }

  pause(id) { return this.stop(id, "paused"); }
  cancel(id) { return this.stop(id, "cancelled"); }

  async resume(id) {
    const job = await this.get(id);
    if (!["paused", "failed"].includes(job.status)) throw new Error("Only paused or failed jobs can resume");
    if (this.projectLocks.has(job.project_id)) throw new Error("Project already has a running job");
    const reservation = crypto.randomUUID();
    this.projectLocks.set(job.project_id, reservation);
    try { await this.assertNoConflict(job.project_id, id, reservation); }
    catch (error) { this.projectLocks.delete(job.project_id); throw error; }
    job.status = "queued";
    job.error = null;
    this.projectLocks.set(job.project_id, id);
    await this.save(job);
    this.start(job);
    return job;
  }

  async wait(id, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const job = await this.get(id);
      if (TERMINAL.has(job.status) || job.status === "paused") return job;
      await delay(10);
    }
    throw new Error(`Timed out waiting for job ${id}`);
  }

  async waitForProgress(id, completed, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const job = await this.get(id);
      if (job.progress?.completed >= completed || TERMINAL.has(job.status)) return job;
      await delay(5);
    }
    throw new Error(`Timed out waiting for progress on ${id}`);
  }
}
