import React, { useEffect, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { cancelTask, get, jobsRun, post, waitTask } from "../../shared/api";
import SwordProgress from "../../shared/SwordProgress";
import type { AiConfig, LocalAiStatus, Task } from "../../shared/types";

type Panel = "model" | "ocr" | "files" | "local" | "remote-list" | "remote-add";

const PANEL_CRUMB: Record<Panel, string> = {
  model: "模型与 AI", ocr: "文字识别", files: "文件与输出",
  local: "模型与 AI / 本地模型", "remote-list": "模型与 AI / 远程模型", "remote-add": "模型与 AI / 远程模型",
};

/** 设置（Figma 38/39/50/51）：分类左卡 + 当前状态横幅 + 远程模型的添加/管理两个子页。 */
export default function Settings() {
  const { appInfo, toast, refreshEngines, engines } = React.useContext(AppCtx);
  const [localAi, setLocalAi] = useState<LocalAiStatus | null>(null);
  const [configs, setConfigs] = useState<AiConfig[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [prefer, setPrefer] = useState<"cloud" | "local">("cloud");
  const [effectiveId, setEffectiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", protocol: "openai", baseurl: "", model: "", key: "" });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string; ms?: number } | null>(null);
  const [pullTask, setPullTask] = useState<Task | null>(null);
  const [installTask, setInstallTask] = useState<Task | null>(null);
  const [zipUrl, setZipUrl] = useState("");
  const [ocrPack, setOcrPack] = useState<{ dir: string; tiers: Record<string, boolean>; active: string | null; source: string } | null>(null);
  const [ocrInstallTask, setOcrInstallTask] = useState<Task | null>(null);
  const [panel, setPanel] = useState<Panel>("model");
  const [protocols, setProtocols] = useState<{ id: string; name: string; hint?: string }[]>([]);

  const load = async () => {
    try {
      const [c, a, l, o] = await Promise.all([
        get<{ configs: AiConfig[]; prefer?: "cloud" | "local"; protocols?: { id: string; name: string; hint?: string }[] }>("/api/ai/configs"),
        get<{ active: string | null; effective?: string | null }>("/api/ai/active"),
        get<LocalAiStatus>("/api/ai/local"),
        get<any>("/api/ocr-pack"),
      ]);
      setConfigs(c.configs || []);
      setProtocols(c.protocols || []);
      setActive(a.active);
      setPrefer(c.prefer === "local" ? "local" : "cloud");
      setEffectiveId(a.effective || null);
      setLocalAi(l);
      setOcrPack(o);
    } catch { /* ignore */ }
  };
  useEffect(() => { load(); }, []);

  const isLocalCfg = (c: AiConfig) => {
    try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(c.baseurl).hostname.toLowerCase()); }
    catch { return false; }
  };

  const saveConfigs = async (list: AiConfig[], act?: string | null, pref?: "cloud" | "local") => {
    try {
      // active 总是显式传（可为 null）：null = 未显式启用，由通道优先级决定生效配置
      const nextActive = act === null ? null : (act ?? active ?? null);
      const r = await post("/api/ai/configs", { configs: list, active: nextActive, prefer: pref ?? prefer });
      const nextConfigs = (r.configs || []) as AiConfig[];
      setConfigs(nextConfigs);
      if (typeof r.prefer === "string") setPrefer(r.prefer === "local" ? "local" : "cloud");
      const savedActive = nextActive && nextConfigs.some((x) => x.id === nextActive) ? nextActive : null;
      setActive(savedActive);
      setEffectiveId(savedActive || nextConfigs.find((x) => isLocalCfg(x) === ((pref ?? prefer) === "local"))?.id || nextConfigs[0]?.id || null);
      refreshEngines();
    } catch (e) { toast(`保存失败：${(e as Error).message}`, true); }
  };

  const addRemote = async () => {
    if (!draft.baseurl.trim() || !draft.model.trim()) return toast("BaseURL 和模型名必填", true);
    const cfg: AiConfig = {
      id: `r-${Date.now().toString(36)}`,
      name: draft.name.trim() || draft.model.trim(),
      protocol: draft.protocol,
      baseurl: draft.baseurl.trim(),
      model: draft.model.trim(),
      key: draft.key || undefined,
    } as AiConfig;
    await saveConfigs([...configs, cfg]);
    setDraft({ name: "", protocol: "openai", baseurl: "", model: "", key: "" });
    setTestResult(null);
    setPanel("remote-list");
    toast("连接已保存；可先测试连接再设为默认模型");
  };

  const test = async (id: string) => {
    setTesting(id);
    setTestResult(null);
    try {
      const r = await post<{ ok: boolean; message: string; ms?: number }>("/api/ai/test", { configId: id });
      setTestResult({ id, ...r });
    } catch (e) {
      setTestResult({ id, ok: false, message: (e as Error).message });
    } finally { setTesting(null); }
  };

  const ensureLocal = async () => {
    try {
      const r = await post<LocalAiStatus & { error?: string }>("/api/ai/local", { ensure: true });
      setLocalAi(r);
      await load();
      toast(r.running ? `本地服务就绪，模型 ${r.default_model}` : `本地服务未就绪：${r.error || "未知"}`, !r.running);
    } catch (e) { toast((e as Error).message, true); }
  };

  const pullModel = async (model: string) => {
    setPullTask({ id: "", kind: "ai_pull", name: "下载模型", status: "running", progress: 0, outputs: [], created: 0, params: {} } as Task);
    try {
      const started = await jobsRun("ai_pull", { model });
      const done = await waitTask(started.id, { onTick: setPullTask, timeout: 3_600_000 });
      setPullTask(done);
      await load();
      toast(done.status === "done" ? `${model} 已就绪` : "下载结束", done.status !== "done");
    } catch (e) {
      setPullTask(null);
      toast(`下载失败：${(e as Error).message}`, true);
    }
  };

  /** 插件安装：confirmed=true 才会真正下载（引擎侧二次校验）。 */
  const installPlugin = async () => {
    setInstallTask({ id: "", kind: "ai_pack_install", name: "安装本地 AI 插件", status: "running", progress: 0, outputs: [], created: 0, params: {} } as Task);
    try {
      const started = await jobsRun("ai_pack_install", { confirmed: true, url: zipUrl.trim() || undefined });
      const done = await waitTask(started.id, { onTick: setInstallTask, timeout: 3_600_000 });
      setInstallTask(done);
      await load();
      toast(done.status === "done" ? "插件已安装到湛卢数据目录" : "安装未完成", done.status !== "done");
    } catch (e) {
      setInstallTask((old) => ({ ...(old || {}), status: "error", error: (e as Error).message } as Task));
    }
  };

  const uninstallPlugin = async () => {
    try {
      await post("/api/ai/local", { uninstall: true });
      await load();
      toast("插件已卸载");
    } catch (e) { toast((e as Error).message, true); }
  };

  /** OCR 模型插件：确认后按档位下载（引擎侧二次校验 confirmed）。 */
  const installOcrPack = async (tier: "standard" | "advanced") => {
    setOcrInstallTask({ id: "", kind: "ocr_pack_install", name: "安装 OCR 模型", status: "running", progress: 0, outputs: [], created: 0, params: {} } as Task);
    try {
      const started = await jobsRun("ocr_pack_install", { confirmed: true, tier });
      const done = await waitTask(started.id, { onTick: setOcrInstallTask, timeout: 3_600_000 });
      setOcrInstallTask(done.status === "done" ? null : done);
      await load();
      toast(done.status === "done" ? "OCR 模型已安装" : "安装未完成", done.status !== "done");
    } catch (e) {
      setOcrInstallTask((old) => ({ ...(old || {}), status: "error", error: (e as Error).message } as Task));
    }
  };

  const uninstallOcrPack = async () => {
    if (!confirm("删除已下载的 OCR 模型？（不影响湛卢其他功能）")) return;
    try {
      await post("/api/ocr-pack", { uninstall: true, confirmed: true });
      await load();
      toast("OCR 模型已卸载");
    } catch (e) { toast((e as Error).message, true); }
  };

  const ocrInstalled = !!(ocrPack && Object.values(ocrPack.tiers || {}).some(Boolean));
  const currentConfig = configs.find((c) => c.id === effectiveId);
  const remoteConfigs = configs.filter((c) => !isLocalCfg(c));
  const pageHead: Record<Panel, string> = {
    model: "设置", ocr: "设置", files: "设置", local: "设置",
    "remote-list": "管理远程模型", "remote-add": "添加远程模型",
  };

  return (
    <div className="settings rise">
      <p className="page-kicker">设置 / {PANEL_CRUMB[panel]}</p>
      <h1 className="page-title">{pageHead[panel]}</h1>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <h2>分类</h2>
          <button type="button" className={["model", "local", "remote-list", "remote-add"].includes(panel) ? "on" : ""} onClick={() => setPanel("model")}>
            <strong>模型与 AI</strong>
          </button>
          <button type="button" className={panel === "ocr" ? "on" : ""} onClick={() => setPanel("ocr")}>
            <strong>文字识别</strong>
          </button>
          <button type="button" className={panel === "files" ? "on" : ""} onClick={() => setPanel("files")}>
            <strong>文件与输出</strong>
          </button>
          <div className="settings-nav-divider" />
        </nav>

        <div className="settings-panel">
          {panel === "model" && <section className="settings-card">
            <h2>当前用于 AI 阅读</h2>
            <div className="settings-banner">
              <strong>{currentConfig
                ? <><i className={isLocalCfg(currentConfig) && !localAi?.running ? "dot warn" : "dot ok"} aria-hidden="true" /> {isLocalCfg(currentConfig) && !localAi?.running ? "本地模型未就绪" : "已连接"} · {isLocalCfg(currentConfig) ? "本地模型" : "远程模型"} {currentConfig.model}</>
                : <><i className="dot warn" aria-hidden="true" /> 尚未连接模型</>}</strong>
            </div>

            <span className="convert-label">默认模型</span>
            <select className="input" value={effectiveId || ""} disabled={!configs.length}
                    aria-label="默认模型"
                    onChange={(e) => void saveConfigs(configs, e.target.value)}>
              {!configs.length && <option value="">请先连接模型</option>}
              {configs.map((c) => <option key={c.id} value={c.id}>{isLocalCfg(c) ? "本地" : "远程"} · {c.model}</option>)}
            </select>
            <p className="note">只影响新打开的 AI 任务；当前任务可在输入框旁切换。</p>
            <div className="settings-divider" />

            <div className="settings-row">
              <div>
                <h3>本地模型</h3>
                <p className={"settings-state" + (localAi?.running ? " ok" : "")}>
                  {localAi?.running ? `运行中 · 已安装 ${localAi.models?.length || 0} 个模型`
                    : localAi?.installed ? "已安装 · 服务未运行" : "尚未安装"}
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setPanel("local")}>管理模型</button>
            </div>
            <div className="settings-divider" />
            <div className="settings-row">
              <div>
                <h3>远程模型</h3>
                <p className="settings-state">{remoteConfigs.length ? `已配置 ${remoteConfigs.length} 个连接` : "尚未添加远程模型。需要时再连接 API。"}</p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {remoteConfigs.length > 0 && <button type="button" className="btn" onClick={() => setPanel("remote-list")}>管理远程模型</button>}
                <button type="button" className="btn" onClick={() => setPanel("remote-add")}>＋ 添加远程模型</button>
              </div>
            </div>
            <p className="note" style={{ marginTop: 14 }}>首次向远程模型发送每份文档时，都会明确显示发送范围并要求确认。</p>
          </section>}

          {panel === "ocr" && <section className="settings-card">
            <h2>文字识别状态</h2>
            <div className="settings-banner">
              <strong>{ocrPack?.active === "advanced" ? <><i className="dot ok" aria-hidden="true" /> 高级档已安装</>
                : ocrPack?.active === "standard" || ocrInstalled ? <><i className="dot ok" aria-hidden="true" /> 标准档已安装</>
                : ocrPack?.active === "package" ? <><i className="dot ok" aria-hidden="true" /> 使用内置模型（开发环境）</>
                : <><i className="dot warn" aria-hidden="true" /> 尚未安装</>}
                {ocrInstalled ? " · 可离线使用" : ""}</strong>
              <small>只有扫描件缺少文字层时，才需要进行 OCR。</small>
            </div>

            <span className="convert-label">选择识别档位</span>
            <div className="ocr-tiers" role="radiogroup" aria-label="识别档位">
              {(["standard", "advanced"] as const).map((tier) => {
                const installed = !!ocrPack?.tiers?.[tier];
                return (
                  <div key={tier} className={"ocr-tier-card" + (ocrPack?.active === tier ? " on" : "")}>
                    <strong>{tier === "standard" ? "标准" : "高级"} · 约 {tier === "standard" ? 30 : 165} MB</strong>
                    <small>{tier === "standard" ? "常规印刷扫描件；速度较快" : "低质量扫描件；更准确但更慢"}</small>
                    <span className={"ocr-tier-state" + (installed ? " ok" : "")}>{installed ? "已安装" : "未安装"}</span>
                    {installed && ocrPack?.active !== tier && (
                      <button type="button" className="btn sm" style={{ marginTop: 8 }}
                              onClick={() => void saveConfigs(configs, active, prefer)}>启用该档</button>
                    )}
                  </div>
                );
              })}
            </div>
            {ocrInstallTask?.status === "running" ? (
              <div className="convert-running" role="status">
                <h3>{ocrInstallTask.detail || "下载模型中…"}</h3>
                <SwordProgress value={ocrInstallTask.progress || 0} unknown={ocrInstallTask.progressKnown === false} label="安装文字识别模型" />
                {ocrInstallTask.id && <button type="button" className="btn sm ghost" onClick={() => cancelTask(ocrInstallTask.id).catch(() => {})}>取消安装</button>}
              </div>
            ) : (
              <>
                <div className="settings-divider" />
                <h3>按需处理</h3>
                <p className="note">在 AI 侧栏或查找引导中选择「识别」，先检测文字层，再生成可搜索副本。原图和原 PDF 保留。</p>
                <div className="settings-banner plain">
                  <small>安装前会显示下载大小与来源（{ocrPack?.source || "modelscope.cn"}）；只有确认后才开始下载。删除模型目录即卸载。</small>
                </div>
                {ocrInstallTask?.status === "error" && <p className="wf-error">安装失败：{ocrInstallTask.error}</p>}
                <div className="settings-row" style={{ marginTop: 12 }}>
                  <span />
                  <div style={{ display: "flex", gap: 8 }}>
                    {ocrInstalled && <button type="button" className="btn ghost" onClick={uninstallOcrPack}>卸载模型</button>}
                    <button type="button" className="btn" disabled={!!ocrPack?.tiers?.advanced}
                            onClick={() => installOcrPack("advanced")}>
                      {ocrPack?.tiers?.advanced ? "高级档已安装" : "安装高级档"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>}

          {panel === "files" && <section className="settings-card">
            <h2>文件与输出</h2>
            <p className="note">阅读、页面整理、拆分、合并和格式转换都在本机完成，不需要额外安装。</p>
            {engines && <p className="note">渲染引擎 {engines.libs?.render ? "就绪" : "缺失"} · 表格 {engines.libs?.tables ? "就绪" : "缺失"}</p>}
            <div className="settings-banner plain">
              <small>输出目录：{appInfo?.out_dir || "本机数据目录"}；生成文件始终先核对再另存，不静默覆盖。</small>
            </div>
          </section>}

          {panel === "local" && <section className="settings-card">
            <button type="button" className="btn sm ghost settings-back" onClick={() => setPanel("model")}>← 模型与 AI</button>
            <h2>本地运行时</h2>
            <p className="note">只在你确认后安装到湛卢数据目录，不写系统、不开机自启。不安装时，阅读和转换仍然可用。</p>
            <div className="settings-banner">
              <strong>{localAi?.running ? <><i className="dot ok" aria-hidden="true" /> 服务运行中</> : <><i className="dot warn" aria-hidden="true" /> 服务未运行</>}
                {" · "}{localAi?.plugin?.installed ? "插件版（湛卢数据目录）" : localAi?.installed ? "检测到本机已有 Ollama" : "插件未安装"}</strong>
              <small>{localAi?.models?.length ? `模型：${localAi.models.map((m) => m.name).join("、")}` : localAi?.plugin?.dir || "尚无模型"}</small>
            </div>
            {pullTask?.status === "running" && (
              <div className="convert-running" role="status">
                <h3>{pullTask.detail || "下载中…"}</h3>
                <SwordProgress value={pullTask.progress || 0} unknown={pullTask.progressKnown === false} label="下载本地模型" />
                {pullTask.id && <button type="button" className="btn sm ghost" onClick={() => cancelTask(pullTask.id).catch(() => {})}>取消</button>}
              </div>
            )}
            {localAi?.installed && !localAi.models?.length && pullTask?.status !== "running" && (
              <div className="pack-install">
                <p>还没有模型。推荐 <code>{localAi.recommended}</code>（中文能力与体量的折中，约 2 GB，一次下载后离线可用）。</p>
                <button type="button" className="btn primary" onClick={() => pullModel(localAi.recommended)}>下载推荐模型</button>
              </div>
            )}
            {installTask?.status === "running" ? (
              <div className="convert-running" role="status">
                <h3>{installTask.detail || "安装中…"}</h3>
                <SwordProgress value={installTask.progress || 0} unknown={installTask.progressKnown === false} label="安装本地运行时" />
                {installTask.id && <button type="button" className="btn sm ghost" onClick={() => cancelTask(installTask.id).catch(() => {})}>取消安装</button>}
              </div>
            ) : !localAi?.installed && (
              <div className="pack-install">
                <p className="note">约 {localAi?.plugin?.approx_mb || 1100} MB。只在你确认后下载，装到湛卢数据目录。</p>
                <ul className="privacy-list">
                  <li>下载来源：<code>{zipUrl || localAi?.plugin?.zip_url}</code>（可改镜像地址）</li>
                  <li>安装位置：湛卢数据目录 <code>plugins/ollama</code>，绿色便携，不写注册表、不开机自启</li>
                  <li>安装运行时不下载模型；模型需再次确认后才会下载（约 2 GB）</li>
                </ul>
                <label className="field">镜像地址（可选）
                  <input className="input" value={zipUrl} onChange={(e) => setZipUrl(e.target.value)} placeholder={localAi?.plugin?.zip_url} />
                </label>
                <button type="button" className="btn primary" onClick={() => installPlugin()}>我已了解，开始安装</button>
              </div>
            )}
            {installTask?.status === "error" && <p className="wf-error">安装失败：{installTask.error}</p>}
            <div className="settings-row" style={{ marginTop: 12 }}>
              <span />
              <div style={{ display: "flex", gap: 8 }}>
                {localAi?.installed && <button type="button" className="btn" onClick={ensureLocal} disabled={localAi.running}>
                  {localAi.running ? "刷新状态" : "启动本地服务"}</button>}
                {localAi?.plugin?.installed && (
                  <button type="button" className="btn ghost"
                          onClick={() => { if (confirm("删除湛卢数据目录中的本地 AI 插件？（不影响你系统里自行安装的 Ollama）")) uninstallPlugin(); }}>
                    卸载插件
                  </button>
                )}
              </div>
            </div>
          </section>}

          {panel === "remote-list" && <section className="settings-card">
            <button type="button" className="settings-back-link" onClick={() => setPanel("model")}>← 模型与 AI</button>
            <h2>已保存的连接</h2>
            <p className="settings-card-sub">先测试是否可用，再决定是否设为默认模型。</p>

            {remoteConfigs.length === 0 ? (
              <div className="settings-banner">
                <strong>还没有保存的远程连接</strong>
                <small>填写你自己的连接信息即可添加；保存配置不会发送文档内容。</small>
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn" onClick={() => setPanel("remote-add")}>＋ 添加远程模型</button>
                </div>
              </div>
            ) : (
              <div className="cfg-list">
                {remoteConfigs.map((c) => {
                  let host = c.baseurl;
                  try { host = new URL(c.baseurl).host; } catch { /* 原样显示 */ }
                  const protoName = protocols.find((p) => p.id === c.protocol)?.name || (c.protocol === "openai" ? "OpenAI 兼容" : c.protocol);
                  return (
                    <div key={c.id} className="remote-conn">
                      <div className="remote-conn-copy">
                        <strong>{c.name}</strong>
                        <span className="remote-conn-state">已保存 · 尚未发送文档</span>
                        <small>{protoName} · {c.model} · {host}</small>
                        <small>密钥：{c.has_key ? `已保存（${c.key_masked || "已加密"}）` : "未设置"}</small>
                      </div>
                      <div className="cfg-actions">
                        <button type="button" className="btn" disabled={testing === c.id} onClick={() => test(c.id)}>
                          {testing === c.id ? "测试中…" : "测试连接"}
                        </button>
                        <button type="button" className="btn ghost"
                                onClick={() => { setTestResult(null); void saveConfigs(configs.filter((x) => x.id !== c.id), active === c.id ? null : active); }}>
                          移除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {testResult && (
              <div className={"settings-banner " + (testResult.ok ? "test-ok" : "test-bad")} role="status">
                <strong><i className={testResult.ok ? "dot ok" : "dot warn"} aria-hidden="true" /> {testResult.ok ? "连接检测通过" : "连接检测未通过"}</strong>
                <small>{testResult.ok
                  ? `仅验证服务和模型，没有发送 PDF 内容。${testResult.ms ? `（${testResult.ms} ms）` : ""}`
                  : testResult.message}</small>
              </div>
            )}

            <div className="settings-divider" />
            <div className="settings-row">
              <div>
                <h3>用于 AI 阅读</h3>
                <p className="settings-state">当前文档可临时选择其他模型；这项设置只影响新打开的 AI 会话。</p>
              </div>
              <select className="input" style={{ width: 240 }} value={effectiveId || ""} disabled={!configs.length}
                      aria-label="设为默认模型"
                      onChange={(e) => void saveConfigs(configs, e.target.value)}>
                {!configs.length && <option value="">请先连接模型</option>}
                {configs.map((c) => <option key={c.id} value={c.id}>{isLocalCfg(c) ? "本地" : "远程"} · {c.name || c.model}</option>)}
              </select>
            </div>

            <div className="settings-banner confirm-note">
              <strong>发送文档前仍需确认</strong>
              <small>每份 PDF 首次使用该远程连接时，显示目标服务和本次文字范围；未经确认不发送。</small>
            </div>
          </section>}

          {panel === "remote-add" && <section className="settings-card">
            <button type="button" className="settings-back-link" onClick={() => setPanel(remoteConfigs.length ? "remote-list" : "model")}>← 模型与 AI</button>
            <h2>连接到远程模型</h2>
            <p className="settings-card-sub">连接名称便于识别；协议、服务地址、模型 ID 和密钥用于连接。</p>

            <div className="settings-banner">
              <small>先保存连接，再测试是否可用。此处不会上传当前 PDF。</small>
            </div>

            <div className="cfg-form">
              <label>连接名称<input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：工作用模型" /></label>
              <label>协议
                <select className="input" value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value })}>
                  {(protocols.length ? protocols : [{ id: "openai", name: "OpenAI · Chat Completions" }, { id: "openai-responses", name: "OpenAI · Responses" }, { id: "anthropic", name: "Anthropic" }])
                    .filter((p) => p.id !== "ollama")
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              </label>
              <label style={{ gridColumn: "1 / -1" }}>服务地址 Base URL<input className="input" value={draft.baseurl} onChange={(e) => setDraft({ ...draft, baseurl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
              <label>模型 ID<input className="input" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="例如：model-id" /></label>
              <label>API 密钥<input className="input" type="password" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder="粘贴密钥（输入时隐藏）" /></label>
            </div>
            {protocols.find((p) => p.id === draft.protocol)?.hint && (
              <p className="note">{protocols.find((p) => p.id === draft.protocol)!.hint}</p>
            )}
            <p className="note">密钥在本机加密保存。保存与连接检测不会发送 PDF 内容。</p>
            <div className="cfg-actions-row">
              <button type="button" className="btn" onClick={() => setPanel(remoteConfigs.length ? "remote-list" : "model")}>取消</button>
              <button type="button" className="btn copper" onClick={addRemote}>保存配置</button>
            </div>
          </section>}
        </div>
      </div>
      <p className="settings-foot">文件留在本机。远程模型仅在保存之后、并且每份文档首次发送前确认。湛卢 {appInfo?.version || "0.1.0"}</p>
    </div>
  );
}
