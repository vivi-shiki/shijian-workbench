import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobQueue, summarizeProject, estimateModelCost } from "../src/desktop-jobs.mjs";

async function jobDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oldbook-jobs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("project overview counts incomplete pages, review items, failures and a useful next action", () => {
  const overview = summarizeProject({
    pages: [{ ocr_status: "complete" }, { ocr_status: "pending" }, { ocr_status: "failed" }],
    regions: [{ status: "reviewed" }, { status: "needs_review" }, { status: "needs_review" }],
    entries: [{ kind: "poem", review_status: "reviewed" }, { kind: "poem", review_status: "needs_review" }],
    jobs: [{ status: "failed", id: "job-1", error: { page: 3 } }]
  });
  assert.deepEqual({ pages: overview.total_pages, ocr: overview.pending_ocr_pages,
    regions: overview.pending_regions, poems: overview.pending_poems, failures: overview.failed_jobs },
  { pages: 3, ocr: 2, regions: 2, poems: 1, failures: 1 });
  assert.equal(overview.next_action.page, 2);
});

test("a paused job persists its checkpoint and resumes without repeating completed units", async (t) => {
  const directory = await jobDirectory(t);
  const processed = [];
  const runners = { ocr: async ({ checkpoint, report, signal }) => {
    for (let page = (checkpoint?.completed || 0) + 1; page <= 3; page++) {
      if (signal.aborted) throw signal.reason;
      processed.push(page);
      await report({ completed: page, total: 3, checkpoint: { completed: page } });
      if (page === 1) await new Promise(resolve => setTimeout(resolve, 30));
    }
  } };
  const queue = new JobQueue({ directory, runners });
  const job = await queue.enqueue({ type: "ocr", project_id: "book" });
  await queue.waitForProgress(job.id, 1);
  await queue.pause(job.id);
  assert.equal((await queue.get(job.id)).status, "paused");
  const reopened = new JobQueue({ directory, runners });
  assert.equal((await reopened.get(job.id)).checkpoint.completed, 1);
  await reopened.resume(job.id);
  assert.equal((await reopened.wait(job.id)).status, "complete");
  assert.deepEqual(processed, [1, 2, 3]);
});

test("cancel stops work, and a failed task remains diagnosable and retryable", async (t) => {
  const directory = await jobDirectory(t);
  let attempts = 0;
  const queue = new JobQueue({ directory, runners: {
    import: async ({ report, signal }) => {
      attempts++;
      await report({ completed: 1, total: 2, checkpoint: { completed: 1 } });
      if (attempts === 1) throw new Error("disk full on page 2");
      if (signal.aborted) throw signal.reason;
      await report({ completed: 2, total: 2, checkpoint: { completed: 2 } });
    },
    structure: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  } });
  const failed = await queue.enqueue({ type: "import", project_id: "book" });
  assert.equal((await queue.wait(failed.id)).status, "failed");
  assert.match((await queue.get(failed.id)).error.message, /disk full/);
  await queue.resume(failed.id);
  assert.equal((await queue.wait(failed.id)).status, "complete");
  const running = await queue.enqueue({ type: "structure", project_id: "other-book" });
  await queue.cancel(running.id);
  assert.equal((await queue.get(running.id)).status, "cancelled");
});

test("conflicting writes on one project cannot run at the same time", async (t) => {
  const directory = await jobDirectory(t);
  const queue = new JobQueue({ directory, runners: {
    ocr: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  } });
  const running = await queue.enqueue({ type: "ocr", project_id: "book" });
  await assert.rejects(queue.enqueue({ type: "ocr", project_id: "book" }), /already|正在|conflict/i);
  await queue.cancel(running.id);
});

test("simultaneous enqueue calls reserve a project before either starts", async (t) => {
  const directory = await jobDirectory(t);
  const queue = new JobQueue({ directory, runners: { ocr: async ({ signal }) => {
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } } });
  const outcomes = await Promise.allSettled([
    queue.enqueue({ type: "ocr", project_id: "book" }),
    queue.enqueue({ type: "ocr", project_id: "book" })
  ]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
  await queue.cancel(outcomes.find(item => item.status === "fulfilled").value.id);
});

test("cost estimate distinguishes known prices, unknown prices, and a configured budget", () => {
  assert.deepEqual(estimateModelCost({ pages: 10, tokensPerPage: 1000, pricePerMillionTokens: 2 }),
    { known: true, estimated_cost: 0.02, currency: "USD", over_budget: false });
  assert.equal(estimateModelCost({ pages: 10, tokensPerPage: 1000 }).known, false);
  assert.equal(estimateModelCost({ pages: 10, tokensPerPage: 1000,
    pricePerMillionTokens: 2, budget: 0.01 }).over_budget, true);
});
