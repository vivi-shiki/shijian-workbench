import React from "react";
import { AlertTriangle, Eye, FileText, History, Image as ImageIcon, Link2, LoaderCircle, WandSparkles, X } from "lucide-react";
import {
  annotatedTextSegments,
  circledNumber,
  displayedNoteText,
  displayedSeriesTitle,
  poemParagraphs,
  seriesOrdinal
} from "./ebook-format.js";
import { recentPrompts, rememberPrompt } from "./prompt-history.js";
import { REVISION_PRESETS } from "./revision-presets.js";

const SOURCE_LABELS = { "paddleocr-vl": "PaddleOCR-VL", "pp-ocrv6": "PP-OCRv6" };
const EMPTY_LINKS = { by_region: {}, by_target: {} };
const EMPTY_SET = new Set();
const NOOP = () => {};
const pageLabel = (number) => Number.isInteger(number) && number > 0 ? `P${String(number).padStart(3, "0")}` : "未定位";

function splitProse(value) {
  return String(value || "").split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [])
    .map((text) => text.trim()).filter(Boolean);
}

function textForRegion(region) { return region.reading_text || region.edited_text || region.raw_text || ""; }
function firstPage(entry) { return entry.source_pages?.[0] || null; }
function entryLabel(entry) {
  if (entry.series?.title) return `${displayedSeriesTitle(entry.series.title)} ${seriesOrdinal(entry.series.index)}`.trim();
  return entry.title || entry.lines?.[0] || entry.prose?.slice(0, 16) || entry.id;
}

function findCurrent(container, selector, offset = 80) {
  if (!container) return null;
  const top = container.getBoundingClientRect().top + offset;
  let current = null;
  for (const element of container.querySelectorAll(selector)) {
    if (element.getBoundingClientRect().top <= top) current = element;
    else break;
  }
  return current;
}

function PageRail({ pages, activePage, onSelect }) {
  const activeRef = React.useRef(null);
  React.useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [activePage]);
  return <nav className="dataset-page-rail" aria-label="页面目录">
    <div className="rail-heading"><ImageIcon size={15} /><span>页面</span></div>
    <div className="rail-scroll">{pages.map((page) => {
      const nearby = Math.abs(page.page_number - activePage) <= 2;
      return <button key={page.id} ref={page.page_number === activePage ? activeRef : null} className={page.page_number === activePage ? "is-active" : ""} aria-current={page.page_number === activePage ? "page" : undefined} onClick={() => onSelect(page.page_number)}><span className="rail-page-thumb">{nearby ? <img src={page.image_url || `/${page.image_path}`} alt="" loading={page.page_number === activePage ? "eager" : "lazy"} /> : null}</span><span>{pageLabel(page.page_number)}</span></button>;
    })}</div>
  </nav>;
}

function StructureRail({ entries, activeEntry, onSelect }) {
  const activeRef = React.useRef(null);
  React.useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [activeEntry]);
  return <nav className="dataset-structure-rail" aria-label="正文目录">
    <div className="rail-heading"><FileText size={15} /><span>结构</span></div>
    <div className="rail-scroll">{entries.map((entry) => <button key={entry.id} ref={entry.id === activeEntry ? activeRef : null} className={entry.id === activeEntry ? "is-active" : ""} aria-current={entry.id === activeEntry ? "location" : undefined} onClick={() => onSelect(entry)}><small>{pageLabel(firstPage(entry))}</small><span>{entryLabel(entry)}</span></button>)}</div>
  </nav>;
}

function PageImage({ result, page, priority, relatedRegions, onRegionEnter, onRegionLeave, onRegionClick }) {
  const resultPage = result?.pages.find((item) => item.page_number === page.page_number);
  if (!resultPage) return null;
  return <div className="source-image-wrap">
    <img src={resultPage.image_url || `/${resultPage.image_path}`} alt={`${pageLabel(page.page_number)} 校正页`} loading={priority ? "eager" : "lazy"} />
    <div className="source-boxes" aria-hidden="true">{resultPage.regions.map((region) => {
      const key = `${result.id}/${resultPage.id}/${region.id}`;
      const [x, y, width, height] = region.bbox || [0, 0, 0, 0];
      return <button key={key} tabIndex={-1} className={relatedRegions.has(key) ? "is-related" : ""} style={{ left: `${x / resultPage.width * 100}%`, top: `${y / resultPage.height * 100}%`, width: `${width / resultPage.width * 100}%`, height: `${height / resultPage.height * 100}%` }} onMouseEnter={() => onRegionEnter(key)} onMouseLeave={onRegionLeave} onClick={() => onRegionClick(key)} />;
    })}</div>
  </div>;
}

function OcrSource({ result, pageNumber, links, relatedRegions, onRegionEnter, onRegionLeave, onRegionClick }) {
  const page = result.pages.find((item) => item.page_number === pageNumber);
  if (!page) return null;
  return <section className={`ocr-source ocr-source-${result.id}`}>
    <header><span className="source-dot" />{SOURCE_LABELS[result.id] || result.label || result.id}<small>{page.regions.length} 区</small></header>
    <div className="ocr-region-list">{[...page.regions].sort((a, b) => a.order - b.order).map((region) => {
      const key = `${result.id}/${page.id}/${region.id}`;
      const linked = links.by_region?.[key]?.length || 0;
      return <button key={key} className={relatedRegions.has(key) ? "is-related" : ""} onMouseEnter={() => onRegionEnter(key)} onMouseLeave={onRegionLeave} onClick={() => onRegionClick(key)}><span className="ocr-order">{String(region.order).padStart(2, "0")}</span><span className="ocr-text">{textForRegion(region) || "（空）"}</span>{linked ? <small title={`${linked} 个正文连接`}><Link2 size={11} />{linked}</small> : null}</button>;
    })}</div>
  </section>;
}

function EvidencePane({ pages, results, links, activePage, relatedRegions, onPageVisible, onRegionEnter, onRegionLeave, onRegionClick, idPrefix = "" }) {
  const paneRef = React.useRef(null);
  React.useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    const track = () => { const current = findCurrent(pane, "[data-page-section]", 120); if (current) onPageVisible(Number(current.dataset.pageSection)); };
    pane.addEventListener("scroll", track, { passive: true });
    track();
    return () => pane.removeEventListener("scroll", track);
  }, [onPageVisible]);
  return <section className="dataset-evidence-pane" ref={paneRef} aria-label="原页与 OCR">
    <div className="pane-title"><div><span>原页与 OCR</span><small>双模型识别证据</small></div><b>{pageLabel(activePage)}</b></div>
    {pages.map((page) => <article className="evidence-page" id={`${idPrefix}source-page-${page.page_number}`} data-page-section={page.page_number} key={page.id}>
      <div className="evidence-page-heading"><h2>{pageLabel(page.page_number)}</h2><span>卷 {page.volume} · 原第 {page.source_page} 页</span></div>
      <div className="evidence-page-grid"><PageImage result={results[0]} page={page} priority={page.page_number === activePage} relatedRegions={relatedRegions} onRegionEnter={onRegionEnter} onRegionLeave={onRegionLeave} onRegionClick={onRegionClick} /><div className="ocr-source-columns">{results.map((result) => <OcrSource key={result.id} result={result} pageNumber={page.page_number} links={links} relatedRegions={relatedRegions} onRegionEnter={onRegionEnter} onRegionLeave={onRegionLeave} onRegionClick={onRegionClick} />)}</div></div>
    </article>)}
  </section>;
}

function Target({ id, idPrefix = "", className = "", relatedTargets, onEnter, onLeave, children }) {
  return <span id={`${idPrefix}target-${id}`} className={`edition-target ${className} ${relatedTargets.has(id) ? "is-related" : ""}`} onMouseEnter={() => onEnter(id)} onMouseLeave={onLeave}>{children}</span>;
}

function AnnotatedText({ text, notes, field, line = null }) {
  return annotatedTextSegments(text, notes, field, line).map((segment, index) => segment.noteNumber
    ? <sup className="edition-note-callout" key={`note-${segment.noteNumber}-${index}`}>{circledNumber(segment.noteNumber)}</sup>
    : <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>);
}

function RevisionPreviewDialog({ pageStart, pageEnd, pages, entries, results, links, onClose }) {
  const [hoveredRegion, setHoveredRegion] = React.useState("");
  const [hoveredTarget, setHoveredTarget] = React.useState("");
  const relatedTargets = React.useMemo(() => new Set(hoveredRegion ? links.by_region?.[hoveredRegion] || [] : []), [hoveredRegion, links]);
  const relatedRegions = React.useMemo(() => new Set(hoveredTarget
    ? (links.by_target?.[hoveredTarget] || []).map((source) => source.region_key)
    : hoveredRegion ? [hoveredRegion] : []), [hoveredRegion, hoveredTarget, links]);
  const activeEntry = entries[0]?.id || "";
  const activePage = pages[0]?.page_number || pageStart;
  const rangeLabel = pageStart === pageEnd ? pageLabel(pageStart) : `${pageLabel(pageStart)}–${pageLabel(pageEnd)}`;

  return <div className="revision-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="revision-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="revision-preview-title">
      <header>
        <div><h2 id="revision-preview-title">{rangeLabel} 候选排版预览</h2><p>左侧为目标范围双 OCR，右侧为尚未批准的候选结果。</p></div>
        <button className="icon-button" type="button" onClick={onClose} title="关闭预览"><X size={17} /></button>
      </header>
      <div className="revision-preview-workspace">
        <ComparisonPanes
          pages={pages}
          results={results}
          links={links}
          activePage={activePage}
          relatedRegions={relatedRegions}
          onPageVisible={NOOP}
          onRegionEnter={setHoveredRegion}
          onRegionLeave={() => setHoveredRegion("")}
          onRegionClick={NOOP}
          entries={entries}
          activeEntry={activeEntry}
          relatedTargets={relatedTargets}
          onEntryVisible={NOOP}
          onTargetEnter={setHoveredTarget}
          onTargetLeave={() => setHoveredTarget("")}
          idPrefix="revision-preview-"
        />
      </div>
    </section>
  </div>;
}

function PageRevisionDialog({ projectId, pageNumber, pages, entries, results, links, modelConfig, onClose, onConfirm, onApply, onEnsureRange }) {
  const firstAvailablePage = pages[0]?.page_number || pageNumber;
  const lastAvailablePage = pages.at(-1)?.page_number || pageNumber;
  const [rangeMode, setRangeMode] = React.useState("single");
  const [pageStart, setPageStart] = React.useState(pageNumber);
  const [pageEnd, setPageEnd] = React.useState(pageNumber);
  const [manualPrompt, setManualPrompt] = React.useState("");
  const [promptHistory, setPromptHistory] = React.useState(() => recentPrompts(projectId));
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState("");
  const [candidate, setCandidate] = React.useState(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const promptRef = React.useRef(null);
  React.useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || running) return;
      if (previewOpen) setPreviewOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, previewOpen, running]);
  const rangeLabel = pageStart === pageEnd ? pageLabel(pageStart) : `${pageLabel(pageStart)}–${pageLabel(pageEnd)}`;
  const selectedPages = React.useMemo(() => pages.filter((page) =>
    page.page_number >= pageStart && page.page_number <= pageEnd), [pageEnd, pageStart, pages]);
  const selectedEntries = React.useMemo(() => entries.filter((entry) =>
    entry.source_pages?.some((page) => page >= pageStart && page <= pageEnd)), [entries, pageEnd, pageStart]);
  const pageJson = React.useMemo(() => JSON.stringify({
    page_range: { start: pageStart, end: pageEnd },
    entries: selectedEntries
  }, null, 2), [pageEnd, pageStart, selectedEntries]);
  const ocrPages = React.useMemo(() => (results || []).map((result) => {
    const range = (result.pages || []).filter((page) => page.page_number >= pageStart && page.page_number <= pageEnd);
    return {
      id: result.id,
      label: SOURCE_LABELS[result.id] || result.label || result.id,
      json: range.length ? JSON.stringify(range.map((page) => ({
        result_id: result.id,
        page_number: page.page_number,
        width: page.width,
        height: page.height,
        regions: [...(page.regions || [])].sort((left, right) => left.order - right.order).map((region) => ({
          id: region.id,
          order: region.order,
          kind: region.kind,
          bbox: region.bbox,
          text: textForRegion(region)
        }))
      })), null, 2) : "目标范围 OCR 将在提交时加载"
    };
  }), [pageEnd, pageStart, results]);
  const chooseMode = (mode) => {
    setRangeMode(mode);
    if (mode === "single") {
      setPageStart(pageNumber);
      setPageEnd(pageNumber);
    } else {
      setPageStart(pageNumber);
      setPageEnd(Math.min(lastAvailablePage, pageNumber + 1));
    }
  };
  const changeStart = (value) => {
    const next = Math.max(firstAvailablePage, Math.min(lastAvailablePage, Number(value) || firstAvailablePage));
    setPageStart(next);
    setPageEnd((current) => Math.max(next, Math.min(current, next + 4, lastAvailablePage)));
  };
  const changeEnd = (value) => {
    const next = Math.max(pageStart, Math.min(lastAvailablePage, Number(value) || pageStart, pageStart + 4));
    setPageEnd(next);
  };
  const submit = async () => {
    if (!manualPrompt.trim() || running || !modelConfig?.configured) return;
    setRunning(true);
    setError("");
    setHistoryOpen(false);
    setPromptHistory(rememberPrompt(projectId, manualPrompt));
    try {
      await onEnsureRange?.(pageStart, pageEnd);
      const payload = await onConfirm({ manualPrompt: manualPrompt.trim(), pageStart, pageEnd });
      setCandidate(payload.revision || null);
    } catch (reason) {
      setError(reason.message || "本页修订失败");
    } finally {
      setRunning(false);
    }
  };
  const apply = async () => {
    if (!candidate?.run_id || running) return;
    setRunning(true);
    setError("");
    try {
      await onApply({ runId: candidate.run_id, candidateHash: candidate.candidate_hash });
      onClose();
    } catch (reason) {
      setError(reason.message || "候选应用失败");
    } finally {
      setRunning(false);
    }
  };
  return <div className="page-revision-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !running) onClose(); }}>
    <section className="page-revision-dialog" role="dialog" aria-modal="true" aria-labelledby="page-revision-title">
      <header>
        <div><h2 id="page-revision-title">{rangeLabel} 模型修订</h2><p>{modelConfig?.model || "当前项目模型未配置"}</p></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={running} title="关闭"><X size={17} /></button>
      </header>
      <section className="revision-range-control" aria-label="修订范围">
        <div className="revision-range-modes" role="group" aria-label="选择单页或连续多页">
          <button type="button" aria-pressed={rangeMode === "single"} disabled={running || Boolean(candidate)} onClick={() => chooseMode("single")}>当前页</button>
          <button type="button" aria-pressed={rangeMode === "range"} disabled={running || Boolean(candidate)} onClick={() => chooseMode("range")}>连续多页</button>
        </div>
        {rangeMode === "range" ? <div className="revision-range-inputs">
          <label><span>起始页</span><input type="number" min={firstAvailablePage} max={lastAvailablePage} value={pageStart} disabled={running || Boolean(candidate)} onChange={(event) => changeStart(event.target.value)} /></label>
          <span aria-hidden="true">至</span>
          <label><span>结束页</span><input type="number" min={pageStart} max={Math.min(lastAvailablePage, pageStart + 4)} value={pageEnd} disabled={running || Boolean(candidate)} onChange={(event) => changeEnd(event.target.value)} /></label>
        </div> : null}
        <p><strong>{rangeLabel}</strong><span>{pageEnd - pageStart + 1} 页 · {selectedEntries.length} 个相关条目</span>{rangeMode === "range" ? <small>单次最多 5 页，前后各一页作为只读边界证据</small> : null}</p>
      </section>
      <div className="revision-source-grid">
        <label className="revision-field revision-json-field"><span>目标范围结构 JSON</span><textarea readOnly value={pageJson} spellCheck="false" /></label>
        {ocrPages.map((source) => <label className="revision-field revision-json-field" key={source.id}><span>{source.label}</span><textarea readOnly value={source.json} spellCheck="false" /></label>)}
      </div>
      <div className="revision-field">
        <div className="revision-prompt-heading">
          <span>人工输入提示词 <b>最高优先级</b></span>
          <div className="prompt-history-control">
            <button className="icon-button" type="button" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen} aria-label="选择最近使用的提示词" title="最近提示词"><History size={16} /></button>
            {historyOpen ? <div className="prompt-history-menu" role="menu">
              <strong>最近使用</strong>
              {promptHistory.length ? promptHistory.slice(0, 10).map((record, index) => <button type="button" role="menuitem" key={`${record.used_at || "legacy"}-${index}`} onClick={() => { setManualPrompt(record.prompt); setHistoryOpen(false); requestAnimationFrame(() => promptRef.current?.focus()); }} title={record.prompt}><span>{record.prompt}</span></button>) : <p>尚无已发送的提示词</p>}
            </div> : null}
          </div>
        </div>
        <div className="revision-preset-options" role="group" aria-label="预设修订目标">
          {REVISION_PRESETS.map((preset) => <button type="button" key={preset.id} aria-pressed={manualPrompt === preset.prompt} disabled={running || Boolean(candidate)} onClick={() => { setManualPrompt(preset.prompt); requestAnimationFrame(() => promptRef.current?.focus()); }} title={preset.prompt}><strong>{preset.label}</strong><span>{preset.summary}</span></button>)}
        </div>
        <textarea ref={promptRef} autoFocus value={manualPrompt} onChange={(event) => setManualPrompt(event.target.value)} placeholder="说明本页需要重新判断或修正的内容" disabled={running || Boolean(candidate)} />
      </div>
      <p className="revision-context-note">提交时会同时发送 {rangeLabel} 双 OCR、范围外前后各一页只读证据、当前结构 JSON 和原有古籍整理提示词。</p>
      {candidate ? <label className="revision-field revision-candidate-field"><span>调用后的候选 JSON <b>批准后才写入正式结果</b></span><textarea readOnly value={JSON.stringify(candidate.candidate, null, 2)} spellCheck="false" /></label> : null}
      {candidate?.diagnostics?.length ? <section className="revision-warning-list" aria-label="候选警告">
        <header><AlertTriangle size={15} /><strong>{candidate.diagnostics.length} 条警告</strong><span>不阻止预览和批准</span></header>
        <ul>{candidate.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code || "warning"}-${index}`}><code>{diagnostic.code || "warning"}</code><span>{diagnostic.message || "候选需要人工复核"}</span></li>)}</ul>
      </section> : null}
      {error ? <div className="page-revision-error" role="alert">{error}</div> : null}
      {!modelConfig?.configured ? <div className="page-revision-error" role="alert">当前项目没有可用的模型 API 配置。</div> : null}
      <footer><button className="button" type="button" onClick={onClose} disabled={running}>{candidate ? "暂不应用" : "取消"}</button>{candidate ? <><button className="button secondary" type="button" onClick={() => setPreviewOpen(true)} disabled={running || !candidate.preview_entries?.length}><Eye size={15} />预览排版</button><button className="button primary" type="button" onClick={apply} disabled={running}>{running ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}{running ? "正在应用" : "批准并应用"}</button></> : <button className="button primary" type="button" onClick={submit} disabled={running || !manualPrompt.trim() || !modelConfig?.configured}>{running ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}{running ? "正在生成" : "发送模型"}</button>}</footer>
    </section>
    {previewOpen && candidate?.preview_entries?.length ? <RevisionPreviewDialog pageStart={pageStart} pageEnd={pageEnd} pages={selectedPages} entries={candidate.preview_entries} results={results} links={links} onClose={() => setPreviewOpen(false)} /> : null}
  </div>;
}

function EditionEntry({ entry, relatedTargets, onTargetEnter, onTargetLeave, onRevisionRequest, idPrefix = "" }) {
  const target = (field, index = null) => `${entry.id}:${index == null ? field : `${field}-${index}`}`;
  const prose = splitProse(entry.prose);
  const heading = entry.kind === "heading";
  return <article className={`edition-entry kind-${entry.kind}`} id={`${idPrefix}edition-entry-${entry.id}`} data-entry-section={entry.id}>
    <div className="entry-source-pages">{(entry.source_pages || []).map((pageNumber) => <span className="entry-page-action" key={pageNumber}><span>{pageLabel(pageNumber)}</span>{entry.kind === "poem" && onRevisionRequest ? <button type="button" onClick={() => onRevisionRequest(pageNumber)} title={`使用当前项目模型修订 ${pageLabel(pageNumber)}`}><WandSparkles size={12} /></button> : null}</span>)}</div>
    {entry.series?.title ? <div className="entry-series"><Target id={target("series")} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}><AnnotatedText text={displayedSeriesTitle(entry.series.title)} notes={entry.notes} field="series" /></Target><span>{seriesOrdinal(entry.series.index)}</span></div> : null}
    {entry.title ? (heading ? <h2><Target id={target("title")} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}><AnnotatedText text={entry.title} notes={entry.notes} field="title" /></Target></h2> : <h3><Target id={target("title")} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}><AnnotatedText text={entry.title} notes={entry.notes} field="title" /></Target></h3>) : null}
    {entry.subtitle ? <p className="entry-subtitle"><Target id={target("subtitle")} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{entry.subtitle}</Target></p> : null}
    {entry.author ? <p className="entry-author"><Target id={target("author")} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{entry.author}</Target></p> : null}
    {entry.lines?.length ? <div className="entry-lines">{poemParagraphs(entry.lines, entry.form).map((lines, index) => <p key={index}>{lines.map((item) => <Target key={item.line} id={target("line", item.line)} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}><AnnotatedText text={item.text} notes={entry.notes} field="lines" line={item.line} /></Target>)}</p>)}</div> : null}
    {prose.length ? <div className="entry-prose">{prose.map((text, index) => <Target key={index} id={target("prose", index + 1)} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{text}</Target>)}</div> : null}
    {entry.notes?.length ? <aside className="entry-notes" aria-label="注文">{entry.notes.map((note, index) => <p key={index}><span className="edition-note-number">{circledNumber(index + 1)}</span><Target id={target("note", index + 1)} idPrefix={idPrefix} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{displayedNoteText(note.text)}</Target></p>)}</aside> : null}
  </article>;
}

function EditionPane({ entries, activeEntry, relatedTargets, onEntryVisible, onTargetEnter, onTargetLeave, onRevisionRequest, idPrefix = "" }) {
  const paneRef = React.useRef(null);
  React.useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    const track = () => { const current = findCurrent(pane, "[data-entry-section]", 120); if (current) onEntryVisible(current.dataset.entrySection); };
    pane.addEventListener("scroll", track, { passive: true });
    track();
    return () => pane.removeEventListener("scroll", track);
  }, [onEntryVisible]);
  return <section className="dataset-edition-pane" ref={paneRef} aria-label="现代阅读版"><div className="pane-title"><div><span>现代阅读版</span><small>{idPrefix ? "待批准候选结果" : "已接受结构结果"}</small></div><b>{entries.find((entry) => entry.id === activeEntry)?.source_pages?.map(pageLabel).join("–") || ""}</b></div><div className="edition-paper">{entries.map((entry) => <EditionEntry key={entry.id} entry={entry} relatedTargets={relatedTargets} onTargetEnter={onTargetEnter} onTargetLeave={onTargetLeave} onRevisionRequest={onRevisionRequest} idPrefix={idPrefix} />)}</div></section>;
}

function ComparisonPanes({ pages, results, links = EMPTY_LINKS, activePage, relatedRegions = EMPTY_SET, onPageVisible = NOOP, onRegionEnter = NOOP, onRegionLeave = NOOP, onRegionClick = NOOP, entries, activeEntry, relatedTargets = EMPTY_SET, onEntryVisible = NOOP, onTargetEnter = NOOP, onTargetLeave = NOOP, onRevisionRequest = null, idPrefix = "" }) {
  return <>
    <EvidencePane pages={pages} results={results} links={links} activePage={activePage} relatedRegions={relatedRegions} onPageVisible={onPageVisible} onRegionEnter={onRegionEnter} onRegionLeave={onRegionLeave} onRegionClick={onRegionClick} idPrefix={idPrefix} />
    {entries.length ? <EditionPane entries={entries} activeEntry={activeEntry} relatedTargets={relatedTargets} onEntryVisible={onEntryVisible} onTargetEnter={onTargetEnter} onTargetLeave={onTargetLeave} onRevisionRequest={onRevisionRequest} idPrefix={idPrefix} /> : null}
  </>;
}

export default function DatasetWorkspace({ data, onPageRequest = null, onRevisePage = null, onApplyPageRevision = null, onEnsureRange = null }) {
  const allPages = React.useMemo(() => [...(data.project?.source?.pages || data.results?.[0]?.pages || [])].sort((a, b) => a.page_number - b.page_number), [data]);
  const loadedPageNumbers = React.useMemo(() => new Set((data.results?.[0]?.pages || []).map((page) => page.page_number)), [data.results]);
  const pages = React.useMemo(() => allPages.filter((page) => loadedPageNumbers.has(page.page_number)), [allPages, loadedPageNumbers]);
  const entries = React.useMemo(() => [...(data.ebook?.entries || [])].sort((a, b) => (firstPage(a) ?? Number.MAX_SAFE_INTEGER) - (firstPage(b) ?? Number.MAX_SAFE_INTEGER)), [data]);
  const [activePage, setActivePage] = React.useState(pages[0]?.page_number || 0);
  const [activeEntry, setActiveEntry] = React.useState(entries[0]?.id || "");
  const [hoveredRegion, setHoveredRegion] = React.useState("");
  const [hoveredTarget, setHoveredTarget] = React.useState("");
  const [revisionPage, setRevisionPage] = React.useState(null);
  const hasEdition = entries.length > 0;
  const relatedTargets = React.useMemo(() => new Set(hoveredRegion ? data.links.by_region?.[hoveredRegion] || [] : []), [data.links, hoveredRegion]);
  const relatedRegions = React.useMemo(() => new Set(hoveredTarget ? (data.links.by_target?.[hoveredTarget] || []).map((source) => source.region_key) : hoveredRegion ? [hoveredRegion] : []), [data.links, hoveredRegion, hoveredTarget]);

  const scrollPage = React.useCallback(async (pageNumber, alignEdition = true) => {
    setActivePage(pageNumber);
    if (!loadedPageNumbers.has(pageNumber) && onPageRequest) await onPageRequest(pageNumber);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById(`source-page-${pageNumber}`)?.scrollIntoView({ behavior: "auto", block: "start" });
    }));
    if (alignEdition) {
      const entry = entries.find((item) => item.source_pages?.includes(pageNumber));
      if (entry) { document.getElementById(`edition-entry-${entry.id}`)?.scrollIntoView({ behavior: "auto", block: "start" }); setActiveEntry(entry.id); }
    }
  }, [entries, loadedPageNumbers, onPageRequest]);
  const scrollEntry = React.useCallback((entry) => {
    document.getElementById(`edition-entry-${entry.id}`)?.scrollIntoView({ behavior: "auto", block: "start" });
    setActiveEntry(entry.id);
    if (firstPage(entry)) scrollPage(firstPage(entry), false);
  }, [scrollPage]);
  const jumpFromRegion = React.useCallback((key) => {
    const targetId = data.links.by_region?.[key]?.[0];
    if (targetId) { document.getElementById(`target-${targetId}`)?.scrollIntoView({ behavior: "auto", block: "center" }); setActiveEntry(targetId.split(":")[0]); return; }
    const pageNumber = Number(key.match(/page-(\d+)/)?.[1]);
    const entry = entries.find((item) => item.source_pages?.includes(pageNumber));
    if (entry) scrollEntry(entry);
  }, [data.links, entries, scrollEntry]);
  const pageVisible = React.useCallback((number) => {
    setActivePage(number);
    if (!onPageRequest) return;
    const loadedIndex = pages.findIndex((page) => page.page_number === number);
    const allIndex = allPages.findIndex((page) => page.page_number === number);
    if (loadedIndex >= pages.length - 2 && allIndex < allPages.length - 1) {
      onPageRequest(allPages[Math.min(allPages.length - 1, allIndex + 2)].page_number);
    } else if (loadedIndex <= 1 && allIndex > 0) {
      onPageRequest(allPages[Math.max(0, allIndex - 2)].page_number);
    }
  }, [allPages, onPageRequest, pages]);
  const entryVisible = React.useCallback((id) => setActiveEntry(id), []);
  const regionEnter = React.useCallback((key) => setHoveredRegion(key), []);
  const regionLeave = React.useCallback(() => setHoveredRegion(""), []);
  const targetEnter = React.useCallback((id) => setHoveredTarget(id), []);
  const targetLeave = React.useCallback(() => setHoveredTarget(""), []);
  const openRevision = React.useCallback(async (pageNumber) => {
    if (!loadedPageNumbers.has(pageNumber) && onPageRequest) await onPageRequest(pageNumber);
    setRevisionPage(pageNumber);
  }, [loadedPageNumbers, onPageRequest]);

  return <div className={`dataset-workspace ${hasEdition ? "has-edition" : "without-edition"}`}>
    <PageRail pages={allPages} activePage={activePage} onSelect={scrollPage} />
    <ComparisonPanes pages={pages} results={data.results || []} links={data.links} activePage={activePage} relatedRegions={relatedRegions} onPageVisible={pageVisible} onRegionEnter={regionEnter} onRegionLeave={regionLeave} onRegionClick={jumpFromRegion} entries={entries} activeEntry={activeEntry} relatedTargets={relatedTargets} onEntryVisible={entryVisible} onTargetEnter={targetEnter} onTargetLeave={targetLeave} onRevisionRequest={onRevisePage ? openRevision : null} />
    {hasEdition ? <StructureRail entries={entries} activeEntry={activeEntry} onSelect={scrollEntry} /> : null}
    {revisionPage != null && onRevisePage && onApplyPageRevision ? <PageRevisionDialog projectId={data.project?.id} pageNumber={revisionPage} pages={allPages} entries={entries} results={data.results || []} links={data.links || EMPTY_LINKS} modelConfig={data.model_config} onClose={() => setRevisionPage(null)} onConfirm={onRevisePage} onApply={onApplyPageRevision} onEnsureRange={onEnsureRange} /> : null}
  </div>;
}
