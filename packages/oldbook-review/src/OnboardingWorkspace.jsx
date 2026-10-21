import React from "react";
import { ArrowDown, ArrowUp, BookOpen, FilePlus2, FolderOpen, LoaderCircle } from "lucide-react";

async function postJson(url, body = {}) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `操作失败：${response.status}`);
  return payload;
}

export default function OnboardingWorkspace({ onCreated, onClose }) {
  const [title, setTitle] = React.useState("");
  const [sources, setSources] = React.useState([]);
  const [plan, setPlan] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("https://api.siliconflow.cn/v1");
  const [apiKey, setApiKey] = React.useState("");
  const [modelStatus, setModelStatus] = React.useState("");

  async function selectSources() {
    setError("");
    if (!window.oldbookDesktop?.chooseSources) {
      setError("请在诗笺桌面版中使用本机文件选择器。");
      return;
    }
    const selected = await window.oldbookDesktop.chooseSources();
    if (!selected?.length) return;
    setSources(selected);
    setPlan(null);
    if (!title) setTitle(selected[0].path.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""));
  }

  function move(index, step) {
    const next = [...sources];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setSources(next);
    setPlan(null);
  }

  async function execute(operation) {
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (reason) { setError(reason.message || "操作失败"); }
    finally { setBusy(false); }
  }

  const preview = () => execute(async () => setPlan(await postJson("/api/onboarding/preview", { sources })));
  const create = () => execute(async () => {
    const created = await postJson("/api/onboarding/create", { title: title.trim(), sources });
    onCreated(created.id);
  });
  const sample = () => execute(async () => {
    const created = await postJson("/api/onboarding/sample");
    onCreated(created.id);
  });
  const restore = () => execute(async () => {
    if (!window.oldbookDesktop?.chooseBackupFile) throw new Error("请在桌面版中选择备份包。 ");
    const backupFile = await window.oldbookDesktop.chooseBackupFile();
    if (!backupFile) return;
    const verified = await postJson("/api/backups/verify", { backup_file: backupFile });
    if (!verified.ok) throw new Error(`备份包校验失败：${verified.error}`);
    const restored = await postJson("/api/backups/restore", { backup_file: backupFile });
    onCreated(restored.project_id);
  });
  const checkModel = () => execute(async () => {
    const result = window.oldbookDesktop?.saveModelSettings
      ? await window.oldbookDesktop.saveModelSettings({ baseUrl, apiKey })
      : await postJson("/api/onboarding/model-check", { baseUrl, apiKey });
    setModelStatus(result.ok ? window.oldbookDesktop?.saveModelSettings ? "连接成功，设置已保存" : "连接成功；请在桌面版保存设置" : result.reason === "invalid_credentials"
      ? "密钥无效" : "无法连接模型服务，请检查网络和地址");
    if (result.ok) setApiKey("");
  });

  return <main className="onboarding-page">
    <header><BookOpen size={24} /><div><h1>诗笺</h1><p>从书页到可校订的电子文本</p></div>{onClose ? <button type="button" onClick={onClose}>返回项目</button> : null}</header>
    <section className="onboarding-card">
      <h2>新建项目</h2><p>选择 PDF 或图片，按原书卷次排序。导入前会先显示页数和空间估算。</p>
      <label>书名<input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：疑雨集注" disabled={busy} /></label>
      <button type="button" onClick={selectSources} disabled={busy}><FolderOpen size={16} />选择 PDF 或图片</button>
      {sources.length ? <ol className="onboarding-sources">{sources.map((source, index) => <li key={`${source.path}-${index}`}>
        <span>{source.path.split(/[\\/]/).pop()}</span><small>{source.kind === "pdf" ? "PDF" : "图片"}</small>
        <button type="button" onClick={() => move(index, -1)} disabled={busy || index === 0} aria-label="上移"><ArrowUp size={14} /></button>
        <button type="button" onClick={() => move(index, 1)} disabled={busy || index === sources.length - 1} aria-label="下移"><ArrowDown size={14} /></button>
      </li>)}</ol> : null}
      {plan ? <p className="onboarding-plan">共 {plan.page_count} 页 · 输入文件 {Math.ceil(plan.input_bytes / 1048576)} MB · 预计至少需要 {Math.ceil(plan.required_bytes / 1048576)} MB 空间 · {plan.estimated_seconds == null ? "处理时间暂无法估计" : `预计 ${Math.ceil(plan.estimated_seconds / 60)} 分钟`}</p> : null}
      <div className="onboarding-actions"><button type="button" onClick={preview} disabled={!sources.length || busy}>查看导入预览</button>
        <button type="button" onClick={create} disabled={!plan || !title.trim() || busy}><FilePlus2 size={16} />创建项目</button></div>
    </section>
    <section className="onboarding-card"><h2>先试试看</h2><p>使用一页示例书页，无须配置模型。</p>
      <button type="button" onClick={sample} disabled={busy}>打开示例项目</button></section>
    <section className="onboarding-card"><h2>恢复已有项目</h2><p>选择 .shijian 备份包，先校验后恢复书影、修订历史与冻结数据。</p>
      <button type="button" onClick={restore} disabled={busy}>选择备份包并恢复</button></section>
    <section className="onboarding-card"><h2>模型设置</h2><p>只在需要 AI 识别或修订时配置。</p>
      <label>服务地址<input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} disabled={busy} /></label>
      <label>API 密钥<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={busy} autoComplete="off" /></label>
      <button type="button" onClick={checkModel} disabled={!apiKey || busy}>测试连接并保存</button>
      {modelStatus ? <p role="status">{modelStatus}</p> : null}</section>
    {busy ? <p className="onboarding-busy"><LoaderCircle className="spin" size={16} />处理中，请稍候…</p> : null}
    {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
  </main>;
}
