import React from "react";
import {
  AlertCircle,
  BookMarked,
  Braces,
  Check,
  CircleDot,
  KeyRound,
  LoaderCircle,
  Play,
  RotateCw,
  Save
} from "lucide-react";
import {
  annotatedTextSegments,
  circledNumber,
  displayedNoteText,
  displayedSeriesTitle,
  poemParagraphs,
  proseParagraphs,
  seriesOrdinal
} from "./ebook-format.js";

const KIND_LABELS = {
  heading: "篇题",
  book_text: "书籍文字",
  biography: "传记",
  poem: "诗词",
  preface: "序跋",
  note: "注文",
  colophon: "题跋",
  other: "其他"
};

function defaultResultIds(results) {
  const preferred = ["paddleocr-vl", "pp-ocrv6"]
    .filter(id => results.some(result => result.id === id));
  if (preferred.length) return preferred;
  return results.filter(result => !result.archived).slice(0, 2).map(result => result.id);
}

function checkClientDocument(value, projectId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("根节点必须是 JSON 对象");
  if (value.schema_version !== 1) throw new Error("schema_version 必须为 1");
  if (value.project_id !== projectId) throw new Error(`project_id 必须为 ${projectId}`);
  if (!Array.isArray(value.entries) || !Array.isArray(value.issues)) throw new Error("entries 和 issues 必须是数组");
  for (const entry of value.entries) {
    if (!entry?.id || !Array.isArray(entry.lines) || !Array.isArray(entry.notes) || !Array.isArray(entry.source_pages)) {
      throw new Error("每个 entry 必须包含 id、lines、notes 和 source_pages");
    }
  }
  return value;
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function entryName(entry, index) {
  return entry.title || entry.lines?.[0] || entry.prose?.slice(0, 16) || `${KIND_LABELS[entry.kind] || "条目"} ${index + 1}`;
}

function entryKindLabel(entry) {
  if (entry.kind === "heading") {
    const level = headingLevel(entry);
    return level ? `目录 ${level}级` : KIND_LABELS.heading;
  }
  return KIND_LABELS[entry.kind] || entry.kind;
}

function headingLevel(entry) {
  const legacy = { volume: 1, year: 2, section: 3 };
  const level = legacy[entry.heading_level] || Number(entry.heading_level);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null;
}

export default function EbookWorkspace({ project }) {
  const [document, setDocument] = React.useState(null);
  const [config, setConfig] = React.useState(null);
  const [jsonText, setJsonText] = React.useState("");
  const [jsonError, setJsonError] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [saveState, setSaveState] = React.useState("saved");
  const [selectedEntryId, setSelectedEntryId] = React.useState(null);
  const [resultIds, setResultIds] = React.useState(() => defaultResultIds(project.results || []));
  const [startPage, setStartPage] = React.useState(1);
  const [endPage, setEndPage] = React.useState(Math.min(30, project.pages.length));
  const [model, setModel] = React.useState("");
  const editVersion = React.useRef(0);
  const appliedVersion = React.useRef(0);

  const applyPayload = React.useCallback((payload, preserveEditor = false) => {
    setDocument(payload.document);
    setConfig(payload.config);
    if (!preserveEditor) setJsonText(formatJson(payload.document));
    setModel(current => current || payload.config.model);
    const sourceIds = payload.document.source?.result_ids || [];
    if (sourceIds.length) setResultIds(sourceIds);
    const range = payload.document.source?.page_range;
    if (range) {
      setStartPage(range.start || 1);
      setEndPage(range.end || Math.min(30, project.pages.length));
    }
    setSelectedEntryId(current => payload.document.entries.some(entry => entry.id === current)
      ? current
      : payload.document.entries[0]?.id || null);
  }, [project.pages.length]);

  const loadDocument = React.useCallback(async (preserveEditor = false) => {
    const response = await fetch(`/api/projects/${project.id}/ebook`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法读取诗词整理数据");
    applyPayload(payload, preserveEditor);
    return payload;
  }, [applyPayload, project.id]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDocument(null);
    setJsonText("");
    setResultIds(defaultResultIds(project.results || []));
    setStartPage(1);
    setEndPage(Math.min(30, project.pages.length));
    loadDocument().catch(err => {
      if (!cancelled) setError(err.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [loadDocument, project.id, project.pages.length, project.results]);

  React.useEffect(() => {
    if (!document || editVersion.current === appliedVersion.current || jsonError || running) return;
    const version = editVersion.current;
    setSaveState("pending");
    const timer = window.setTimeout(async () => {
      try {
        setSaveState("saving");
        const response = await fetch(`/api/projects/${project.id}/ebook`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(document)
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "JSON 保存失败");
        if (version === editVersion.current) {
          appliedVersion.current = version;
          setDocument(payload.document);
          setSaveState("saved");
        }
      } catch (err) {
        setSaveState("error");
        setError(err.message);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [document, jsonError, project.id, running]);

  function editJson(value) {
    setJsonText(value);
    try {
      const parsed = checkClientDocument(JSON.parse(value), project.id);
      editVersion.current += 1;
      setDocument(parsed);
      setJsonError("");
      setSelectedEntryId(current => parsed.entries.some(entry => entry.id === current)
        ? current
        : parsed.entries[0]?.id || null);
    } catch (err) {
      setJsonError(err.message);
    }
  }

  async function saveNow() {
    if (!document || jsonError || running) return;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/projects/${project.id}/ebook`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(document)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "JSON 保存失败");
      appliedVersion.current = editVersion.current;
      applyPayload(payload);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setError(err.message);
    }
  }

  function toggleResult(resultId) {
    setResultIds(current => {
      if (current.includes(resultId)) return current.length === 1 ? current : current.filter(id => id !== resultId);
      return current.length >= 2 ? [current[1], resultId] : [...current, resultId];
    });
  }

  async function runBatch() {
    if (running || !config?.configured || !resultIds.length) return;
    setRunning(true);
    setError("");
    setJsonError("");
    const poll = window.setInterval(() => {
      loadDocument().catch(() => {});
    }, 2000);
    try {
      const response = await fetch(`/api/projects/${project.id}/ebook/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result_ids: resultIds,
          start_page: startPage,
          end_page: endPage,
          model
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "诗词整理任务失败");
      applyPayload(payload);
      appliedVersion.current = editVersion.current;
      setSaveState("saved");
    } catch (err) {
      setError(err.message);
      await loadDocument().catch(() => {});
    } finally {
      window.clearInterval(poll);
      setRunning(false);
    }
  }

  if (loading) return <main className="ebook-loading"><LoaderCircle className="spin" size={22} />正在读取诗词整理数据...</main>;
  if (!document) return <main className="ebook-loading"><AlertCircle size={22} />{error || "诗词整理数据不可用"}</main>;

  const generation = document.generation || {};
  const totalPages = Math.max(1, (document.source?.page_range?.end || endPage) - (document.source?.page_range?.start || startPage) + 1);
  const completed = Math.max(0, (generation.completed_through || 0) - (document.source?.page_range?.start || startPage) + 1);

  return (
    <main className="ebook-workspace">
      <section className="ebook-runbar" aria-label="诗词整理任务设置">
        <div className={`api-state ${config?.configured ? "is-ready" : "is-missing"}`}>
          <KeyRound size={16} />
          <span><strong>{config?.configured ? "硅基流动已连接" : "等待 API Key"}</strong><small>{config?.model}</small></span>
        </div>
        <div className="source-results" aria-label="双 OCR 输入">
          <span>校对稿来源</span>
          {(project.results || []).map(result => (
            <label key={result.id} className={resultIds.includes(result.id) ? "is-selected" : ""}>
              <input type="checkbox" checked={resultIds.includes(result.id)} onChange={() => toggleResult(result.id)} disabled={running} />
              {result.label}
            </label>
          ))}
        </div>
        <label className="compact-field">起页<input type="number" min="1" max={project.pages.length} value={startPage}
          onChange={event => setStartPage(Math.max(1, Number(event.target.value) || 1))} disabled={running} /></label>
        <label className="compact-field">止页<input type="number" min={startPage} max={project.pages.length} value={endPage}
          onChange={event => setEndPage(Math.min(project.pages.length, Number(event.target.value) || 30))} disabled={running} /></label>
        <label className="model-field">模型<input value={model} onChange={event => setModel(event.target.value)} disabled={running} /></label>
        <button className="button primary ebook-run" onClick={runBatch}
          disabled={running || !config?.configured || !resultIds.length || startPage > endPage}>
          {running ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
          {running ? "正在分批整理" : `运行 ${startPage}–${endPage} 页`}
        </button>
        {!config?.configured && <p className="api-hint">在项目根目录的 <code>.env.local</code> 填写 <code>SILICONFLOW_API_KEY</code>，然后重启 API。</p>}
        {generation.status !== "not_started" && (
          <div className="generation-progress">
            <span>{generation.status === "complete" ? "已完成" : generation.status === "failed" ? "上次失败，可续跑" : "处理中"}</span>
            <div><i style={{ width: `${Math.min(100, completed / totalPages * 100)}%` }} /></div>
            <strong>{Math.min(completed, totalPages)} / {totalPages} 页</strong>
          </div>
        )}
      </section>

      {error && <div className="ebook-error" role="alert"><AlertCircle size={16} />{error}</div>}

      <aside className="ebook-outline">
        <header><BookMarked size={16} /><strong>结构条目</strong><span>{document.entries.length}</span></header>
        <div className="outline-list">
          {document.entries.map((entry, index) => (
            <button key={entry.id} className={entry.id === selectedEntryId ? "is-active" : ""}
              onClick={() => setSelectedEntryId(entry.id)}>
              <small>{entryKindLabel(entry)} · P{entry.source_pages.join(",") || "?"}</small>
              <strong>{entryName(entry, index)}</strong>
              {entry.review_status === "reviewed" ? <Check size={14} /> : <CircleDot size={12} />}
            </button>
          ))}
          {!document.entries.length && <p>运行首批页面后，篇题、诗词、序跋和注文会显示在这里。</p>}
        </div>
      </aside>

      <section className="ebook-preview-pane">
        <header><span>电子排版</span><small>{document.title}</small></header>
        <EbookPreview document={document} selectedEntryId={selectedEntryId} onSelect={setSelectedEntryId} />
      </section>

      <section className="ebook-json-pane">
        <header>
          <span><Braces size={16} />结构 JSON</span>
          <button className="icon-button" onClick={() => loadDocument()} disabled={running} title="从磁盘重新载入 JSON"><RotateCw size={15} /></button>
          <button className="icon-button" onClick={saveNow} disabled={running || Boolean(jsonError) || saveState === "saving"} title="立即保存 JSON"><Save size={15} /></button>
          <small className={`json-save-state is-${saveState}`}>
            {jsonError ? "格式有误" : saveState === "saving" ? "保存中" : saveState === "pending" ? "等待保存" : saveState === "error" ? "保存失败" : "已保存"}
          </small>
        </header>
        {jsonError && <div className="json-error"><AlertCircle size={14} />{jsonError}</div>}
        <textarea aria-label="电子书结构 JSON" spellCheck="false" value={jsonText} disabled={running}
          onChange={event => editJson(event.target.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              saveNow();
            }
          }} />
      </section>
    </main>
  );
}

function EbookPreview({ document, selectedEntryId, onSelect }) {
  return (
    <article className="ebook-page">
      <header className="ebook-document-head"><h2>{document.title}</h2></header>
      {document.entries.map((entry, entryIndex) => {
        const headingDepth = entry.kind === "heading" ? headingLevel(entry) : null;
        const HeadingTag = headingDepth ? `h${Math.min(6, headingDepth + 2)}` : "h3";
        return (
        <section key={entry.id} className={`ebook-entry kind-${entry.kind} ${headingDepth ? `heading-level-${headingDepth}` : ""} ${entry.id === selectedEntryId ? "is-selected" : ""}`}
          onClick={() => onSelect(entry.id)}>
          {entry.series?.title && document.entries[entryIndex - 1]?.series?.title !== entry.series.title && (
            <h3 className="series-title">{displayedSeriesTitle(entry.series.title)}</h3>
          )}
          {entry.title && (headingDepth
            ? <HeadingTag className="directory-title"><AnnotatedText text={entry.title} notes={entry.notes} field="title" /></HeadingTag>
            : <h3><AnnotatedText text={entry.title} notes={entry.notes} field="title" /></h3>)}
          {entry.subtitle && <p>{entry.subtitle}</p>}
          {entry.series?.index && <p className="series-index">{seriesOrdinal(entry.series.index)}</p>}
          {entry.author && <p className="entry-byline">{entry.author}</p>}
          {entry.lines?.length > 0 && <div className="poem-lines">{poemParagraphs(entry.lines, entry.form).map((lines, index) => (
            <p key={`${entry.id}-paragraph-${index}`}>{lines.map(item => (
              <AnnotatedText key={`${entry.id}-line-${item.line}`} text={item.text} notes={entry.notes} field="lines" line={item.line} />
            ))}</p>
          ))}</div>}
          {entry.prose && <div className="entry-prose">{proseParagraphs(entry.prose).map((paragraph, index) => (
            <p key={`${entry.id}-prose-${index}`}>{paragraph}</p>
          ))}</div>}
          {entry.notes?.length > 0 && <aside className="entry-notes" aria-label="注释">
            <h4>注释</h4>
            {entry.notes.map((note, index) => (
              <p key={`${entry.id}-note-${index}`}><span>{circledNumber(index + 1)}</span>{displayedNoteText(note.text)}</p>
            ))}
          </aside>}
        </section>
      )})}
    </article>
  );
}

function AnnotatedText({ text, notes, field, line }) {
  return annotatedTextSegments(text, notes, field, line).map((segment, index) => segment.noteNumber
    ? <sup key={`note-${segment.noteNumber}-${index}`}>{circledNumber(segment.noteNumber)}</sup>
    : <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>);
}
