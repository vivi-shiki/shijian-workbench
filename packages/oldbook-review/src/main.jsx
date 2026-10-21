import React from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownAZ,
  Archive,
  ArchiveRestore,
  BookOpen,
  BookType,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileJson,
  FolderOpen,
  History,
  Layers,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2
} from "lucide-react";
import EbookWorkspace from "./EbookWorkspace.jsx";
import HistoryWorkspace from "./HistoryWorkspace.jsx";
import "./styles.css";

const STATUS_LABELS = {
  needs_review: "待校",
  reviewed: "已校",
  ignored: "忽略"
};

const KIND_LABELS = {
  main: "正文",
  note: "注文",
  title: "标题",
  page_mark: "页码",
  other: "其他"
};

const PROVIDER_LABELS = {
  "ndlkotenocr-lite": "NDL 古典籍 OCR Lite",
  "paddleocr-vl-1.6": "PaddleOCR-VL 1.6",
  "openai-compatible-paddleocr-vl": "远程 PaddleOCR-VL",
  "remote-paddlevl": "远程 OCR 接口",
  "paddleocr-vl": "PaddleOCR-VL v1.6",
  "pp-ocrv6": "PP-OCRv6 medium",
  manual: "人工"
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sortRegions(regions) {
  return [...regions].sort((a, b) => a.order - b.order);
}

function normalizeOrders(regions) {
  return sortRegions(regions).map((region, index) => ({ ...region, order: index + 1 }));
}

function medianNumber(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function regionMetrics(region) {
  const [x = 0, y = 0, width = 1, height = 1] = region.bbox || [];
  return {
    region,
    x,
    y,
    width,
    height,
    cx: x + width / 2,
    cy: y + height / 2,
    order: region.order || 0
  };
}

function clusterByAxis(items, axis, direction) {
  const centerKey = axis === "x" ? "cx" : "cy";
  const sizeKey = axis === "x" ? "width" : "height";
  const ordered = [...items].sort((a, b) => {
    return direction === "desc" ? b[centerKey] - a[centerKey] : a[centerKey] - b[centerKey];
  });
  const threshold = Math.max(24, medianNumber(items.map((item) => item[sizeKey])) * 0.65);
  const clusters = [];

  for (const item of ordered) {
    let bestCluster = null;
    let bestDistance = Infinity;
    for (const cluster of clusters) {
      const distance = Math.abs(cluster.center - item[centerKey]);
      const localThreshold = Math.max(threshold, Math.min(cluster.size, item[sizeKey]) * 0.8);
      if (distance <= localThreshold && distance < bestDistance) {
        bestCluster = cluster;
        bestDistance = distance;
      }
    }

    if (!bestCluster) {
      clusters.push({
        center: item[centerKey],
        size: item[sizeKey],
        weight: 1,
        items: [item]
      });
    } else {
      bestCluster.items.push(item);
      bestCluster.center = (bestCluster.center * bestCluster.weight + item[centerKey]) / (bestCluster.weight + 1);
      bestCluster.size = Math.max(bestCluster.size, item[sizeKey]);
      bestCluster.weight += 1;
    }
  }

  return clusters.sort((a, b) => {
    return direction === "desc" ? b.center - a.center : a.center - b.center;
  });
}

function orderRegionsForReading(regions, mode) {
  const items = regions.map(regionMetrics);
  if (mode === "oldbook") {
    return clusterByAxis(items, "x", "desc").flatMap((cluster) =>
      [...cluster.items]
        .sort((a, b) => a.y - b.y || b.x - a.x || a.order - b.order)
        .map((item) => item.region)
    );
  }

  return clusterByAxis(items, "y", "asc").flatMap((cluster) =>
    [...cluster.items]
      .sort((a, b) => a.x - b.x || a.y - b.y || a.order - b.order)
      .map((item) => item.region)
  );
}

function textForRegion(region) {
  return region.edited_text ?? region.raw_text ?? "";
}

function statusClass(status) {
  if (status === "reviewed") return "is-reviewed";
  if (status === "ignored") return "is-ignored";
  return "is-pending";
}

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider || "未知来源";
}

function App() {
  const [projects, setProjects] = React.useState([]);
  const [project, setProject] = React.useState(null);
  const [selectedPageId, setSelectedPageId] = React.useState(null);
  const [selectedRegionId, setSelectedRegionId] = React.useState(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [exportResult, setExportResult] = React.useState(null);
  const [error, setError] = React.useState("");
  const [zoom, setZoom] = React.useState(0.42);
  const [filter, setFilter] = React.useState("all");
  const [stage, setStage] = React.useState(() => {
    const requested = new URLSearchParams(window.location.search).get("stage");
    return ["ebook", "history"].includes(requested) ? requested : "ocr";
  });
  const dirtyPages = React.useRef(new Set());
  const busyRef = React.useRef(false);

  React.useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  React.useEffect(() => {
    async function boot() {
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) throw new Error("project list not found");
        const data = await response.json();
        setProjects(data.projects);
        const params = new URLSearchParams(window.location.search);
        const requested = params.get("project");
        const stored = window.localStorage.getItem("oldbook-project-id");
        const available = new Set(data.projects.map((item) => item.id));
        const projectId = available.has(requested)
          ? requested
          : data.projects.some(item => item.id === stored && !item.archived)
            ? stored
            : available.has(data.defaultProjectId)
              ? data.defaultProjectId
              : data.projects[0]?.id;
        if (!projectId) throw new Error("no project.json files found");
        await loadProject(projectId);
      } catch (err) {
        setError(err.message);
      }
    }
    boot();
  }, []);

  async function loadProject(projectId) {
    setError("");
    setExportResult(null);
    const response = await fetch(`/api/project/${projectId}`);
    if (!response.ok) throw new Error(`${projectId} project.json not found`);
    const data = await response.json();
    setProject(data);
    const requestedPage = Number(new URLSearchParams(window.location.search).get("page"));
    const initialPage = data.pages.find(page => page.page_number === requestedPage) || data.pages[0];
    setSelectedPageId(initialPage?.id || null);
    setSelectedRegionId(initialPage?.regions[0]?.id || null);
    setDirty(false);
    dirtyPages.current.clear();
    window.localStorage.setItem("oldbook-project-id", data.id);
    const url = new URL(window.location.href);
    url.searchParams.set("project", data.id);
    window.history.replaceState(null, "", url);
  }

  async function selectProject(projectId) {
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    try {
      if (dirty) await persistCurrent();
      await loadProject(projectId);
    } catch (err) {
      setError(err.message);
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  const selectedPage = React.useMemo(() => {
    return project?.pages.find((page) => page.id === selectedPageId) || null;
  }, [project, selectedPageId]);

  const selectedRegion = React.useMemo(() => {
    return selectedPage?.regions.find((region) => region.id === selectedRegionId) || null;
  }, [selectedPage, selectedRegionId]);

  const summary = React.useMemo(() => {
    if (!project) return { pages: 0, regions: 0, reviewed: 0 };
    let regions = 0;
    let reviewed = 0;
    for (const page of project.pages) {
      regions += page.regions.length;
      reviewed += page.regions.filter((region) => region.status === "reviewed").length;
    }
    return { pages: project.pages.length, regions, reviewed };
  }, [project]);

  function updateProject(mutator) {
    if (busyRef.current || selectedPage?.ocr_status === "pending") return;
    setProject((current) => {
      if (!current) return current;
      const next = { ...current, pages: current.pages.map(page => page.id === selectedPageId ? structuredClone(page) : page) };
      mutator(next);
      return next;
    });
    setDirty(true);
    dirtyPages.current.add(selectedPageId);
  }

  function updateRegion(regionId, patch) {
    updateProject((draft) => {
      const page = draft.pages.find((item) => item.id === selectedPageId);
      if (!page) return;
      page.regions = page.regions.map((region) => {
        if (region.id !== regionId) return region;
        return { ...region, ...patch, updated_at: new Date().toISOString() };
      });
      page.status = page.regions.length > 0 && page.regions.every((region) => region.status === "reviewed")
        ? "done"
        : "needs_review";
    });
  }

  async function persistCurrent(extra = {}) {
      const response = await fetch(`/api/project/${project.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Oldbook-Actor": "human",
          "X-Oldbook-Source": "ocr-workbench"
        },
        body: JSON.stringify({
          active_result_id: project.active_result_id,
          pages: project.pages.filter(page => dirtyPages.current.has(page.id)),
          ...extra
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setProject(data);
      setDirty(false);
      dirtyPages.current.clear();
      setProjects(items => items.map(item => item.id === data.id ? {
        ...item, archived: data.archived, results: data.results, pages: data.pages.length,
        regions: data.pages.reduce((sum, page) => sum + page.regions.length, 0)
      } : item));
      return data;
  }

  async function saveProject(extra = {}) {
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    setError("");
    try {
      const data = await persistCurrent(extra);
      if (extra.target_result_id) {
        const page = data.pages.find(p => p.id === selectedPageId) || data.pages[0];
        setSelectedPageId(page?.id || null);
        setSelectedRegionId(page?.regions[0]?.id || null);
        setExportResult(null);
      }
      return data;
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
      busyRef.current = false;
    }
  }

  async function exportProject(mode = "edited") {
    if (dirty && !await saveProject()) return;
    try {
    const response = await fetch(`/api/projects/${project.id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, result_id: project.active_result_id })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "导出失败");
    setExportResult(data);
    } catch (err) { setError(err.message); }
  }

  function selectPage(page) {
    setSelectedPageId(page.id);
    setSelectedRegionId(page.regions[0]?.id || null);
  }

  function addRegion() {
    if (!selectedPage) return;
    const nextOrder = selectedPage.regions.length + 1;
    const id = `${selectedPage.id}-manual-${Date.now()}`;
    updateProject((draft) => {
      const page = draft.pages.find((item) => item.id === selectedPage.id);
      const width = Math.round(page.width * 0.08);
      const height = Math.round(page.height * 0.72);
      page.regions.push({
        id,
        order: nextOrder,
        kind: "main",
        direction: "vertical",
        bbox: [
          Math.round(page.width * 0.46),
          Math.round(page.height * 0.12),
          width,
          height
        ],
        raw_text: "",
        edited_text: "",
        reading_text: "",
        confidence: 0,
        status: "needs_review",
        notes: "",
        source: { provider: "manual" },
        updated_at: new Date().toISOString()
      });
      page.regions = normalizeOrders(page.regions);
    });
    setSelectedRegionId(id);
  }

  function deleteRegion() {
    if (!selectedPage || !selectedRegion) return;
    updateProject((draft) => {
      const page = draft.pages.find((item) => item.id === selectedPage.id);
      page.regions = normalizeOrders(page.regions.filter((region) => region.id !== selectedRegion.id));
    });
    const remaining = selectedPage.regions.filter((region) => region.id !== selectedRegion.id);
    setSelectedRegionId(remaining[0]?.id || null);
  }

  function moveRegion(delta) {
    if (!selectedPage || !selectedRegion) return;
    const ordered = sortRegions(selectedPage.regions);
    const currentIndex = ordered.findIndex((region) => region.id === selectedRegion.id);
    const nextIndex = clamp(currentIndex + delta, 0, ordered.length - 1);
    if (currentIndex === nextIndex) return;
    const next = [...ordered];
    const [item] = next.splice(currentIndex, 1);
    next.splice(nextIndex, 0, item);
    updateProject((draft) => {
      const page = draft.pages.find((entry) => entry.id === selectedPage.id);
      page.regions = next.map((region, index) => ({ ...region, order: index + 1 }));
    });
  }

  function applyReadingOrder(mode) {
    if (!selectedPage || selectedPage.regions.length < 2) return;
    const ordered = orderRegionsForReading(selectedPage.regions, mode);
    const nextSelectedRegionId = ordered.some((region) => region.id === selectedRegionId)
      ? selectedRegionId
      : ordered[0]?.id || null;

    updateProject((draft) => {
      const page = draft.pages.find((entry) => entry.id === selectedPage.id);
      if (!page) return;
      const timestamp = new Date().toISOString();
      page.regions = ordered.map((region, index) => ({
        ...region,
        order: index + 1,
        updated_at: timestamp
      }));
    });
    setSelectedRegionId(nextSelectedRegionId);
  }

  function markReviewed() {
    if (selectedRegion) updateRegion(selectedRegion.id, { status: "reviewed" });
  }

  async function selectStage(nextStage) {
    if (nextStage === stage || saving) return;
    if (dirty) {
      const saved = await saveProject();
      if (!saved) return;
    }
    setStage(nextStage);
    const url = new URL(window.location.href);
    if (nextStage !== "ocr") url.searchParams.set("stage", nextStage);
    else url.searchParams.delete("stage");
    window.history.replaceState(null, "", url);
  }

  if (error && !project) {
    return (
      <main className="boot">
        <h1>项目未就绪</h1>
        <p>{error}</p>
        <code>npm run project:build</code>
      </main>
    );
  }

  if (!project) {
    return <main className="boot">正在读取项目数据...</main>;
  }

  return (
    <div className={`${stage === "ocr" ? "app-shell" : stage === "ebook" ? "ebook-shell" : "history-shell"} ${saving ? "is-saving" : ""}`}>
      <header className="topbar">
        <div className="project-heading">
          <h1>{project.title}</h1>
          {stage === "ocr" ? <label className="model-select">
            <Layers size={15} />
            <select aria-label="模型识别结果" value={project.active_result_id || ""} disabled={saving}
              onChange={event => saveProject({ target_result_id: event.target.value })}>
              {(project.results || []).map(result => (
                <option key={result.id} value={result.id}>
                  {result.label}{result.status !== "complete" ? ` (${result.completed_pages || 0}/${result.page_count})` : ""}
                </option>
              ))}
            </select>
          </label> : <p>{stage === "ebook" ? "将多模型 OCR 校对稿整理为可编辑的诗歌类古籍电子文本" : "审阅人工与 AI 修改，并维护项目经验摘要"}</p>}
          <p>
            {stage === "ocr" ? `${summary.pages} 页 / ${summary.regions} 个文字框 / ${summary.reviewed} 个已校` : `${summary.pages} 页 / ${project.results?.length || 1} 套 OCR 结果`}
          </p>
        </div>
        <nav className="workflow-tabs" role="tablist" aria-label="电子书制作流程">
          <button type="button" role="tab" aria-selected={stage === "ocr"} onClick={() => selectStage("ocr")}>
            <span>1</span><Layers size={16} /><b>OCR 校对</b>
          </button>
          <button type="button" role="tab" aria-selected={stage === "ebook"} onClick={() => selectStage("ebook")}>
            <span>2</span><BookType size={16} /><b>诗歌结构</b>
          </button>
          <button type="button" role="tab" aria-selected={stage === "history"} onClick={() => selectStage("history")}>
            <span>3</span><History size={16} /><b>修改记录</b>
          </button>
        </nav>
        <div className="top-actions">
          <ProjectSwitcher projects={projects} currentProjectId={project.id} onSelect={selectProject} disabled={saving} />
          {stage === "ocr" && <button className="icon-button archive-button" disabled={saving}
            onClick={() => saveProject({ archived: !project.archived })}
            title={project.archived ? "移出 Archive" : "加入 Archive"}>
            {project.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}
          </button>}
          {stage === "ocr" && <label className="zoom-control">
            缩放
            <input
              type="range"
              min="0.22"
              max="0.8"
              step="0.02"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>}
          {stage === "ocr" && <button className="button secondary" disabled={saving} onClick={() => selectProject(project.id)} title="保存并重新载入项目">
            <RefreshCw size={16} />
            重新载入
          </button>}
          {stage === "ocr" && <button className="button secondary" disabled={saving} onClick={() => exportProject("edited")} title="导出当前模型的校对文本">
            <Download size={16} />
            导出
          </button>}
          {stage === "ocr" && <button className="button primary" onClick={() => saveProject()} disabled={!dirty || saving} title="保存中间 JSON">
            <Save size={16} />
            {saving ? "保存中" : dirty ? "保存" : "已保存"}
          </button>}
        </div>
      </header>
      {error && <div className="save-error" role="alert">{error}</div>}

      {stage === "ebook" ? <EbookWorkspace key={project.id} project={project} />
        : stage === "history" ? <HistoryWorkspace key={project.id} project={project} /> : <>
      <aside className="page-rail">
        <div className="rail-header">
          <PanelLeftClose size={16} />
          页面
        </div>
        <div className="page-list">
          {project.pages.map((page) => (
            <button
              key={page.id}
              className={`page-thumb ${page.id === selectedPageId ? "is-active" : ""}`}
              onClick={() => selectPage(page)}
            >
              <img src={page.image_url} alt={`Page ${page.page_number}`} loading="lazy" decoding="async" />
              <span>{page.volume ? `卷${page.volume} · ${page.source_page}` : String(page.page_number).padStart(3, "0")}</span>
              <b>{page.regions.length}</b>
            </button>
          ))}
        </div>
      </aside>

      <section className="canvas-pane">
        {selectedPage && (
          <DocumentCanvas
            page={selectedPage}
            selectedRegionId={selectedRegionId}
            zoom={zoom}
            onSelect={setSelectedRegionId}
            onChangeRegion={updateRegion}
          />
        )}
      </section>

      <aside className={`review-pane ${selectedPage?.ocr_status === "pending" ? "is-pending-page" : ""}`}>
        <div className="pane-tools">
          {selectedPage?.ocr_status === "pending" && <div className="pending-page">此页等待识别</div>}
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">全部文字框</option>
            <option value="needs_review">仅待校</option>
            <option value="reviewed">仅已校</option>
            <option value="ignored">仅忽略</option>
          </select>
          <button className="icon-button" onClick={addRegion} title="新建文字框">
            <Plus size={17} />
          </button>
          <div className="order-tools" aria-label="阅读顺序">
            <span>阅读顺序</span>
            <button
              className="button order-button"
              disabled={!selectedPage || selectedPage.regions.length < 2}
              onClick={() => applyReadingOrder("oldbook")}
              title="古籍竖排：从右到左分列，列内从上到下"
            >
              <BookOpen size={15} />
              古籍
            </button>
            <button
              className="button order-button"
              disabled={!selectedPage || selectedPage.regions.length < 2}
              onClick={() => applyReadingOrder("regular")}
              title="通用横排：从上到下分行，行内从左到右"
            >
              <ArrowDownAZ size={15} />
              非古籍
            </button>
          </div>
        </div>

        <RegionList
          page={selectedPage}
          filter={filter}
          selectedRegionId={selectedRegionId}
          onSelect={setSelectedRegionId}
        />

        <Inspector
          region={selectedRegion}
          onChange={updateRegion}
          onDelete={deleteRegion}
          onMove={moveRegion}
          onReviewed={markReviewed}
        />

        {exportResult?.ok && (
          <div className="export-box">
            <strong>已导出</strong>
            {Object.entries(exportResult.outputs).map(([key, value]) => (
              <a key={key} href={`/${value}`} target="_blank" rel="noreferrer">
                <FileJson size={14} />
                {key}: {value}
              </a>
            ))}
          </div>
        )}
      </aside>
      </>}
    </div>
  );
}

function ProjectSwitcher({ projects, currentProjectId, onSelect, disabled }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("active");
  const [grouped, setGrouped] = React.useState(true);
  const containerRef = React.useRef(null);
  const currentProject = projects.find((item) => item.id === currentProjectId);

  React.useEffect(() => {
    if (!open) return;

    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const visibleProjects = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((item) => {
      const matchesCategory = category === "all" || (category === "archive" ? item.archived : !item.archived);
      return matchesCategory && `${item.title} ${item.id} ${(item.results || []).map(r => r.label).join(" ")}`.toLowerCase().includes(needle);
    });
  }, [projects, query, category]);
  const groups = grouped && category === "all"
    ? [{ label: "当前项目", items: visibleProjects.filter(p => !p.archived) }, { label: "Archive", items: visibleProjects.filter(p => p.archived) }]
    : [{ label: "", items: visibleProjects }];

  function chooseProject(projectId) {
    setOpen(false);
    setQuery("");
    if (projectId !== currentProjectId) onSelect(projectId);
  }

  return (
    <div className="project-switcher" ref={containerRef}>
      <button
        className="project-trigger"
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="切换项目"
      >
        <FolderOpen size={16} />
        <span>
          <strong>{currentProject?.title || "选择项目"}</strong>
          <em>
            {currentProject
              ? `${currentProject.archived ? "Archive · " : ""}${currentProject.pages} 页 / ${currentProject.results?.length || 1} 套结果`
              : `${projects.length} 个项目`}
          </em>
        </span>
        <ChevronDown size={16} />
      </button>

      {open && (
        <div className="project-popover">
          <div className="project-categories" role="group" aria-label="项目分类">
            {[["active", "当前"], ["archive", "Archive"], ["all", "全部"]].map(([value, label]) => (
              <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{label}</button>
            ))}
            <label><input type="checkbox" checked={grouped} onChange={event => setGrouped(event.target.checked)} />分类</label>
          </div>
          <label className="project-search">
            <Search size={15} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目或 OCR 来源"
            />
          </label>
          <div className="project-options">
            {groups.map(group => <React.Fragment key={group.label}>
            {group.label && group.items.length > 0 && <div className="project-group-label">{group.label}</div>}
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`project-option ${item.id === currentProjectId ? "is-active" : ""}`}
                type="button"
                onClick={() => chooseProject(item.id)}
              >
                <strong>{item.title}</strong>
                <span>{item.pages} 页 / {item.results?.length || 1} 套结果</span>
                <code>{item.id}</code>
                {item.id === currentProjectId && <Check className="project-check" size={15} />}
              </button>
            ))}
            </React.Fragment>)}
            {!visibleProjects.length && <div className="project-empty">没有匹配项目</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentCanvas({ page, selectedRegionId, zoom, onSelect, onChangeRegion }) {
  const [dragState, setDragState] = React.useState(null);
  const displayWidth = Math.round(page.width * zoom);
  const displayHeight = Math.round(page.height * zoom);

  function pointerPosition(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / zoom,
      y: (event.clientY - rect.top) / zoom
    };
  }

  function beginDrag(event, region, mode) {
    event.preventDefault();
    event.stopPropagation();
    onSelect(region.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      id: region.id,
      mode,
      start: { x: event.clientX, y: event.clientY },
      bbox: [...region.bbox]
    });
  }

  function movePointer(event) {
    if (!dragState) return;
    const dx = (event.clientX - dragState.start.x) / zoom;
    const dy = (event.clientY - dragState.start.y) / zoom;
    const [x, y, width, height] = dragState.bbox;
    let next;
    if (dragState.mode === "resize") {
      next = [
        x,
        y,
        clamp(Math.round(width + dx), 16, page.width - x),
        clamp(Math.round(height + dy), 16, page.height - y)
      ];
    } else {
      next = [
        clamp(Math.round(x + dx), 0, page.width - width),
        clamp(Math.round(y + dy), 0, page.height - height),
        width,
        height
      ];
    }
    onChangeRegion(dragState.id, { bbox: next });
  }

  function endPointer() {
    setDragState(null);
  }

  return (
    <div className="canvas-wrap">
      <div className="page-meta">
        <span>Page {String(page.page_number).padStart(3, "0")}</span>
        <span>{page.width} x {page.height}</span>
      </div>
      <div
        className="page-canvas"
        style={{ width: displayWidth, height: displayHeight }}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClick={() => onSelect(null)}
      >
        <img src={page.image_url} alt={`Page ${page.page_number}`} draggable="false" />
        {sortRegions(page.regions).map((region) => {
          const [x, y, width, height] = region.bbox;
          const active = region.id === selectedRegionId;
          return (
            <button
              key={region.id}
              className={`region-box ${active ? "is-active" : ""} ${statusClass(region.status)}`}
              style={{
                left: x * zoom,
                top: y * zoom,
                width: width * zoom,
                height: height * zoom
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(region.id);
              }}
              onPointerDown={(event) => beginDrag(event, region, "move")}
              title={textForRegion(region)}
            >
              <span>{region.order}</span>
              {active && (
                <i
                  className="resize-handle"
                  onPointerDown={(event) => beginDrag(event, region, "resize")}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="canvas-help">拖动框可移动；选中后拖右下角可缩放。坐标按原图像素保存。</div>
    </div>
  );
}

function RegionList({ page, filter, selectedRegionId, onSelect }) {
  const regions = React.useMemo(() => {
    if (!page) return [];
    const ordered = sortRegions(page.regions);
    return filter === "all" ? ordered : ordered.filter((region) => region.status === filter);
  }, [page, filter]);

  if (!page) return null;

  return (
    <div className="region-list">
      {regions.map((region) => (
        <button
          key={region.id}
          className={`region-row ${region.id === selectedRegionId ? "is-active" : ""}`}
          onClick={() => onSelect(region.id)}
        >
          <span className="order">{region.order}</span>
          <span className={`status-dot ${statusClass(region.status)}`} />
          <span className="snippet">{textForRegion(region) || "空白文字框"}</span>
          <span className="confidence">{Math.round((region.confidence || 0) * 100)}%</span>
        </button>
      ))}
    </div>
  );
}

function Inspector({ region, onChange, onDelete, onMove, onReviewed }) {
  if (!region) {
    return <div className="empty-inspector">选择页面上的文字框开始校对。</div>;
  }

  function patch(patchValue) {
    onChange(region.id, patchValue);
  }

  function bboxValue(index, value) {
    const next = [...region.bbox];
    next[index] = Number(value) || 0;
    patch({ bbox: next });
  }

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div>
          <span className="small-label">当前文字框</span>
          <strong>{region.id}</strong>
        </div>
        <div className="move-buttons">
          <button className="icon-button" onClick={() => onMove(-1)} title="上移顺序">
            <ChevronUp size={16} />
          </button>
          <button className="icon-button" onClick={() => onMove(1)} title="下移顺序">
            <ChevronDown size={16} />
          </button>
        </div>
      </div>

      <div className="source-card">
        <Layers size={15} />
        <div>
          <span>来源</span>
          <strong>{providerLabel(region.source?.provider)}</strong>
        </div>
        <code>{region.source?.label || (region.source?.raw_id ?? "manual")}</code>
      </div>

      <div className="form-grid">
        <label>
          类型
          <select value={region.kind} onChange={(event) => patch({ kind: event.target.value })}>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select value={region.status} onChange={(event) => patch({ status: event.target.value })}>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="bbox-grid">
        {["x", "y", "w", "h"].map((label, index) => (
          <label key={label}>
            {label}
            <input
              type="number"
              value={region.bbox[index]}
              onChange={(event) => bboxValue(index, event.target.value)}
            />
          </label>
        ))}
      </div>

      <label className="text-field">
        OCR 原文
        <textarea value={region.raw_text} onChange={(event) => patch({ raw_text: event.target.value })} rows={4} />
      </label>

      <label className="text-field">
        校正文
        <textarea value={region.edited_text} onChange={(event) => patch({ edited_text: event.target.value })} rows={5} />
      </label>

      <label className="text-field">
        阅读整理
        <textarea value={region.reading_text} onChange={(event) => patch({ reading_text: event.target.value })} rows={4} />
      </label>

      <label className="text-field">
        备注
        <textarea value={region.notes} onChange={(event) => patch({ notes: event.target.value })} rows={2} />
      </label>

      <div className="inspector-actions">
        <button className="button primary" onClick={onReviewed}>
          <Check size={16} />
          标记已校
        </button>
        <button className="button danger" onClick={onDelete}>
          <Trash2 size={16} />
          删除
        </button>
      </div>
    </div>
  );
}

const root = import.meta.hot?.data.root || createRoot(document.getElementById("root"));
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<App />);
