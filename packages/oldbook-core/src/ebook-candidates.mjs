import fs from "node:fs/promises";
import path from "node:path";
import { diffJson, hashJson } from "./change-history.mjs";
import { evaluateCandidate } from "./ebook-evaluation.mjs";
import { safeId } from "./project-store.mjs";

const CANDIDATE_KINDS = new Set([
  "ebook-candidate",
  "ebook-generation-candidate",
  "manual-page-revision-candidate"
]);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWarning(value, fallbackCode = "candidate_warning") {
  if (typeof value === "string") return { code: fallbackCode, message: value };
  if (!value || typeof value !== "object") return { code: fallbackCode, message: String(value || "候选需要人工复核") };
  return {
    code: text(value.code) || fallbackCode,
    message: text(value.message || value.description) || "候选需要人工复核",
    ...(Array.isArray(value.source_pages) ? { source_pages: value.source_pages } : {})
  };
}

function evaluationWarnings(report, source = "evaluation") {
  if (!report) return [];
  const advisory = (report.warnings || []).map(message => normalizeWarning({
    code: "evaluation_advisory", message: `${source}：${message}`
  }));
  if (report.mechanical_pass !== false) return advisory;
  const failed = Array.isArray(report.failures) ? report.failures : [];
  const failures = failed.length ? failed.map(item => normalizeWarning({
    code: item.code || "evaluation_warning",
    message: item.message || `${source} 未通过：${item.code || "mechanical_check"}`,
    source_pages: item.pages || item.source_pages
  })) : [{ code: "evaluation_warning", message: `${source} 未通过机械检查` }];
  return [...failures, ...advisory];
}

function candidateState(run) {
  if (run.steps.some(step => step.kind === "candidate-approval" || step.kind === "human-approval")) return "approved";
  if (run.steps.some(step => step.kind === "candidate-abandoned")) return "abandoned";
  if (run.manifest.status === "abandoned") return "abandoned";
  return "awaiting_approval";
}

function candidateParts(run) {
  const output = run.output;
  if (!output || typeof output !== "object") throw conflict("该运行没有可用候选");
  if (output.kind && !CANDIDATE_KINDS.has(output.kind)) throw conflict("该运行不是电子书候选");

  const document = output.candidate_document || output.candidate;
  const kind = output.kind || (run.manifest.source === "ebook-candidate" ? "ebook-candidate" : null);
  if (!kind || !CANDIDATE_KINDS.has(kind) || !document) throw conflict("该运行没有可用候选");
  const candidateHash = output.candidate_hash;
  const baselineHash = output.baseline_hash;
  if (!candidateHash || !baselineHash || hashJson(document) !== candidateHash) {
    throw conflict("候选完整性校验失败");
  }
  return { output, document, kind, candidateHash, baselineHash };
}

function warningsFromRun(run) {
  const { output } = candidateParts(run);
  const warnings = [
    ...(output.warnings || []).map(value => normalizeWarning(value)),
    ...(output.diagnostics || []).map(value => normalizeWarning(value, "validation_warning")),
    ...(output.model_issues || []).map(value => normalizeWarning(value, "model_issue")),
    ...evaluationWarnings(output.evaluation, "候选初始评估"),
    ...run.steps
      .filter(step => step.kind === "independent-evaluation")
      .flatMap(step => evaluationWarnings(step.report, "独立评估"))
  ];
  return [...new Map(warnings.map(warning => [JSON.stringify(warning), warning])).values()];
}

function candidatePages(run, document, output) {
  if (Number.isInteger(output.page_number)) return [output.page_number];
  const targetIds = new Set(run.input?.task?.entry_ids || []);
  if (targetIds.size) {
    return [...new Set((document.entries || []).filter(entry => targetIds.has(entry.id))
      .flatMap(entry => entry.source_pages || []))].sort((a, b) => a - b);
  }
  const range = output.page_range || document.source?.page_range;
  if (Number.isInteger(range?.start) && Number.isInteger(range?.end)) {
    return Array.from({ length: Math.max(0, range.end - range.start + 1) }, (_, index) => range.start + index);
  }
  return [...new Set((document.entries || []).flatMap(entry => entry.source_pages || []))].sort((a, b) => a - b);
}

function publicCandidate(run, { includeDocument = true } = {}) {
  const { output, document, kind, candidateHash, baselineHash } = candidateParts(run);
  const pages = candidatePages(run, document, output);
  return {
    run_id: run.manifest.id,
    project_id: run.manifest.project_id,
    kind,
    state: candidateState(run),
    source: run.manifest.source,
    actor: run.manifest.actor,
    provider: run.manifest.provider,
    model: run.manifest.model,
    created_at: run.manifest.started_at,
    updated_at: run.manifest.completed_at || run.manifest.updated_at || run.manifest.started_at,
    baseline_hash: baselineHash,
    candidate_hash: candidateHash,
    warnings: warningsFromRun(run),
    summary: {
      page_number: output.page_number || null,
      page_range: output.page_range || document.source?.page_range || null,
      pages,
      entries: document.entries?.length || 0,
      changes: Array.isArray(output.diff) ? output.diff.length : null
    },
    diff: output.diff || null,
    ...(includeDocument ? { candidate_document: structuredClone(document) } : {})
  };
}

export function buildCandidateOutput({ kind, baseline, candidate, warnings = [], ...details }) {
  if (!CANDIDATE_KINDS.has(kind)) throw new Error(`Unsupported candidate kind: ${kind}`);
  return {
    kind,
    baseline_hash: hashJson(baseline),
    candidate_hash: hashJson(candidate),
    candidate_document: structuredClone(candidate),
    diff: diffJson(baseline, candidate),
    warnings: warnings.map(value => normalizeWarning(value)),
    ...details
  };
}

export class EbookCandidates {
  constructor(history) {
    this.history = history;
  }

  async get(projectId, runId, options = {}) {
    const run = await this.history.readRun(safeId(projectId), safeId(runId));
    return publicCandidate(run, options);
  }

  async list(projectId, { state = null, limit = 50 } = {}) {
    const id = safeId(projectId);
    const directory = path.join(this.history.historyDirectory(id), "runs");
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const candidate = await this.get(id, entry.name, { includeDocument: false });
        if (!state || candidate.state === state) candidates.push(candidate);
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
    candidates.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    return candidates.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  async approve(projectId, runId, approval, ebookStore, audit = {}) {
    const id = safeId(projectId);
    const safeRunId = safeId(runId);
    const run = await this.history.readRun(id, safeRunId);
    const parts = candidateParts(run);
    const state = candidateState(run);
    if (state !== "awaiting_approval") throw conflict(`候选当前状态为 ${state}，不能再次批准`);

    const note = text(approval?.note || audit.note);
    if (!note || approval?.candidate_hash !== parts.candidateHash) {
      throw badRequest("批准需要明确说明和匹配的 candidate_hash");
    }

    let warnings = warningsFromRun(run);
    if (run.manifest.source === "ebook-candidate" && run.input?.frozen?.baseline && run.input?.task) {
      const suites = [run.input.suite, ...run.steps
        .filter(step => step.kind === "independent-evaluation")
        .map(step => step.suite)].filter(Boolean);
      for (const suite of suites) {
        const report = evaluateCandidate(run.input.frozen.baseline, parts.document, run.input.task, suite);
        warnings.push(...evaluationWarnings(report, "批准前复核"));
      }
    }
    warnings = [...new Map(warnings.map(warning => [JSON.stringify(warning), warning])).values()];

    const actor = audit.actor || "human";
    const channel = text(approval?.channel || audit.channel) || "api";
    const requestedBy = text(approval?.requested_by || audit.requested_by) || (actor === "human" ? "human" : "unspecified");
    const approvedAt = new Date().toISOString();
    const saved = await ebookStore.save(id, structuredClone(parts.document), {
      actor,
      source: "approved-ebook-candidate",
      note,
      expected_hash: parts.baselineHash,
      run_id: safeRunId,
      metadata: {
        candidate_kind: parts.kind,
        candidate_hash: parts.candidateHash,
        generated_by: run.manifest.actor,
        approval: "explicit",
        channel,
        requested_by: requestedBy,
        warnings_count: warnings.length
      }
    });
    const approvalRecord = {
      kind: "candidate-approval",
      decision: "approved",
      note,
      actor,
      channel,
      requested_by: requestedBy,
      candidate_hash: parts.candidateHash,
      warnings,
      applied_at: approvedAt
    };
    await this.history.recordRunStep(id, safeRunId, approvalRecord);
    await this.history.finishRun(id, safeRunId, {
      status: "complete",
      output: { ...parts.output, approval: approvalRecord, applied_at: approvedAt }
    });
    return { ...saved, candidate: await this.get(id, safeRunId, { includeDocument: false }) };
  }

  async abandon(projectId, runId, details = {}, audit = {}) {
    const id = safeId(projectId);
    const safeRunId = safeId(runId);
    const run = await this.history.readRun(id, safeRunId);
    candidateParts(run);
    const state = candidateState(run);
    if (state !== "awaiting_approval") throw conflict(`候选当前状态为 ${state}，不能放弃`);
    const note = text(details.note || audit.note);
    if (!note) throw badRequest("放弃候选需要说明原因");
    const record = {
      kind: "candidate-abandoned",
      decision: "abandoned",
      note,
      actor: audit.actor || "human",
      channel: text(details.channel || audit.channel) || "api",
      requested_by: text(details.requested_by || audit.requested_by) || "unspecified"
    };
    await this.history.recordRunStep(id, safeRunId, record);
    await this.history.finishRun(id, safeRunId, { status: "abandoned", output: run.output });
    return await this.get(id, safeRunId, { includeDocument: false });
  }
}
