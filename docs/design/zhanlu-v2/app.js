const $ = (selector) => document.querySelector(selector);
const query = new URLSearchParams(location.search);
const themes = new Set(["jade", "blue", "zhanlu", "dark"]);
const requestedTheme = query.get("theme") === "clay" ? "zhanlu" : query.get("theme");
document.documentElement.dataset.theme = themes.has(requestedTheme) ? requestedTheme : "zhanlu";
const state = { mode: "read", nav: "pages", panel: null, page: 3, zoom: 100, name: "产品评审纪要.pdf", home: false };
const splitState = { method: "boundary", boundary: 3, every: 4, ranges: "1-5,6-12,13-24" };
let mergeFiles = [];
const modes = {
  read: [["选择", "⌖"], ["手型", "✋"], ["适应宽度", "↔"], ["单页 / 双页", "▯"], ["打印", "▣"]],
  pages: [["拆分", "⇢"], ["合并", "⇄"], ["重排", "▦"], ["删除", "×"], ["旋转", "↻"]],
  convert: [["转图片", "▧"], ["提取文本", "T"], ["转 Word", "W"], ["图片转 PDF", "▯"]],
  ai: [["文档摘要", "✦"], ["问答", "?"], ["解释选区", "文"], ["翻译", "↔"], ["OCR 识别", "▤"]],
};
const more = [
  ["阅读", "目录", "查找", "旋转视图", "文档属性"],
  ["页面", "拆成单页", "按某页分割", "自定义范围"],
  ["转换", "转 PNG", "转 JPEG", "图片转 PDF"],
  ["AI", "本地 OCR", "来源页"],
];
let toastTimer;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}
function renderMode() {
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  const items = modes[state.mode];
  const split = state.mode === "read" ? 2 : state.mode === "convert" ? 5 : 3;
  const groups = [items.slice(0, split), items.slice(split)];
  $("#toolrowContent").innerHTML = groups.map((group) => `<div class="tool-group">${group.map(([name, icon]) => `<button class="tool-btn" data-tool="${name}" title="${name}"><span class="tool-icon">${icon}</span><span>${name}</span></button>`).join("")}</div>`).join("");
  if (state.mode === "ai") openPanel("ai");
  else if (state.panel === "ai") closePanel();
}
function renderNav() {
  document.querySelectorAll("[data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === state.nav));
  if (state.nav === "pages") {
    $("#navContent").innerHTML = `<div class="thumb-grid">${Array.from({ length: 24 }, (_, i) => `<button class="thumb-card${i + 1 === state.page ? " active" : ""}" data-page="${i + 1}" aria-label="第 ${i + 1} 页"><div class="thumb-page"><i></i><i></i><i></i><i></i>${i % 3 === 2 ? "<b></b>" : ""}</div>${i + 1}</button>`).join("")}</div>`;
  } else if (state.nav === "outline") {
    $("#navContent").innerHTML = `<div class="outline-list"><button data-page="1">封面 <small>1</small></button><button data-page="3" class="${state.page === 3 ? "active" : ""}">01　设计目标 <small>3</small></button><button data-page="7" class="indent">主要决定 <small>7</small></button><button data-page="12">02　实现范围 <small>12</small></button><button data-page="18">03　验收标准 <small>18</small></button><button data-page="22">附录 <small>22</small></button></div>`;
  } else {
    $("#navContent").innerHTML = `<label class="nav-search"><span class="magnify"></span><input id="documentSearch" placeholder="在文档中查找"></label><p class="search-help">输入关键词定位到页内结果。<br>原型暂不检索真实文件。</p>`;
    $("#documentSearch").focus();
  }
}
function setPage(page) {
  state.page = Math.max(1, Math.min(24, page));
  $("#currentPage").textContent = state.page;
  $(".paper-meta span:last-child").textContent = `第 ${state.page} 页 / 共 24 页`;
  $(".paper-footer span:last-child").textContent = String(state.page).padStart(2, "0");
  renderNav();
}
function setZoom(value) {
  state.zoom = Math.max(60, Math.min(160, value));
  $("#zoomValue").textContent = `${state.zoom}%`;
  $("#paper").style.transform = `scale(${state.zoom / 100})`;
}
function splitParts() {
  if (splitState.method === "single") return Array.from({ length: 24 }, (_, i) => [i + 1, i + 1]);
  if (splitState.method === "boundary") {
    const n = Number(splitState.boundary);
    if (!Number.isInteger(n) || n < 1 || n > 23) return null;
    return [[1, n], [n + 1, 24]];
  }
  if (splitState.method === "every") {
    const n = Number(splitState.every);
    if (!Number.isInteger(n) || n < 1 || n > 24) return null;
    return Array.from({ length: Math.ceil(24 / n) }, (_, i) => [i * n + 1, Math.min(24, (i + 1) * n)]);
  }
  const tokens = splitState.ranges.split(/[,，]/);
  const matches = tokens.map((part) => part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/));
  if (matches.some((m) => !m)) return null;
  const parts = matches.map((m) => [Number(m[1]), Number(m[2])]);
  if (!parts.length || parts.some(([a, b]) => a < 1 || b > 24 || a > b)) return null;
  return parts;
}
function updateSplitPreview() {
  const parts = splitParts();
  const summary = $("#splitSummary");
  const preview = $("#splitPreview");
  if (!summary || !preview) return;
  if (!parts) { summary.textContent = "页码无效：分割页须为 1–23；每份页数须为 1–24；自定义范围如 1-5,6-12。"; preview.innerHTML = ""; $("#splitRun").disabled = true; return; }
  summary.textContent = `将生成 ${parts.length} 个 PDF · 原文件保留`;
  const base = state.name.replace(/\.pdf$/i, "");
  preview.innerHTML = parts.slice(0, 6).map(([a, b], i) => `<div><span>${base}_${String(i + 1).padStart(2, "0")}.pdf</span><strong>第 ${a}${a === b ? "" : `–${b}`} 页</strong></div>`).join("") + (parts.length > 6 ? `<small>还有 ${parts.length - 6} 个文件…</small>` : "");
  $("#splitRun").disabled = false;
}
function renderSplitOptions() {
  const box = $("#splitOptions");
  if (!box) return;
  box.innerHTML = splitState.method === "single" ? `<p>每一页单独保存为一个 PDF，共 24 个文件。</p>` :
    splitState.method === "boundary" ? `<label>在第几页后分割</label><div class="number-control"><input id="splitBoundary" type="number" min="1" max="23" value="${splitState.boundary}"><span>页后 · 生成前后两份</span></div>` :
    splitState.method === "every" ? `<label>每份最多几页</label><div class="number-control"><input id="splitEvery" type="number" min="1" max="24" value="${splitState.every}"><span>页 / 份</span></div>` :
    `<label>自定义页码范围</label><input id="splitRanges" type="text" value="${splitState.ranges}" placeholder="例如 1-5,6-12,13-24"><p>用英文或中文逗号分隔，按输入顺序生成文件。</p>`;
  document.querySelectorAll("[data-split-method]").forEach((button) => button.classList.toggle("active", button.dataset.splitMethod === splitState.method));
  updateSplitPreview();
}
function openSplitPanel() {
  splitState.boundary = Math.min(23, state.page);
  state.panel = "split";
  $("#detailpanel").hidden = false;
  $("#detailEyebrow").textContent = "页面 · 新文件";
  $("#detailTitle").textContent = "拆分 PDF";
  $("#detailContent").innerHTML = `<p class="detail-lead">选择一种拆分方式。先确认生成的文件和页码，再保存到本机。</p><div class="split-methods"><button data-split-method="single">拆成单页</button><button data-split-method="boundary">按某页分割</button><button data-split-method="every">每 N 页</button><button data-split-method="ranges">自定义范围</button></div><div class="tool-detail-box" id="splitOptions"></div><div class="detail-section-label">输出预览</div><div id="splitSummary" class="operation-summary"></div><div id="splitPreview" class="file-preview"></div><div class="tool-detail-box"><label>保存位置</label><select><option>原文件旁的“拆分结果”文件夹</option><option>每次选择文件夹</option></select></div><button class="detail-action" id="splitRun">开始拆分</button><div class="prototype-note">设计原型仅预览拆分结果，尚未生成真实文件。</div>`;
  renderSplitOptions();
}
function pageCount(name) { return name === "采购协议.pdf" ? 18 : 24; }
function validMergeRange(value, max) {
  const m = String(value).trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
  return m && Number(m[1]) >= 1 && Number(m[2]) <= max && Number(m[1]) <= Number(m[2]) ? Number(m[2]) - Number(m[1]) + 1 : null;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function updateMergePreview() {
  const summary = $("#mergeSummary");
  if (!summary) return;
  const counts = mergeFiles.map((file) => validMergeRange(file.range, pageCount(file.name)));
  const valid = mergeFiles.length >= 2 && counts.every((n) => n !== null);
  summary.textContent = valid ? `${mergeFiles.length} 份文件 → ${counts.reduce((a, b) => a + b, 0)} 页的新 PDF · 原文件保留` : "至少添加 2 份文件，并填写有效的页码范围";
  $("#mergeRun").disabled = !valid;
}
function renderMergeFiles() {
  const list = $("#mergeFiles");
  if (!list) return;
  list.innerHTML = mergeFiles.map((file, i) => `<div class="merge-file"><div class="merge-file-main"><span class="merge-order">${i + 1}</span><span class="merge-file-name">${escapeHtml(file.name)}<small>共 ${pageCount(file.name)} 页</small></span><div class="merge-controls"><button data-merge-up="${i}" title="上移" ${i === 0 ? "disabled" : ""}>↑</button><button data-merge-down="${i}" title="下移" ${i === mergeFiles.length - 1 ? "disabled" : ""}>↓</button><button data-merge-remove="${i}" title="移除">×</button></div></div><label>合并页码 <input data-merge-range="${i}" value="${escapeHtml(file.range)}" aria-label="${escapeHtml(file.name)} 的合并页码"></label></div>`).join("");
  updateMergePreview();
}
function openMergePanel() {
  if (!mergeFiles.length) mergeFiles = [{ name: state.name, range: `1-${pageCount(state.name)}` }, { name: state.name === "采购协议.pdf" ? "产品评审纪要.pdf" : "采购协议.pdf", range: state.name === "采购协议.pdf" ? "1-24" : "1-18" }];
  state.panel = "merge";
  $("#detailpanel").hidden = false;
  $("#detailEyebrow").textContent = "页面 · 新文件";
  $("#detailTitle").textContent = "合并 PDF";
  $("#detailContent").innerHTML = `<p class="detail-lead">按下方顺序合并。可以调整顺序和每份文件取用的页码。</p><div class="detail-section-label">文件顺序与页码</div><div id="mergeFiles" class="merge-files"></div><button class="detail-secondary" id="mergeAdd">＋ 添加样本文件</button><div class="tool-detail-box"><label for="mergeName">输出文件名</label><input id="mergeName" value="合并后的文档.pdf"></div><div class="tool-detail-box"><label>保存位置</label><select><option>原文件所在文件夹</option><option>每次选择文件夹</option></select></div><div id="mergeSummary" class="operation-summary"></div><button class="detail-action" id="mergeRun">合并并保存</button><div class="prototype-note">设计原型使用样本文件演示，尚未生成真实文件。</div>`;
  renderMergeFiles();
}
function openPanel(kind, label) {
  if (kind === "split" || label === "拆分") { openSplitPanel(); return; }
  if (kind === "merge" || label === "合并") { openMergePanel(); return; }
  state.panel = kind;
  const panel = $("#detailpanel");
  panel.hidden = false;
  const eyebrow = $("#detailEyebrow");
  const title = $("#detailTitle");
  const content = $("#detailContent");
  if (kind === "ai") {
    eyebrow.textContent = "文档内 AI";
    title.textContent = "文档助手";
    content.innerHTML = `<div class="ai-context"><strong>本地优先</strong> · 当前文档：${state.name}<br>远程模型仅在你主动选择后使用。</div><p class="detail-lead">从文档中提问、总结或翻译。正式版的每个结论都能跳转到来源页。</p><div class="detail-section-label">从这里开始</div><div class="suggestions"><button data-ai="摘要">生成摘要<small>全文要点</small></button><button data-ai="问答">询问文档<small>带页码引用</small></button><button data-ai="翻译">翻译内容<small>选区或全文</small></button><button data-ai="OCR">识别扫描件<small>生成可搜索文本</small></button></div><div id="aiResult" class="ai-spacer"></div><div class="askbox"><textarea id="aiQuestion" placeholder="向文档提问…"></textarea><div class="askbox-foot"><span>本地模型 · 原型未连接</span><button id="askButton">发送 ↗</button></div></div><div class="prototype-note">设计原型只演示入口和反馈，不执行模型推理。</div>`;
  } else if (kind === "task") {
    eyebrow.textContent = "后台任务";
    title.textContent = "任务队列";
    content.innerHTML = `<p class="detail-lead">转换、OCR 和 AI 任务在这里显示进度。你可以继续阅读当前文档。</p><div class="tool-detail-box">目前没有正在运行的任务。</div><div class="prototype-note">正式版支持取消、重试与重启后找回结果。</div>`;
  } else if (kind === "settings") {
    eyebrow.textContent = "偏好设置";
    title.textContent = "本地与 AI";
    content.innerHTML = `<p class="detail-lead">阅读、输出和模型配置集中在这里，日常操作不会被配置项打断。</p><div class="tool-detail-box"><label>AI 通道</label><select><option>本地模型（默认）</option><option>自定义远程模型</option></select></div><div class="tool-detail-box"><label>默认保存方式</label><select><option>保存到原文件旁</option><option>每次询问位置</option></select></div><div class="prototype-note">此处仅展示设置结构，未改动本机配置。</div>`;
  } else {
    eyebrow.textContent = ({ read: "阅读", pages: "页面", convert: "转换", ai: "AI" })[state.mode];
    title.textContent = label;
    let hint = "当前命令的设置和预览显示在这里。";
    let field = "作用范围";
    let options = ["当前页", "选中页面", "整个文档"];
    if (state.mode === "convert") { hint = "选择输出方式，确认后在后台生成新文件。"; field = "输出质量"; options = ["均衡", "清晰优先", "文件更小"]; }
    content.innerHTML = `<p class="detail-lead">${hint}</p><div class="tool-detail-box"><label>${field}</label><select>${options.map((option) => `<option>${option}</option>`).join("")}</select></div><button class="detail-action" id="previewAction">预览操作</button><button class="detail-secondary" id="cancelAction">取消</button><div class="prototype-note">设计原型不修改真实文档。</div>`;
  }
}
function closePanel() { state.panel = null; $("#detailpanel").hidden = true; }
function showHome(show) {
  state.home = show;
  $("#home").hidden = !show;
  $("#workspace").hidden = show;
  $("#operation").hidden = true;
  if (show) closePanel();
}
function openDocument(name) {
  state.name = name;
  mergeFiles = [];
  $("#tabName").textContent = name;
  $("#statusName").textContent = name;
  showHome(false);
  setPage(name === "产品评审纪要.pdf" ? 3 : 1);
  toast("已打开设计样本文档");
}
let opTask = null;
let opFiles = [];
let opMethod = "boundary";
let opBoundary = 3;
let opEvery = 4;
let opRanges = "1-5,6-24";
let opName = "";
let opFolder = "本机输出目录";
let opDone = false;
let opDrag = -1;
function opGroups() {
  const total = pageCount(opFiles[0]?.name || "产品评审纪要.pdf");
  if (opMethod === "single") return Array.from({ length: total }, (_, i) => `${i + 1}`);
  if (opMethod === "boundary") return opBoundary > 0 && opBoundary < total ? [`1-${opBoundary}`, `${Number(opBoundary) + 1}-${total}`] : [];
  if (opMethod === "every") return opEvery > 0 ? Array.from({ length: Math.ceil(total / opEvery) }, (_, i) => `${i * opEvery + 1}-${Math.min((i + 1) * opEvery, total)}`) : [];
  return opRanges.split(/[,，]/).map((s) => s.trim()).filter((s) => /^(\d+)(-\d+)?$/.test(s));
}
function renderOperation() {
  if (opTask === "convert") { renderImageConversion(); return; }
  const merge = opTask === "merge";
  $("#opKind").textContent = merge ? "合并 PDF" : "拆分 PDF";
  $("#opTitle").textContent = opDone ? (merge ? "合并完成" : "拆分完成") : (merge ? "合并 PDF" : "拆分 PDF");
  $("#opSubtitle").textContent = opDone ? "结果已生成。需要查看内容时，再打开阅读标签。" : (merge ? "添加文件，拖动调整顺序，再设置输出。" : "选择拆分方式，确认预览后生成。此时无需打开阅读器。");
  if (opDone) {
    const names = merge ? [opName || "合并后的文档.pdf"] : opGroups().map((_, i) => `${opName || "拆分结果"}-${String(i + 1).padStart(2, "0")}.pdf`);
    $("#opContent").innerHTML = `<div class="op-success"><div class="op-tick">✓</div><h2>已生成 ${names.length} 个 PDF</h2><p>保存至 ${escapeHtml(opFolder)} · 原文件保留</p><div class="op-results">${names.slice(0, 30).map((name) => `<div><span>PDF</span><strong>${escapeHtml(name)}</strong><button data-op-open="${escapeHtml(name)}">打开阅读</button></div>`).join("")}</div><div class="op-actions"><button id="opAgain">再${merge ? "合并" : "拆分"}一次</button><button class="primary" data-op-open="${escapeHtml(names[0])}">打开${merge ? "结果" : "第一个结果"}并阅读</button></div></div>`;
    return;
  }
  const groups = merge ? [] : opGroups();
  const fileRows = opFiles.map((file, i) => `<div class="op-file" draggable="${merge}" data-op-row="${i}"><div class="op-file-main"><span class="op-handle">${merge ? "⋮⋮" : "PDF"}</span><span class="op-number">${String(i + 1).padStart(2, "0")}</span><strong>${escapeHtml(file.name)}</strong><small>${pageCount(file.name)} 页</small>${merge ? `<button data-op-up="${i}" ${i === 0 ? "disabled" : ""}>↑</button><button data-op-down="${i}" ${i === opFiles.length - 1 ? "disabled" : ""}>↓</button>` : ""}<button data-op-remove="${i}">×</button></div>${merge ? `<label>取用页码 <input data-op-range="${i}" value="${escapeHtml(file.range || "")}" placeholder="全部页面，或输入 1-3,5"></label>` : ""}</div>`).join("");
  const methods = merge ? "" : `<div class="op-section-title">02 拆分方式</div><div class="op-methods">${[["single","拆成单页"],["boundary","按某页分割"],["every","每 N 页"],["ranges","自定义范围"]].map(([id,label]) => `<button data-op-method="${id}" class="${opMethod === id ? "active" : ""}">${label}</button>`).join("")}</div><div class="op-method-setting">${opMethod === "boundary" ? `在第 <input id="opBoundary" type="number" min="1" max="23" value="${opBoundary}"> 页后分割` : opMethod === "every" ? `每 <input id="opEvery" type="number" min="1" value="${opEvery}"> 页生成一份` : opMethod === "ranges" ? `<input id="opRanges" value="${escapeHtml(opRanges)}" placeholder="1-5,6-24">` : "每一页独立保存为一个 PDF"}</div>`;
  $("#opContent").innerHTML = `<div class="op-grid"><section class="op-card"><div class="op-section-title">01 ${merge ? "文件与顺序" : "选择文件"}<small>${opFiles.length} 个文件</small></div><label class="op-add">＋ ${merge ? "继续添加 PDF" : "更换 PDF"}<input id="opFileInput" type="file" accept=".pdf" ${merge ? "multiple" : ""} hidden></label>${fileRows}${methods}</section><aside class="op-card"><div class="op-section-title">${merge ? "02" : "03"} 输出设置</div><label class="op-field">${merge ? "输出文件名" : "输出文件名前缀"}<input id="opName" value="${escapeHtml(opName)}"></label><label class="op-field">保存位置<div class="op-folder"><span>${escapeHtml(opFolder)}</span><button id="opFolderPick" type="button">更改</button><input id="opFolderInput" type="file" webkitdirectory directory hidden></div></label><div class="op-preview"><small>输出预览</small><strong>${merge ? `1 个 PDF · 预计 ${opFiles.reduce((n, f) => n + pageCount(f.name), 0)} 页` : `${groups.length} 个 PDF`}</strong><div>${merge ? opFiles.map((f) => escapeHtml(f.name)).join(" → ") : groups.slice(0, 8).map((g, i) => `${String(i + 1).padStart(2, "0")} · 第 ${g} 页`).join("<br>")}</div></div><p>生成新文件，源文件保留。设计原型不处理真实文件。</p></aside></div><div class="op-actions"><button id="opBack">返回首页</button><button id="opRun" class="primary" ${merge ? opFiles.length < 2 ? "disabled" : "" : !groups.length ? "disabled" : ""}>${merge ? "合并并保存" : `生成 ${groups.length} 个 PDF`}</button></div>`;
}
function renderImageConversion() {
  $("#opKind").textContent = "图片转 PDF";
  $("#opTitle").textContent = opDone ? "转换完成" : "图片转 PDF";
  $("#opSubtitle").textContent = opDone ? "结果已生成，可打开新的阅读标签。" : "转换前查看缩略图；拖动、上移或删除图片，当前顺序就是 PDF 页序。";
  if (opDone) {
    $("#opContent").innerHTML = `<div class="op-success"><div class="op-tick">✓</div><h2>已生成 1 个 PDF</h2><p>${escapeHtml(opFolder)} · ${opFiles.length} 页 · 原图保留</p><div class="op-results"><div><span>PDF</span><strong>${escapeHtml(opName || "图片合集.pdf")}</strong><button data-op-open="${escapeHtml(opName || "图片合集.pdf")}">打开阅读</button></div></div><div class="op-actions"><button id="opAgain">再转换一次</button><button class="primary" data-op-open="${escapeHtml(opName || "图片合集.pdf")}">打开并阅读</button></div></div>`;
    return;
  }
  const cards = opFiles.map((file, i) => `<div class="op-photo" draggable="true" data-op-row="${i}"><div class="op-photo-art"><img src="${file.url}" alt="${escapeHtml(file.name)} 预览"><span>${String(i + 1).padStart(2,"0")}</span></div><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><div class="op-photo-controls"><span>⋮⋮</span><button data-op-up="${i}" ${i === 0 ? "disabled" : ""}>↑</button><button data-op-down="${i}" ${i === opFiles.length - 1 ? "disabled" : ""}>↓</button><button data-op-remove="${i}">×</button></div></div>`).join("");
  $("#opContent").innerHTML = `<div class="op-grid"><section class="op-card"><div class="op-section-title">01 图片预览与顺序 <small>${opFiles.length} 张 · 拖动排序</small></div><label class="op-add">＋ 继续添加图片<input id="opFileInput" type="file" accept=".png,.jpg,.jpeg" multiple hidden></label><div class="op-photo-grid">${cards}</div><p>缩略图左上角的序号就是生成后的 PDF 页码。点击 × 只从本次任务中移除图片。</p></section><aside class="op-card"><div class="op-section-title">02 输出设置</div><div class="op-field">目标格式　<strong>PDF</strong></div><label class="op-field">输出文件名<input id="opName" value="${escapeHtml(opName)}"></label><label class="op-field">保存位置<div class="op-folder"><span>${escapeHtml(opFolder)}</span><button id="opFolderPick" type="button">更改</button><input id="opFolderInput" type="file" webkitdirectory directory hidden></div></label><div class="op-preview"><small>输出预览</small><strong>1 个 PDF · ${opFiles.length} 页</strong><div>${opFiles.map((f) => escapeHtml(f.name)).join(" → ")}</div></div><p>设计原型不处理真实文件。</p></aside></div><div class="op-actions"><button id="opBack">返回首页</button><button id="opRun" class="primary" ${opFiles.length ? "" : "disabled"}>生成 PDF · ${opFiles.length} 页</button></div>`;
}
function openOperation(task, files) {
  opTask = task;
  opFiles = files.map((f) => ({ name: f.name, range: "", url: task === "convert" ? URL.createObjectURL(f) : null }));
  opName = task === "merge" ? "合并后的文档.pdf" : task === "convert" ? "图片合集.pdf" : `${files[0]?.name.replace(/\.pdf$/i, "") || "拆分结果"}-拆分`;
  opDone = false;
  $("#home").hidden = true;
  $("#workspace").hidden = true;
  $("#operation").hidden = false;
  renderOperation();
}
function openPalette(query = "") {
  $("#toolPalette").hidden = false;
  $("#paletteInput").value = query;
  renderPalette();
  $("#paletteInput").focus();
}
function closePalette() { $("#toolPalette").hidden = true; }
let pendingFileTask = "read";
function openFilePicker(task = "read") {
  pendingFileTask = task;
  const titles = { read: "打开 PDF", split: "拆分 PDF", merge: "合并 PDF", convert: "转换文件", ai: "AI 阅读" };
  const hints = { read: "选择一个本地 PDF，继续阅读。", split: "先选择一个本地 PDF，再设置拆分方式。", merge: "选择至少两个本地 PDF，之后可继续添加并调整顺序。", convert: "选择一个 PDF，或一次选择多张图片；图片将在转换前预览和排序。", ai: "选择一个本地 PDF，进入 AI 阅读。" };
  $("#filePickerTitle").textContent = titles[task];
  $("#filePickerHint").textContent = hints[task];
  $("#fileDropLabel").textContent = task === "merge" ? "点击选择多个本地 PDF" : task === "convert" ? "选择 PDF 或多张图片" : "点击选择本地文件";
  $("#fileInput").multiple = task === "merge" || task === "convert";
  $("#fileInput").accept = task === "convert" ? ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" : ".pdf,application/pdf";
  $("#fileInput").value = "";
  $("#filePicker").hidden = false;
  $("#fileDrop").focus();
}
function closeFilePicker() { $("#filePicker").hidden = true; }
function continueFileTask(files) {
  if (!files.length) return;
  const allowed = pendingFileTask === "convert" ? /\.(pdf|png|jpe?g)$/i : /\.pdf$/i;
  if (files.some((file) => !allowed.test(file.name))) { toast("请选择受支持的本地文件"); return; }
  if (pendingFileTask === "convert" && files.length > 1 && !files.every((file) => /\.(png|jpe?g)$/i.test(file.name))) { toast("多选转换仅支持图片；PDF 请单独选择"); return; }
  if (pendingFileTask === "merge" && files.length < 2) { toast("请至少选择两个 PDF 文件"); return; }
  const task = pendingFileTask;
  closeFilePicker();
  if (task === "convert" && files.every((file) => /\.(png|jpe?g)$/i.test(file.name))) { openOperation(task, files); return; }
  if (task === "merge" || task === "split") { openOperation(task, files); return; }
  openDocument(files[0].name);
  state.mode = task === "split" || task === "merge" ? "pages" : task === "read" ? "read" : task;
  if (task === "merge") mergeFiles = files.map((file) => ({ name: file.name, range: "1-24" }));
  renderMode();
  if (task === "split") openSplitPanel();
  if (task === "merge") openMergePanel();
  if (task === "convert") openPanel("tool", "转换文件");
  toast("已选择本地文件 · 设计原型不处理真实文件");
}
function renderPalette() {
  const query = $("#paletteInput").value.trim().toLowerCase();
  const entries = [...Object.entries(modes).flatMap(([mode, tools]) => tools.map(([name]) => ({ name, mode }))), ...more.flatMap(([mode, ...names]) => names.map((name) => ({ name, mode: ({ 阅读: "read", 页面: "pages", 转换: "convert", AI: "ai" })[mode] })))];
  const results = entries.filter((entry) => !query || entry.name.toLowerCase().includes(query)).slice(0, 12);
  $("#paletteResults").innerHTML = results.length ? results.map((entry) => `<button data-palette-tool="${entry.name}" data-palette-mode="${entry.mode}"><span>${entry.name}</span><small>${({ read: "阅读", pages: "页面", convert: "转换", ai: "AI" })[entry.mode]}</small></button>`).join("") : `<div class="search-help" style="padding:14px">没有匹配的工具</div>`;
}
document.addEventListener("click", (event) => {
  const target = event.target;
  const opMethodButton = target.closest("[data-op-method]");
  if (opMethodButton) { opMethod = opMethodButton.dataset.opMethod; renderOperation(); return; }
  const opUp = target.closest("[data-op-up]");
  if (opUp) { const i = Number(opUp.dataset.opUp); [opFiles[i - 1], opFiles[i]] = [opFiles[i], opFiles[i - 1]]; renderOperation(); return; }
  const opDown = target.closest("[data-op-down]");
  if (opDown) { const i = Number(opDown.dataset.opDown); [opFiles[i], opFiles[i + 1]] = [opFiles[i + 1], opFiles[i]]; renderOperation(); return; }
  const opRemove = target.closest("[data-op-remove]");
  if (opRemove) { const removed = opFiles.splice(Number(opRemove.dataset.opRemove), 1)[0]; if (removed?.url) URL.revokeObjectURL(removed.url); renderOperation(); return; }
  const opOpen = target.closest("[data-op-open]");
  if (opOpen) { openDocument(opOpen.dataset.opOpen); return; }
  if (target.id === "opHome" || target.id === "opBack") { showHome(true); return; }
  if (target.id === "opAgain") { opDone = false; renderOperation(); return; }
  if (target.id === "opRun") { opDone = true; renderOperation(); return; }
  if (target.id === "opFolderPick") { $("#opFolderInput").click(); return; }
  const splitMethod = target.closest("[data-split-method]");
  if (splitMethod) { splitState.method = splitMethod.dataset.splitMethod; renderSplitOptions(); return; }
  const mergeUp = target.closest("[data-merge-up]");
  if (mergeUp) { const i = Number(mergeUp.dataset.mergeUp); [mergeFiles[i - 1], mergeFiles[i]] = [mergeFiles[i], mergeFiles[i - 1]]; renderMergeFiles(); return; }
  const mergeDown = target.closest("[data-merge-down]");
  if (mergeDown) { const i = Number(mergeDown.dataset.mergeDown); [mergeFiles[i], mergeFiles[i + 1]] = [mergeFiles[i + 1], mergeFiles[i]]; renderMergeFiles(); return; }
  const mergeRemove = target.closest("[data-merge-remove]");
  if (mergeRemove) { mergeFiles.splice(Number(mergeRemove.dataset.mergeRemove), 1); renderMergeFiles(); return; }
  if (target.id === "mergeAdd") { mergeFiles.push({ name: "采购协议.pdf", range: "1-18" }); renderMergeFiles(); return; }
  if (target.id === "splitRun" || target.id === "mergeRun") { toast("设计原型：已展示输出预览，真实文件处理将在正式版接入"); return; }
  const mode = target.closest("[data-mode]");
  if (mode) { state.mode = mode.dataset.mode; renderMode(); return; }
  const nav = target.closest("[data-nav]");
  if (nav) { state.nav = nav.dataset.nav; renderNav(); return; }
  const page = target.closest("[data-page]");
  if (page) { setPage(Number(page.dataset.page)); return; }
  const tool = target.closest("[data-tool]");
  if (tool) {
    const name = tool.dataset.tool;
    if (name === "适应宽度") { setZoom(100); return; }
    if (name === "打印") { toast("设计原型：打印未连接"); return; }
    if (state.mode === "ai") openPanel("ai"); else openPanel("tool", name);
    return;
  }
  const suggestion = target.closest("[data-ai]");
  if (suggestion) { $("#aiQuestion").value = ({ 摘要: "总结这份文档的重点", 问答: "这份文档有哪些主要决定？", 翻译: "翻译当前选中的内容", OCR: "识别当前页文字" })[suggestion.dataset.ai]; $("#aiQuestion").focus(); return; }
  const paletteTool = target.closest("[data-palette-tool]");
  if (paletteTool) { state.mode = paletteTool.dataset.paletteMode; renderMode(); openPanel(state.mode === "ai" ? "ai" : "tool", paletteTool.dataset.paletteTool); closePalette(); return; }
  const open = target.closest("[data-open]");
  if (open) { openDocument(open.dataset.open); return; }
  const start = target.closest("[data-start]");
  if (start) { openFilePicker(start.dataset.start); return; }
  if (target.id === "brand" || target.closest("#brand") || target.closest(".tab-close")) { showHome(true); return; }
  if (target.id === "newTab" || target.id === "homeOpen") { openFilePicker("read"); return; }
  if (target.id === "fileDrop") { $("#fileInput").click(); return; }
  if (target.id === "filePickerClose" || target.id === "filePicker") { closeFilePicker(); return; }
  if (target.id === "commandTrigger" || target.closest("#commandTrigger") || target.id === "moreTools" || target.closest("#moreTools")) { openPalette(); return; }
  if (target.id === "taskTrigger" || target.closest("#taskTrigger")) { openPanel("task"); return; }
  if (target.id === "settingsTrigger") { openPanel("settings"); return; }
  if (target.id === "saveButton") { toast("设计原型：保存未连接"); return; }
  if (target.id === "hideNav") { $("#workspace").classList.add("nav-hidden"); $("#workspace").classList.remove("mobile-nav-open"); return; }
  if (target.id === "showNav") { $("#workspace").classList.remove("nav-hidden"); $("#workspace").classList.add("mobile-nav-open"); return; }
  if (target.id === "closeDetail" || target.id === "cancelAction") { closePanel(); return; }
  if (target.id === "previewAction") { toast("正式版将在这里预览改动并允许撤销"); return; }
  if (target.id === "askButton") { $("#aiResult").innerHTML = `<div class="tool-detail-box" style="margin-top:10px">设计原型未连接模型。正式版将在这里显示回答与可跳转的来源页。</div>`; return; }
  if (target.id === "prevPage") { setPage(state.page - 1); return; }
  if (target.id === "nextPage") { setPage(state.page + 1); return; }
  if (target.id === "zoomOut") { setZoom(state.zoom - 10); return; }
  if (target.id === "zoomIn") { setZoom(state.zoom + 10); return; }
  if (target.id === "fitWidth") { setZoom(100); return; }
  if (target.id === "toolPalette") { closePalette(); }
});
$("#fileInput").addEventListener("change", (event) => continueFileTask(Array.from(event.target.files || [])));
document.addEventListener("change", (event) => {
  if (event.target.id === "opRanges") { opRanges = event.target.value; renderOperation(); }
  if (event.target.id === "opFileInput") { const added = Array.from(event.target.files || []).filter((f) => opTask === "convert" ? /\.(png|jpe?g)$/i.test(f.name) : /\.pdf$/i.test(f.name)); opFiles = opTask === "convert" ? [...opFiles, ...added.map((f) => ({ name: f.name, url: URL.createObjectURL(f) }))] : opTask === "merge" ? [...opFiles, ...added.map((f) => ({ name: f.name, range: "" }))] : added.slice(0, 1).map((f) => ({ name: f.name, range: "" })); renderOperation(); }
  if (event.target.id === "opFolderInput") { opFolder = event.target.files?.[0]?.webkitRelativePath?.split("/")[0] || opFolder; renderOperation(); }
});
document.addEventListener("dragstart", (event) => { const row = event.target.closest("[data-op-row]"); if (row && (opTask === "merge" || opTask === "convert")) opDrag = Number(row.dataset.opRow); });
document.addEventListener("dragover", (event) => { if (event.target.closest("[data-op-row]")) event.preventDefault(); });
document.addEventListener("drop", (event) => { const row = event.target.closest("[data-op-row]"); if (row && opDrag >= 0) { event.preventDefault(); const to = Number(row.dataset.opRow); opFiles.splice(to, 0, ...opFiles.splice(opDrag, 1)); opDrag = -1; renderOperation(); } });
$("#fileDrop").addEventListener("dragover", (event) => { event.preventDefault(); event.currentTarget.classList.add("drag-over"); });
$("#fileDrop").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("drag-over"));
$("#fileDrop").addEventListener("drop", (event) => { event.preventDefault(); event.currentTarget.classList.remove("drag-over"); continueFileTask(Array.from(event.dataTransfer.files || [])); });
document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "opBoundary") { opBoundary = Number(target.value); renderOperation(); return; }
  if (target.id === "opEvery") { opEvery = Number(target.value); renderOperation(); return; }
  if (target.id === "opRanges") { opRanges = target.value; return; }
  if (target.id === "opName") { opName = target.value; return; }
  if (target.matches("[data-op-range]")) { opFiles[Number(target.dataset.opRange)].range = target.value; return; }
  if (target.id === "splitBoundary") { splitState.boundary = target.value; updateSplitPreview(); }
  if (target.id === "splitEvery") { splitState.every = target.value; updateSplitPreview(); }
  if (target.id === "splitRanges") { splitState.ranges = target.value; updateSplitPreview(); }
  if (target.matches("[data-merge-range]")) { mergeFiles[Number(target.dataset.mergeRange)].range = target.value; updateMergePreview(); }
});
$("#paletteInput").addEventListener("input", renderPalette);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openPalette(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); showHome(false); state.nav = "search"; renderNav(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); toast("设计原型：保存未连接"); }
  if (event.key === "Escape") { closePalette(); closeFilePicker(); if (state.panel) closePanel(); }
});
renderMode();
renderNav();
if (query.get("view") === "split") openOperation("split", [{ name: "产品评审纪要.pdf" }]);
if (query.get("view") === "merge") openOperation("merge", [{ name: "产品评审纪要.pdf" }, { name: "采购协议.pdf" }]);
