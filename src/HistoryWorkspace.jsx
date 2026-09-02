import React from "react";
import { Bot, Braces, History, RefreshCw, UserRound, WandSparkles } from "lucide-react";

const ACTOR_LABELS = {
  human: "人工",
  "ai:codex": "Codex",
  "ai:siliconflow": "DeepSeek",
  "ai:ocr": "OCR 模型",
  system: "系统",
  external: "外部修改"
};

const OPERATION_LABELS = {
  baseline: "建立基线",
  edit_ocr: "校对 OCR",
  edit_ebook: "编辑结构 JSON",
  external_edit: "直接修改 JSON",
  ai_chunk: "AI 分批整理",
  run_started: "AI 运行开始",
  run_completed: "AI 运行完成",
  run_failed: "AI 运行失败",
  legacy_reconstruction: "由旧快照重建",
  import_result: "导入 OCR 结果",
  import_page: "导入 OCR 页面"
};

function actorLabel(actor) {
  return ACTOR_LABELS[actor?.id] || actor?.label || actor?.id || "未知";
}

function actorIcon(actor) {
  if (actor?.id === "human") return <UserRound size={16} />;
  if (actor?.type === "ai") return <Bot size={16} />;
  return <Braces size={16} />;
}

function dateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).format(new Date(value));
}

function shortValue(value) {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function targetLabel(target) {
  if (target?.kind === "ebook") return "电子书结构";
  if (target?.kind === "result") return `OCR · ${target.result_id}`;
  return "项目元数据";
}

export default function HistoryWorkspace({ project }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${project.id}/history?limit=120`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取修改记录");
      setData(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  React.useEffect(() => { load(); }, [load]);

  if (loading && !data) return <main className="history-loading"><History size={20} />正在汇总修改记录...</main>;
  const overview = data?.overview;
  const patterns = overview?.patterns?.filter(item => item.count >= 2).slice(0, 12) || [];
  const cases = overview?.cases?.slice(0, 12) || [];

  return (
    <main className="history-workspace">
      <header className="history-toolbar">
        <div><History size={18} /><span>可追溯记录</span><strong>{data?.total || 0}</strong></div>
        <p>事件流水保留事实；右侧经验摘要由流水自动生成，供 Codex 与目标模型参考。</p>
        <button className="icon-button" onClick={load} disabled={loading} title="刷新修改记录">
          <RefreshCw className={loading ? "spin" : ""} size={16} />
        </button>
      </header>
      {error && <div className="history-error">{error}</div>}

      <section className="history-summary" aria-label="修改统计">
        <div><span>记录</span><strong>{overview?.totals?.events || 0}</strong></div>
        <div><span>字段变化</span><strong>{overview?.totals?.changes || 0}</strong></div>
        <div><span>文本变化</span><strong>{overview?.totals?.text_changes || 0}</strong></div>
        <div><span>人工记录</span><strong>{overview?.by_actor?.human || 0}</strong></div>
        <div><span>Codex 记录</span><strong>{overview?.by_actor?.["ai:codex"] || 0}</strong></div>
        <div><span>DeepSeek 记录</span><strong>{overview?.by_actor?.["ai:siliconflow"] || 0}</strong></div>
      </section>

      <section className="history-feed" aria-label="事件流水">
        <header><h2>事件流水</h2><span>最近 {data?.events?.length || 0} 条</span></header>
        <div className="history-event-list">
          {(data?.events || []).map(event => (
            <article className="history-event" key={event.id}>
              <header>
                <span className={`history-actor actor-${event.actor?.type}`}>{actorIcon(event.actor)}{actorLabel(event.actor)}</span>
                <strong>{OPERATION_LABELS[event.operation] || event.operation}</strong>
                <time>{dateTime(event.timestamp)}</time>
              </header>
              <p>{targetLabel(event.target)} · {event.source} · {event.summary.operations} 项变化</p>
              {event.note && <blockquote>{event.note}</blockquote>}
              {event.changes?.slice(0, 4).map((change, index) => (
                <div className="history-change" key={`${event.id}-${index}`}>
                  <code>{change.page_id || change.entry_id || change.region_id || change.path} / {change.field}</code>
                  <span>{shortValue(change.before)}</span><b>→</b><span>{shortValue(change.after)}</span>
                </div>
              ))}
              {event.summary.operations > 4 && <small>另有 {event.summary.operations - 4} 项，完整内容保存在 events.jsonl</small>}
              {event.run_id && <small>运行档案：{event.run_id}</small>}
            </article>
          ))}
          {!data?.events?.length && <p className="history-empty">尚无修改记录。</p>}
        </div>
      </section>

      <aside className="history-memory" aria-label="AI 经验摘要">
        <header><WandSparkles size={17} /><h2>AI 经验摘要</h2></header>
        <p className="memory-rule">原图和人工校订优先。历史模式只提示可能的惯例，不作为自动替字依据。</p>
        <h3>重复改法</h3>
        <div className="pattern-list">
          {patterns.map(item => <div key={`${item.from}-${item.to}`}><code>{item.from || "∅"}</code><b>→</b><code>{item.to || "∅"}</code><span>{item.count} 次</span></div>)}
          {!patterns.length && <p>暂无重复两次以上的模式。</p>}
        </div>
        <h3>简略案例</h3>
        <div className="memory-case-list">
          {cases.map((item, index) => (
            <article key={`${item.event_id}-${index}`}>
              <small>{actorLabel({ id: item.actor })} · {item.page_id || item.entry_id || item.path}</small>
              <p>{item.before || "∅"}<b>→</b>{item.after || "∅"}</p>
            </article>
          ))}
          {!cases.length && <p>有文本校订后会自动出现案例。</p>}
        </div>
      </aside>
    </main>
  );
}
