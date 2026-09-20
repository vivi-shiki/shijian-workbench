import React from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, CheckCircle2, ChevronDown, Database, Link2 } from "lucide-react";
import DatasetWorkspace from "./DatasetWorkspace.jsx";
import "./styles.css";

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`读取失败：${response.status}`);
  return response.json();
}

const WINDOW_RADIUS = 2;

async function loadLiveProject(projectId, pageNumber, signal) {
  const from = Math.max(1, pageNumber - WINDOW_RADIUS);
  const to = pageNumber + WINDOW_RADIUS;
  return fetchJson(`/api/projects/${projectId}/reader?from=${from}&to=${to}`, signal);
}

function mergeLiveData(current, incoming) {
  if (!current || current.manifest || current.project?.id !== incoming.project?.id) return incoming;
  const previousResults = new Map((current.results || []).map((result) => [result.id, result]));
  const results = (incoming.results || []).map((result) => {
    const previous = previousResults.get(result.id);
    const pages = new Map((previous?.pages || []).map((page) => [page.page_number, page]));
    for (const page of result.pages || []) pages.set(page.page_number, page);
    return { ...result, pages: [...pages.values()].sort((a, b) => a.page_number - b.page_number) };
  });
  return { ...incoming, results };
}

function App() {
  const [projects, setProjects] = React.useState([]);
  const [projectId, setProjectId] = React.useState("");
  const [datasets, setDatasets] = React.useState([]);
  const [scope, setScope] = React.useState("");
  const [scopeProjectId, setScopeProjectId] = React.useState("");
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const liveCacheRef = React.useRef(new Map());
  const liveRequestsRef = React.useRef(new Map());
  const selectionRef = React.useRef("");
  selectionRef.current = `${projectId}:${scope}`;

  React.useEffect(() => {
    fetch("/api/projects")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取项目列表")))
      .then((payload) => {
        const visibleProjects = (payload.projects || []).filter((project) => !project.archived);
        setProjects(visibleProjects);
        setProjectId(visibleProjects.some((project) => project.id === payload.defaultProjectId)
          ? payload.defaultProjectId
          : visibleProjects[0]?.id || "");
      })
      .catch((reason) => setError(reason.message));
  }, []);

  React.useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setDatasets([]);
    setScope("");
    setScopeProjectId("");
    setData(null);
    setError("");
    fetchJson(`/api/projects/${projectId}/datasets`, controller.signal)
      .then((payload) => {
        const available = payload.datasets || [];
        setDatasets(available);
        setScope(available[0] ? `dataset:${available[0].id}` : "live");
        setScopeProjectId(projectId);
      })
      .catch((reason) => { if (reason.name !== "AbortError") setError(reason.message); });
    return () => controller.abort();
  }, [projectId]);

  React.useEffect(() => {
    if (!projectId || !scope || scopeProjectId !== projectId) return;
    const controller = new AbortController();
    const project = projects.find((item) => item.id === projectId);
    setError("");
    const cached = scope === "live" ? liveCacheRef.current.get(projectId) : null;
    setData(cached || null);
    const firstPage = project?.page_range?.start || 1;
    const initialPage = Math.min(firstPage + WINDOW_RADIUS, project?.page_range?.end || firstPage + WINDOW_RADIUS);
    const request = scope === "live" && cached
      ? Promise.resolve(cached)
      : scope === "live"
        ? loadLiveProject(projectId, initialPage, controller.signal)
        : fetchJson(`/api/projects/${projectId}/datasets/${encodeURIComponent(scope.slice("dataset:".length))}`, controller.signal);
    request
      .then((payload) => {
        if (scope === "live") liveCacheRef.current.set(projectId, payload);
        setData(payload);
      })
      .catch((reason) => { if (reason.name !== "AbortError") setError(reason.message); });
    return () => controller.abort();
  }, [projectId, projects, scope, scopeProjectId]);

  const loadLivePage = React.useCallback((pageNumber) => {
    const cached = liveCacheRef.current.get(projectId);
    const alreadyLoaded = cached?.results?.length && cached.results.every((result) =>
      result.pages?.some((page) => page.page_number === pageNumber));
    if (alreadyLoaded) {
      setData(cached);
      return Promise.resolve();
    }
    const requestKey = `${projectId}:${pageNumber}`;
    if (liveRequestsRef.current.has(requestKey)) return liveRequestsRef.current.get(requestKey);
    const request = loadLiveProject(projectId, pageNumber)
      .then((payload) => {
        const merged = mergeLiveData(liveCacheRef.current.get(projectId), payload);
        liveCacheRef.current.set(projectId, merged);
        if (selectionRef.current === `${projectId}:live`) setData(merged);
      })
      .catch((reason) => setError(reason.message))
      .finally(() => liveRequestsRef.current.delete(requestKey));
    liveRequestsRef.current.set(requestKey, request);
    return request;
  }, [projectId]);

  const loadLiveRange = React.useCallback(async (pageStart, pageEnd) => {
    const payload = await fetchJson(`/api/projects/${projectId}/reader?from=${pageStart}&to=${pageEnd}`);
    const merged = mergeLiveData(liveCacheRef.current.get(projectId), payload);
    liveCacheRef.current.set(projectId, merged);
    if (selectionRef.current === `${projectId}:live`) setData(merged);
    return merged;
  }, [projectId]);

  const reviseLivePage = React.useCallback(async ({ pageStart, pageEnd, manualPrompt }) => {
    const response = await fetch(`/api/projects/${projectId}/ebook/revise-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_page: pageStart, end_page: pageEnd, manual_prompt: manualPrompt })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || "本页模型修订失败");
    return payload;
  }, [projectId]);

  const applyPageRevision = React.useCallback(async ({ runId, candidateHash }) => {
    const response = await fetch(`/api/projects/${projectId}/ebook/candidates/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Oldbook-Actor": "human",
        "X-Oldbook-Source": "web-page-revision",
        "X-Oldbook-Channel": "web",
        "X-Oldbook-Requested-By": "human"
      },
      body: JSON.stringify({
        candidate_hash: candidateHash,
        note: "在页面校对界面明确批准单页模型修订候选",
        channel: "web",
        requested_by: "human"
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || "单页修订候选应用失败");
    const current = liveCacheRef.current.get(projectId);
    if (current) {
      const updated = { ...current, ebook: payload.document, model_config: payload.config };
      liveCacheRef.current.set(projectId, updated);
      if (selectionRef.current === `${projectId}:live`) setData(updated);
    }
    return payload;
  }, [projectId]);

  const selectedProject = projects.find((item) => item.id === projectId);
  const livePageCount = selectedProject?.pages || data?.results?.[0]?.pages?.length || 0;
  const livePageRange = selectedProject?.page_range || (livePageCount ? { start: 1, end: livePageCount } : null);
  return (
    <main className="reader-app">
      <header className="reader-header">
        <div className="reader-brand">
          <BookOpen size={22} aria-hidden="true" />
          <div>
            <h1>{data?.project?.title || selectedProject?.title || "古籍对照阅读"}</h1>
            <p>原页、双 OCR 与现代阅读版</p>
          </div>
        </div>
        <div className="dataset-status" aria-label="数据集状态">
          {data?.manifest ? <CheckCircle2 size={16} /> : <Database size={16} />}
          <span>{data?.manifest ? `P${String(data.manifest.page_range.start).padStart(3, "0")}-${String(data.manifest.page_range.end).padStart(3, "0")} 已冻结` : livePageRange ? `P${String(livePageRange.start).padStart(3, "0")}-${String(livePageRange.end).padStart(3, "0")} 当前工作区` : "正在读取"}</span>
          {data?.links?.summary?.coverage != null ? <em><Link2 size={13} /> {Math.round(data.links.summary.coverage * 100)}% 已连接</em> : data && !data.manifest ? <em>未生成连接</em> : null}
        </div>
        <div className="reader-selectors">
          <label className="reader-select-control">
            <span>项目</span>
            <div><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></div>
          </label>
          <label className="reader-select-control reader-scope-select">
            <span>数据范围</span>
            <div><select value={scope} disabled={!scope} onChange={(event) => setScope(event.target.value)}>{datasets.map((dataset) => <option key={dataset.id} value={`dataset:${dataset.id}`}>P{String(dataset.page_range.start).padStart(3, "0")}–{String(dataset.page_range.end).padStart(3, "0")} · 已冻结</option>)}<option value="live">{livePageRange ? `P${String(livePageRange.start).padStart(3, "0")}–${String(livePageRange.end).padStart(3, "0")}` : "当前范围"} · 当前工作区</option></select><ChevronDown size={15} aria-hidden="true" /></div>
          </label>
        </div>
      </header>
      {error ? <div className="reader-error" role="alert">{error}</div> : null}
      {data ? <DatasetWorkspace key={`${projectId}:${scope}`} data={data} onPageRequest={data.manifest ? null : loadLivePage} onEnsureRange={data.manifest ? null : loadLiveRange} onRevisePage={data.manifest ? null : reviseLivePage} onApplyPageRevision={data.manifest ? null : applyPageRevision} /> : <div className="reader-loading">正在读取对照资料…</div>}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
