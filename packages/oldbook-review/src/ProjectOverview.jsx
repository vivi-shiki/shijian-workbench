import React from "react";

async function jsonRequest(url, body) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `请求失败：${response.status}`);
  return payload;
}

export default function ProjectOverview({ projectId, pageRange, resultIds, modelConfigured }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [estimate, setEstimate] = React.useState(null);
  const [startPage, setStartPage] = React.useState(pageRange?.start || 1);
  const [endPage, setEndPage] = React.useState(Math.min(pageRange?.end || 1, (pageRange?.start || 1) + 4));
  const [budget, setBudget] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let active = true;
    const refresh = () => jsonRequest(`/api/projects/${projectId}/overview`)
      .then(data => { if (active) setSnapshot(data); })
      .catch(reason => { if (active) setError(reason.message); });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId]);
  async function act(callback) {
    setBusy(true); setError("");
    try {
      await callback();
      setSnapshot(await jsonRequest(`/api/projects/${projectId}/overview`));
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  const preview = () => act(async () => setEstimate(await jsonRequest(`/api/projects/${projectId}/jobs/estimate`, {
    start_page: Number(startPage), end_page: Number(endPage), budget: budget === "" ? null : Number(budget)
  })));
  const launch = () => act(async () => {
    await jsonRequest(`/api/projects/${projectId}/jobs`, { type: "structure", start_page: Number(startPage),
      end_page: Number(endPage), result_ids: resultIds.slice(0, 2), budget: budget === "" ? null : Number(budget),
      confirm_cost: true });
    setEstimate(null);
  });
  const command = (job, action) => act(async () => { await jsonRequest(`/api/projects/${projectId}/jobs/${job.id}/${action}`, {}); });
  const backup = () => act(async () => {
    const outputFile = await window.oldbookDesktop?.chooseBackupOutput?.(`${projectId}.shijian`);
    if (window.oldbookDesktop && !outputFile) return;
    const created = await jsonRequest(`/api/projects/${projectId}/backup`, outputFile ? { output_file: outputFile } : {});
    setEstimate({ backup_message: `已保存备份：${created.output_file}` });
  });
  const overview = snapshot?.overview;
  return <details className="project-overview">
    <summary>项目进度：{overview ? `${overview.pending_ocr_pages} 页待识别 · ${overview.pending_regions} 处待校 · ${overview.pending_poems} 首待确认 · ${overview.failed_jobs} 个失败任务` : "正在统计"}</summary>
    {overview ? <div className="overview-body">
      <p>共 {overview.total_pages} 页。下一步：{overview.next_action.kind === "ocr" ? `处理第 ${overview.next_action.page} 页 OCR` : overview.next_action.kind === "review_region" ? "校对书页文字" : overview.next_action.kind === "review_poem" ? "确认作品修订" : "当前项目已完成"}。</p>
      <div><button type="button" disabled={busy} onClick={backup}>备份项目</button>{estimate?.backup_message ? <span role="status">{estimate.backup_message}</span> : null}</div>
      {overview.last_failure ? <p role="alert">上次失败：{overview.last_failure.error?.message || "任务中断"}（{overview.last_failure.id}）</p> : null}
      <fieldset><legend>批量结构生成</legend><label>起页 <input type="number" min={pageRange?.start || 1} max={pageRange?.end || 1} value={startPage} onChange={event => { setStartPage(event.target.value); setEstimate(null); }} /></label>
        <label>止页 <input type="number" min={startPage} max={pageRange?.end || 1} value={endPage} onChange={event => { setEndPage(event.target.value); setEstimate(null); }} /></label>
        <label>预算上限（美元，可选） <input type="number" min="0" step="0.01" value={budget} onChange={event => { setBudget(event.target.value); setEstimate(null); }} /></label>
        <button type="button" disabled={busy || !modelConfigured || !resultIds.length} onClick={preview}>查看时间与费用提示</button>
        {estimate?.estimate ? <div className="overview-estimate"><span>处理 {estimate.page_range.end - estimate.page_range.start + 1} 页；预计耗时因模型速度而异。{estimate.estimate.known ? `费用约 $${estimate.estimate.estimated_cost}` : "当前没有可靠单价，费用未知。"} {estimate.warning}</span>
          <button type="button" disabled={busy || estimate.estimate.over_budget} onClick={launch}>确认并开始</button></div> : null}
      </fieldset>
      {!modelConfigured ? <p>配置模型后可启动批量结构任务。</p> : null}
      {(snapshot.jobs || []).slice(0, 8).map(job => <div className="overview-job" key={job.id}><span>{job.type} · {job.status} · {job.progress?.completed || 0}/{job.progress?.total || "?"}</span>
        {job.error ? <small>{job.error.message}</small> : null}
        {job.checkpoint?.runs?.length ? <a href={`/editor.html?project=${encodeURIComponent(projectId)}`}>查看候选记录</a> : null}
        {job.status === "running" ? <><button type="button" disabled={busy} onClick={() => command(job, "pause")}>暂停</button><button type="button" disabled={busy} onClick={() => command(job, "cancel")}>取消</button></> : null}
        {["paused", "failed"].includes(job.status) ? <><button type="button" disabled={busy} onClick={() => command(job, "resume")}>续跑</button><button type="button" disabled={busy} onClick={() => command(job, "cancel")}>取消</button></> : null}</div>)}
    </div> : null}
    {error ? <p className="overview-error" role="alert">{error}</p> : null}
  </details>;
}
