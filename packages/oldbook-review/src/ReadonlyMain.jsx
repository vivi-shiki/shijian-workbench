import React from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, CheckCircle2, ChevronDown, Database, Link2 } from "lucide-react";
import DatasetWorkspace from "./DatasetWorkspace.jsx";
import "./styles.css";

function App() {
  const [projects, setProjects] = React.useState([]);
  const [projectId, setProjectId] = React.useState("");
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    fetch("/api/projects")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取项目列表")))
      .then((payload) => {
        setProjects(payload.projects || []);
        setProjectId(payload.defaultProjectId || payload.projects?.[0]?.id || "");
      })
      .catch((reason) => setError(reason.message));
  }, []);

  React.useEffect(() => {
    if (!projectId) return;
    setData(null);
    setError("");
    fetch(`/api/projects/${projectId}/datasets/latest`)
      .then(async (response) => {
        if (response.ok) return response.json();
        if (response.status !== 404) throw new Error("无法读取冻结数据集");
        const project = projects.find((item) => item.id === projectId);
        const [ebookResponse, ...resultResponses] = await Promise.all([
          fetch(`/api/projects/${projectId}/ebook`),
          ...(project?.results || []).map((result) => fetch(`/api/project/${projectId}?result=${result.id}`))
        ]);
        const ebookPayload = ebookResponse.ok ? await ebookResponse.json() : { document: { entries: [], issues: [] } };
        const results = await Promise.all(resultResponses.map((item) => item.json()));
        return {
          manifest: null,
          approval: null,
          links: { summary: {}, links: [], by_target: {}, by_region: {} },
          ebook: ebookPayload.document,
          project: results[0] || project,
          results
        };
      })
      .then(setData)
      .catch((reason) => setError(reason.message));
  }, [projectId, projects]);

  const selectedProject = projects.find((item) => item.id === projectId);
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
          <span>{data?.manifest ? `P${String(data.manifest.page_range.start).padStart(3, "0")}-${String(data.manifest.page_range.end).padStart(3, "0")} 已冻结` : "实时数据"}</span>
          {data?.links?.summary?.coverage != null ? <em><Link2 size={13} /> {Math.round(data.links.summary.coverage * 100)}% 已连接</em> : null}
        </div>
        <label className="reader-project-select">
          <span className="sr-only">切换项目</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
          <ChevronDown size={15} aria-hidden="true" />
        </label>
      </header>
      {error ? <div className="reader-error" role="alert">{error}</div> : null}
      {data ? <DatasetWorkspace data={data} /> : <div className="reader-loading">正在读取对照资料…</div>}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
