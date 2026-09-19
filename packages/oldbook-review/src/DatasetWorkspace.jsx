import React from "react";
import { FileText, Image as ImageIcon, Link2 } from "lucide-react";
import { displayedNoteText, displayedSeriesTitle, poemParagraphs, seriesOrdinal } from "./ebook-format.js";

const SOURCE_LABELS = { "paddleocr-vl": "PaddleOCR-VL", "pp-ocrv6": "PP-OCRv6" };
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

function EvidencePane({ pages, results, links, activePage, relatedRegions, onPageVisible, onRegionEnter, onRegionLeave, onRegionClick }) {
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
    {pages.map((page) => <article className="evidence-page" id={`source-page-${page.page_number}`} data-page-section={page.page_number} key={page.id}>
      <div className="evidence-page-heading"><h2>{pageLabel(page.page_number)}</h2><span>卷 {page.volume} · 原第 {page.source_page} 页</span></div>
      <div className="evidence-page-grid"><PageImage result={results[0]} page={page} priority={page.page_number === activePage} relatedRegions={relatedRegions} onRegionEnter={onRegionEnter} onRegionLeave={onRegionLeave} onRegionClick={onRegionClick} /><div className="ocr-source-columns">{results.map((result) => <OcrSource key={result.id} result={result} pageNumber={page.page_number} links={links} relatedRegions={relatedRegions} onRegionEnter={onRegionEnter} onRegionLeave={onRegionLeave} onRegionClick={onRegionClick} />)}</div></div>
    </article>)}
  </section>;
}

function Target({ id, className = "", relatedTargets, onEnter, onLeave, children }) {
  return <span id={`target-${id}`} className={`edition-target ${className} ${relatedTargets.has(id) ? "is-related" : ""}`} onMouseEnter={() => onEnter(id)} onMouseLeave={onLeave}>{children}</span>;
}

function EditionEntry({ entry, relatedTargets, onTargetEnter, onTargetLeave }) {
  const target = (field, index = null) => `${entry.id}:${index == null ? field : `${field}-${index}`}`;
  const prose = splitProse(entry.prose);
  const heading = entry.kind === "heading";
  return <article className={`edition-entry kind-${entry.kind}`} id={`edition-entry-${entry.id}`} data-entry-section={entry.id}>
    <div className="entry-source-pages">{(entry.source_pages || []).map(pageLabel).join(" · ")}</div>
    {entry.series?.title ? <div className="entry-series"><Target id={target("series")} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{displayedSeriesTitle(entry.series.title)}</Target><span>{seriesOrdinal(entry.series.index)}</span></div> : null}
    {entry.title ? (heading ? <h2><Target id={target("title")} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{entry.title}</Target></h2> : <h3><Target id={target("title")} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{entry.title}</Target></h3>) : null}
    {entry.subtitle ? <p className="entry-subtitle"><Target id={target("subtitle")} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{entry.subtitle}</Target></p> : null}
    {entry.author ? <p className="entry-author"><Target id={target("author")} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{entry.author}</Target></p> : null}
    {entry.lines?.length ? <div className="entry-lines">{poemParagraphs(entry.lines, entry.form).map((lines, index) => <p key={index}>{lines.map((item) => <Target key={item.line} id={target("line", item.line)} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{item.text}</Target>)}</p>)}</div> : null}
    {prose.length ? <div className="entry-prose">{prose.map((text, index) => <Target key={index} id={target("prose", index + 1)} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{text}</Target>)}</div> : null}
    {entry.notes?.length ? <ol className="entry-notes">{entry.notes.map((note, index) => <li key={index}><Target id={target("note", index + 1)} relatedTargets={relatedTargets} onEnter={onTargetEnter} onLeave={onTargetLeave}>{displayedNoteText(note.text)}</Target></li>)}</ol> : null}
  </article>;
}

function EditionPane({ entries, activeEntry, relatedTargets, onEntryVisible, onTargetEnter, onTargetLeave }) {
  const paneRef = React.useRef(null);
  React.useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    const track = () => { const current = findCurrent(pane, "[data-entry-section]", 120); if (current) onEntryVisible(current.dataset.entrySection); };
    pane.addEventListener("scroll", track, { passive: true });
    track();
    return () => pane.removeEventListener("scroll", track);
  }, [onEntryVisible]);
  return <section className="dataset-edition-pane" ref={paneRef} aria-label="现代阅读版"><div className="pane-title"><div><span>现代阅读版</span><small>已接受结构结果</small></div><b>{entries.find((entry) => entry.id === activeEntry)?.source_pages?.map(pageLabel).join("–") || ""}</b></div><div className="edition-paper">{entries.map((entry) => <EditionEntry key={entry.id} entry={entry} relatedTargets={relatedTargets} onTargetEnter={onTargetEnter} onTargetLeave={onTargetLeave} />)}</div></section>;
}

export default function DatasetWorkspace({ data, onPageRequest = null }) {
  const allPages = React.useMemo(() => [...(data.project?.source?.pages || data.results?.[0]?.pages || [])].sort((a, b) => a.page_number - b.page_number), [data]);
  const loadedPageNumbers = React.useMemo(() => new Set((data.results?.[0]?.pages || []).map((page) => page.page_number)), [data.results]);
  const pages = React.useMemo(() => allPages.filter((page) => loadedPageNumbers.has(page.page_number)), [allPages, loadedPageNumbers]);
  const entries = React.useMemo(() => [...(data.ebook?.entries || [])].sort((a, b) => (firstPage(a) ?? Number.MAX_SAFE_INTEGER) - (firstPage(b) ?? Number.MAX_SAFE_INTEGER)), [data]);
  const [activePage, setActivePage] = React.useState(pages[0]?.page_number || 0);
  const [activeEntry, setActiveEntry] = React.useState(entries[0]?.id || "");
  const [hoveredRegion, setHoveredRegion] = React.useState("");
  const [hoveredTarget, setHoveredTarget] = React.useState("");
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

  return <div className={`dataset-workspace ${hasEdition ? "has-edition" : "without-edition"}`}>
    <PageRail pages={allPages} activePage={activePage} onSelect={scrollPage} />
    <EvidencePane pages={pages} results={data.results || []} links={data.links} activePage={activePage} relatedRegions={relatedRegions} onPageVisible={pageVisible} onRegionEnter={regionEnter} onRegionLeave={regionLeave} onRegionClick={jumpFromRegion} />
    {hasEdition ? <EditionPane entries={entries} activeEntry={activeEntry} relatedTargets={relatedTargets} onEntryVisible={entryVisible} onTargetEnter={targetEnter} onTargetLeave={targetLeave} /> : null}
    {hasEdition ? <StructureRail entries={entries} activeEntry={activeEntry} onSelect={scrollEntry} /> : null}
  </div>;
}
