/**
 * Browser entry: upload → stream progress → render reports.
 * No framework, no build step — this file is what the browser runs.
 */

const state = {
  config: null,
  checklists: [],
  files: [],
  running: false,
  tally: { pass: 0, warn: 0, fail: 0, scores: [] },
  failedRules: new Map(),
  reasons: {},
  feedbackTotal: 0,
  currentImage: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const SEVERITY_LABEL = { high: "高", medium: "中", low: "低" };
const STATUS_LABEL = { pass: "通过", fail: "不通过", unknown: "未判定", overturned: "已推翻" };
const money = (amount, currency = "USD") => {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (!amount) return `${symbol}0`;
  if (amount < 0.0001) return `${symbol}${amount.toExponential(2)}`;
  if (amount < 0.01) return `${symbol}${amount.toFixed(6)}`;
  if (amount < 1) return `${symbol}${amount.toFixed(4)}`;
  return `${symbol}${amount.toFixed(2)}`;
};

/* ---------------- boot ---------------- */

async function boot() {
  const [health, checklists] = await Promise.all([
    fetch("/api/health").then((r) => r.json()),
    fetch("/api/checklists").then((r) => r.json()),
  ]);
  state.config = health.config;
  state.checklists = checklists.checklists;

  const dot = $("route-dot");
  const text = $("route-text");
  if (state.config.mock || !state.config.apiKeyConfigured) {
    dot.className = "dot off";
    text.textContent = state.config.mock
      ? "演示模式（本地像素兜底）"
      : `未找到 ${state.config.apiKeyEnv}，将自动使用本地像素兜底`;
  } else {
    dot.className = "dot live";
    text.textContent = `${state.config.providerLabel} · ${state.config.model}`;
    text.title = `凭据来源：${state.config.credentialSource}`;
  }
  $("max-images").textContent = String(state.config.maxImages ?? 12);
  $("mock").checked = Boolean(state.config.mock || !state.config.apiKeyConfigured);

  // Reviewer overturn state, so the panel shows what the log already knows.
  try {
    const feedback = await fetch("/api/feedback").then((r) => r.json());
    state.reasons = feedback.reasons ?? {};
    state.feedbackTotal = feedback.total ?? 0;
    renderFeedbackSummary(feedback);
  } catch {
    /* feedback is optional */
  }

  const select = $("checklist");
  select.innerHTML = "";
  for (const checklist of state.checklists) {
    const option = el("option", null, `${checklist.name} v${checklist.version}`);
    option.value = checklist.id;
    select.append(option);
  }
  select.addEventListener("change", renderChecklistInfo);
  renderChecklistInfo();
}

function currentChecklist() {
  const id = $("checklist").value;
  return state.checklists.find((entry) => entry.id === id) ?? state.checklists[0];
}

function renderChecklistInfo() {
  const checklist = currentChecklist();
  if (!checklist) return;
  $("checklist-desc").textContent = checklist.description ?? "";
  const list = $("rule-list");
  list.innerHTML = "";
  for (const rule of checklist.rules) {
    const item = el("li");
    item.append(el("span", "sev", SEVERITY_LABEL[rule.severity ?? "medium"] ?? "中"));
    item.append(el("span", null, `${rule.id} · ${rule.title}`));
    list.append(item);
  }
  $("rule-count").textContent = String(checklist.rules.length);
}

/* ---------------- upload ---------------- */

function addFiles(fileList) {
  const incoming = [...fileList].filter((file) => file.type.startsWith("image/"));
  const limit = state.config?.maxImages ?? 12;
  state.files = [...state.files, ...incoming].slice(0, limit);
  renderThumbs();
}

function renderThumbs() {
  const list = $("thumbs");
  list.innerHTML = "";
  state.files.forEach((file, index) => {
    const item = el("li");
    const img = el("img");
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    item.append(img, el("span", "tag", file.name));
    item.title = `${file.name}（点击移除）`;
    item.addEventListener("click", () => {
      state.files.splice(index, 1);
      renderThumbs();
    });
    list.append(item);
  });
  $("run").disabled = state.files.length === 0 || state.running;
  $("status").textContent = state.files.length === 0
    ? "等待上传图片…"
    : `已选择 ${state.files.length} 张图片，可以开始质检。`;
}

/* ---------------- trace ---------------- */

const traceNodes = new Map();

function trace(key, what, detail, kind) {
  const list = $("trace");
  let node = traceNodes.get(key);
  if (!node) {
    node = el("li", "thinking");
    node.append(el("span", "bullet", "•"));
    const body = el("div");
    body.append(el("div", "what", what ?? ""));
    body.append(el("div", "now", ""));
    node.append(body);
    list.append(node);
    traceNodes.set(key, node);
  }
  if (what) node.querySelector(".what").textContent = what;
  if (detail !== undefined) node.querySelector(".now").textContent = detail;
  if (kind) node.className = kind;
  list.scrollTop = list.scrollHeight;
  return node;
}

function clearTrace() {
  traceNodes.clear();
  $("trace").innerHTML = "";
}

/* ---------------- human-in-the-loop ---------------- */

function renderFeedbackSummary(feedback) {
  const node = $("feedback-summary");
  if (!feedback || feedback.total === 0) {
    node.textContent = "尚无人工推翻记录。点判定表里的「推翻」即可记录。";
    return;
  }
  const top = (feedback.byRule ?? []).slice(0, 3)
    .map((group) => `${group.ruleId}×${group.count}`)
    .join("　");
  node.textContent = `已记录 ${feedback.total} 条推翻：${top}`;
}

/** Open a small inline form to overturn one rule result on one image. */
function promptOverturn(report, result, row) {
  const existing = row.nextElementSibling;
  if (existing?.classList.contains("override-form")) {
    existing.remove();
    return;
  }
  const form = el("tr", "override-form");
  const cell = el("td");
  cell.colSpan = 7;

  const select = el("select");
  for (const [key, label] of Object.entries(state.reasons)) {
    const option = el("option", null, label);
    option.value = key;
    select.append(option);
  }
  select.value = "business-exception";
  const note = el("input", "note-input");
  note.placeholder = "备注（可选），例如：清仓图不追求色准";
  const reviewer = el("input", "note-input small");
  reviewer.placeholder = "复核人";
  const submit = el("button", "ghost", "确认推翻");
  const cancel = el("button", "ghost", "取消");

  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imageName: report.image.name,
          ruleId: result.id,
          originalStatus: result.status,
          reason: select.value,
          note: note.value,
          reviewer: reviewer.value || "web",
          context: {
            checklistId: report.checklist.id,
            observed: result.observed,
            assertion: result.assertion,
            severity: result.severity,
          },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "记录失败");
      state.feedbackTotal = body.total;
      renderFeedbackSummary({ total: body.total, byRule: body.byRule ?? [] });
      submit.textContent = "已记录 ✓";
      note.disabled = true;
      select.disabled = true;
    } catch (error) {
      submit.textContent = `失败：${error.message}`;
      submit.disabled = false;
    }
  });
  cancel.addEventListener("click", () => form.remove());

  const row1 = el("div", "override-row");
  row1.append(el("span", "override-label", "推翻原因"), select, note, reviewer, submit, cancel);
  cell.append(row1);
  form.append(cell);
  row.after(form);
}

async function loadAdjustments() {
  const box = $("adjustments");
  const button = $("show-adjustments");
  if (box.childElementCount > 0) {
    box.innerHTML = "";
    button.textContent = "查看阈值调整建议";
    return;
  }
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    const checklistId = $("checklist").value;
    const data = await fetch(`/api/adjustments?checklistId=${encodeURIComponent(checklistId)}`).then((r) => r.json());
    box.innerHTML = "";
    if (!data.suggestions?.length) {
      box.append(el("p", "muted", `依据 ${data.overturns} 条推翻记录，暂未达到形成建议的证据门槛（同一规则至少 2 次，或推翻率 ≥30%）。`));
    } else {
      for (const suggestion of data.suggestions) {
        const card = el("div", "adjustment");
        card.append(el("div", "adjustment-head", `${suggestion.ruleId} ${suggestion.title}`));
        card.append(el("div", "adjustment-meta", `推翻 ${suggestion.overturns} 次 · 置信度 ${suggestion.confidence}${suggestion.overturnRate !== null ? ` · 推翻率 ${(suggestion.overturnRate * 100).toFixed(0)}%` : ""}`));
        card.append(el("div", "adjustment-body", suggestion.advice));
        if (suggestion.proposedValue !== null) {
          card.append(el("div", "adjustment-meta", `当前阈值 ${suggestion.currentValue} → 建议 ${suggestion.proposedValue}（需人工修改清单文件）`));
        }
        box.append(card);
      }
    }
    button.textContent = "收起建议";
  } catch (error) {
    box.append(el("p", "muted", `读取失败：${error.message}`));
    button.textContent = "查看阈值调整建议";
  } finally {
    button.disabled = false;
  }
}

/* ---------------- run ---------------- */

function resetTally() {
  state.tally = { pass: 0, warn: 0, fail: 0, scores: [] };
  state.failedRules = new Map();
}

function updateSummary() {
  const { pass, warn, fail, scores } = state.tally;
  $("summary").hidden = false;
  $("m-score").textContent = scores.length
    ? String(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length))
    : "–";
  $("m-pass").textContent = String(pass);
  $("m-warn").textContent = String(warn);
  $("m-fail").textContent = String(fail);
  const ranked = [...state.failedRules.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
  $("m-top").textContent = ranked.length
    ? ranked.map(([title, info]) => `${title}×${info.count}`).join("　")
    : "暂无失败项";
}

async function run() {
  if (state.running || state.files.length === 0) return;
  state.running = true;
  $("run").disabled = true;
  $("status").textContent = "质检中…";
  $("summary").hidden = true;
  $("stream").innerHTML = "";
  $("consistency-slot").innerHTML = "";
  $("m-cost").textContent = "–";
  $("m-unit").textContent = "–";
  clearTrace();
  resetTally();

  const form = new FormData();
  for (const file of state.files) form.append("images", file, file.name);
  form.append("checklistId", $("checklist").value);
  form.append("mock", $("mock").checked ? "1" : "0");
  form.append("consistency", $("consistency").checked ? "1" : "0");

  const thumbUrls = state.files.map((file) => URL.createObjectURL(file));

  try {
    const response = await fetch("/api/inspect", { method: "POST", body: form });
    if (!response.ok || !response.body) {
      const detail = await response.text();
      throw new Error(`服务端拒绝：${detail.slice(0, 200)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line.slice(6)), thumbUrls);
        } catch (error) {
          // Never swallow silently: a rendering bug must be visible, not a blank panel.
          state.lastEventError = `${error.message}`;
          $("status").textContent = `渲染事件出错：${error.message}`;
          trace(`render-error-${Date.now()}`, "渲染事件出错", `${error.message}（事件 ${frame.slice(0, 120)}）`, "error");
        }
      }
    }
    const { pass, warn, fail } = state.tally;
    $("status").textContent = `完成：共 ${state.files.length} 张 · 合格 ${pass} · 需优化 ${warn} · 不合格 ${fail}`;
  } catch (error) {
    $("status").textContent = `失败：${error.message}`;
    trace(`fatal-${Date.now()}`, "运行失败", error.message, "error");
  } finally {
    state.running = false;
    $("run").disabled = state.files.length === 0;
  }
}

function handleEvent(event, thumbUrls) {
  switch (event.type) {
    case "batch-start":
      trace("batch", `开始质检（${event.total} 张）`, `${event.checklist.name} · ${event.model}${event.mock ? "（本地兜底）" : ""}`);
      break;
    case "image-start":
      trace(`img-${event.index}`, `[${event.index + 1}] ${event.name}`, "排队中…");
      break;
    case "image-measured":
      trace(
        `img-${event.index}`,
        `[${event.index + 1}] ${event.name}`,
        `像素测量：${event.measurement.width}×${event.measurement.height} · ${event.measurement.fileSizeKB}KB · ${event.measurement.format}`,
      );
      break;
    case "image-thinking":
      trace(`img-${event.index}`, `[${event.index + 1}] ${event.name}`, `视觉模型分析中（${event.model}）…`);
      break;
    case "image-facts": {
      trace(
        `img-${event.index}`,
        `[${event.index + 1}] ${event.name}`,
        `已提取视觉事实（${event.mode === "mock" ? "本地兜底" : `${event.ms}ms`}）`,
        "done",
      );
      if (event.reasoning) {
        const node = traceNodes.get(`img-${event.index}`);
        if (node) node.append(el("div", "reason", String(event.reasoning).replace(/\s+/g, " ").slice(0, 260)));
      }
      break;
    }
    case "image-cached":
      trace(`img-${event.index}`, `[${event.index + 1}] ${event.name}`, "命中缓存（同图 + 同清单 + 同模型）", "done");
      break;
    case "image-report":
      renderReport(event.report, thumbUrls[event.index]);
      state.tally[event.report.verdict] = (state.tally[event.report.verdict] ?? 0) + 1;
      state.tally.scores.push(event.report.score);
      if (event.cost) {
        state.tally.cost = (state.tally.cost ?? 0) + event.cost.total;
        state.tally.tokens = (state.tally.tokens ?? 0) + event.cost.tokens.total;
        $("m-cost").textContent = money(state.tally.cost);
        $("m-unit").textContent = `${state.tally.tokens.toLocaleString()} tok`;
      }
      if (event.report.counts.overturned) {
        trace(`img-${event.index}`, `[${event.index + 1}] ${event.report.image.name}`, `已应用 ${event.report.counts.overturned} 项人工推翻`, "done");
      }
      for (const result of event.report.results) {
        if (result.status !== "fail") continue;
        const entry = state.failedRules.get(result.title) ?? { count: 0, severity: result.severity };
        entry.count += 1;
        state.failedRules.set(result.title, entry);
      }
      updateSummary();
      break;
    case "consistency-start":
      trace("consistency", "多图一致性比对", `模型正在同时看 ${event.images} 张图…`, "thinking");
      break;
    case "consistency-report":
      renderConsistency(event.report);
      trace("consistency", "多图一致性完成", `${event.report.verdictLabel}（${event.report.counts.fail} 项不通过）`, "done");
      break;
    case "consistency-error":
      trace("consistency", "多图一致性跳过", event.message, "error");
      break;
    case "cost":
      renderBatchCost(event.cost);
      break;
    case "image-done":
      trace(`img-${event.index}`, `[${event.index + 1}] ${event.name}`, `判定完成：${event.score}/100`, "done");
      break;
    case "image-error":
      trace(`img-${event.index}`, `[${event.index + 1}] ${event.name}`, `失败：${event.message}`, "error");
      break;
    case "saved":
      if (event.dir) trace("saved", "报告已落盘", event.dir, "done");
      break;
    case "fatal":
      trace(`fatal-${Date.now()}`, "运行中断", event.message, "error");
      break;
    default:
      break;
  }
}

/* ---------------- render: cost & consistency ---------------- */

function renderBatchCost(cost) {
  if (!cost || cost.images === 0) {
    if (cost?.cached > 0) {
      $("m-cost").textContent = "$0（全部命中缓存）";
      $("m-unit").textContent = `${cost.cached} 张复用缓存，未产生费用`;
    } else {
      $("m-cost").textContent = "$0（本地兜底）";
      $("m-unit").textContent = "未调用模型";
    }
    return;
  }
  $("m-cost").textContent = money(cost.grandTotal, cost.currency);
  const cached = cost.tokens.cachedInput > 0 ? ` · 缓存命中 ${(cost.cachedRatio * 100).toFixed(0)}%` : "";
  const replayed = cost.cached > 0 ? ` · 复用 ${cost.cached} 张` : "";
  $("m-unit").textContent = `${money(cost.perImage, cost.currency)} / ${cost.tokensPerImage.toLocaleString()} tok${cached}${replayed}`;
  const projection = [1000, 10000, 100000]
    .map((volume) => `${volume.toLocaleString()} 张/月 → ${money(cost.perImage * volume, cost.currency)}`)
    .join("　");
  $("m-cost").title = `tokens 输入 ${cost.tokens.input} / 输出 ${cost.tokens.output}（含推理 ${cost.tokens.reasoning}）\n月度外推：${projection}`;
}

function renderConsistency(report) {
  const slot = $("consistency-slot");
  slot.innerHTML = "";
  const card = el("article", `card consistency ${report.verdict}`);
  const head = el("div", "card-head");
  const title = el("div", "card-title");
  title.append(el("h3", null, `多图一致性 · SKU 组（${report.group.size} 张）`));
  title.append(el("div", "meta", `通过 ${report.counts.pass} / 不通过 ${report.counts.fail} / 未判定 ${report.counts.unknown}`));
  if (report.model?.model) title.append(el("div", "meta", `${report.model.provider}/${report.model.model}`));
  const badge = el("div", `badge ${report.verdict}`);
  badge.append(el("div", "score", report.verdictLabel));
  badge.append(el("div", "verdict", report.color?.pairs?.length ? `ΔE ${Math.max(...report.color.pairs.map((p) => p.deltaE))}` : "无实测"));
  head.append(title, badge);
  card.append(head);

  const body = el("div", "card-body");
  if (report.summary) {
    const line = el("div", "summary-line");
    line.append(el("span", "tag", "模型概述"));
    line.append(document.createTextNode(report.summary));
    body.append(line);
  }
  if (report.conflicts?.length) {
    const box = el("div", "conflicts");
    for (const conflict of report.conflicts) box.append(el("div", "conflict", `⚠ ${conflict}`));
    body.append(box);
  }
  const table = el("table");
  const headRow = el("tr");
  for (const label of ["编号", "检查项", "严重度", "判定", "实测"]) headRow.append(el("th", null, label));
  const thead = el("thead");
  thead.append(headRow);
  const tbody = el("tbody");
  for (const rule of report.rules) {
    const row = el("tr", rule.status);
    row.append(el("td", null, rule.id));
    row.append(el("td", null, rule.title));
    row.append(el("td", null, SEVERITY_LABEL[rule.severity] ?? "中"));
    row.append(el("td", `status ${rule.status}`, STATUS_LABEL[rule.status] ?? rule.status));
    row.append(el("td", "observed", rule.observed));
    tbody.append(row);
  }
  table.append(thead, tbody);
  body.append(table);

  if (report.color?.pairs?.length) {
    const colors = el("div", "swatches");
    for (const pair of report.color.pairs) {
      const chip = el("div", "swatch");
      const a = el("span", "dot-color");
      a.style.background = pair.aHex;
      const b = el("span", "dot-color");
      b.style.background = pair.bHex;
      chip.append(a, b, el("span", null, `${pair.b} vs ${pair.a} · ΔE ${pair.deltaE}（${pair.label}）`));
      colors.append(chip);
    }
    body.append(colors);
  }
  card.append(body);
  slot.append(card);
}

/* ---------------- render: per-image report ---------------- */

function renderReport(report, thumbnailUrl) {
  const card = el("article", "card");

  const head = el("div", "card-head");
  const img = el("img", "card-thumb");
  if (thumbnailUrl) img.src = thumbnailUrl;
  img.alt = report.image.name;

  const title = el("div", "card-title");
  title.append(el("h3", null, report.image.name));
  title.append(el("div", "meta", `${report.image.width || "?"}×${report.image.height || "?"} · ${report.image.format} · ${report.image.fileSizeKB}KB · ${report.image.aspectLabel}`));
  const meta2 = [`${report.model.model ?? "—"}${report.cached ? " · 缓存命中" : ""}`];
  if (report.cost) meta2.push(`${money(report.cost.total, report.cost.currency)} · ${report.cost.tokens.total} tok`);
  if (report.counts.overturned) meta2.push(`人工推翻 ${report.counts.overturned} 项`);
  title.append(el("div", "meta", meta2.join(" · ")));

  const badge = el("div", `badge ${report.verdict}`);
  badge.append(el("div", "score", String(report.score)));
  badge.append(el("div", "verdict", report.verdictLabel));
  head.append(img, title, badge);

  const body = el("div", "card-body");
  if (report.model.summary) {
    const line = el("div", `summary-line${report.prompt.mode === "mock" ? " mock" : ""}`);
    line.append(el("span", "tag", report.prompt.mode === "mock" ? "本地兜底概述（非模型判断）" : "模型概述"));
    line.append(document.createTextNode(report.model.summary));
    body.append(line);
  }

  if (report.recommendations.length > 0) {
    const reco = el("div", "reco");
    for (const item of report.recommendations) {
      const row = el("div", `reco-item ${item.severity}`);
      row.append(el("div", "bar"));
      const text = el("div");
      text.append(el("b", null, `[${SEVERITY_LABEL[item.severity]}] ${item.title}`));
      text.append(document.createTextNode(`　实测 ${item.observed} · 要求 ${item.assertion}`));
      if (item.suggestion) text.append(el("div", "fix", `改法：${item.suggestion}`));
      row.append(text);
      reco.append(row);
    }
    body.append(reco);
  }

  const details = el("details", "rules");
  details.open = report.counts.fail > 0;
  details.append(el("summary", null, `逐条判定（通过 ${report.counts.pass} / 不通过 ${report.counts.fail} / 未判定 ${report.counts.unknown}${report.counts.overturned ? ` / 人工推翻 ${report.counts.overturned}` : ""}）`));
  const table = el("table");
  const headRow = el("tr");
  for (const label of ["编号", "检查项", "严重度", "判定", "实测", "要求", ""]) headRow.append(el("th", null, label));
  const thead = el("thead");
  thead.append(headRow);
  const tbody = el("tbody");
  for (const result of report.results) {
    const row = el("tr", result.status);
    row.append(el("td", null, result.id));
    row.append(el("td", null, result.title));
    row.append(el("td", null, SEVERITY_LABEL[result.severity] ?? "中"));
    const statusText = result.status === "overturned" ? `已推翻（原判 ${STATUS_LABEL[result.machineStatus] ?? result.machineStatus}）` : STATUS_LABEL[result.status] ?? result.status;
    row.append(el("td", `status ${result.status}`, statusText));
    row.append(el("td", "observed", result.observed));
    row.append(el("td", null, result.assertion));
    const action = el("td", "action");
    if (result.status === "fail") {
      const button = el("button", "ghost tiny", "推翻");
      button.title = "质检员认为这条判定不成立，记录后会回流成阈值调整依据";
      button.addEventListener("click", () => promptOverturn(report, result, row));
      action.append(button);
    } else if (result.overridden) {
      action.append(el("span", "muted", result.override.reasonLabel));
    }
    row.append(action);
    tbody.append(row);
  }
  table.append(thead, tbody);
  details.append(table);
  body.append(details);

  const foot = el("div", "card-foot");
  const copy = el("button", "ghost", "复制 Markdown 报告");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(report.markdown);
      copy.textContent = "已复制 ✓";
    } catch {
      copy.textContent = "复制失败，请用下载";
    }
    setTimeout(() => { copy.textContent = "复制 Markdown 报告"; }, 1600);
  });
  const download = el("button", "ghost", "下载 .md");
  download.addEventListener("click", () => {
    const blob = new Blob([report.markdown], { type: "text/markdown;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${report.image.name.replace(/\.[^.]+$/, "")}-qc.md`;
    link.click();
  });
  foot.append(copy, download);
  body.append(foot);

  card.append(head, body);
  $("stream").append(card);
  return card;
}

/* ---------------- wiring ---------------- */

$("dropzone").addEventListener("click", () => $("files").click());
$("files").addEventListener("change", (event) => addFiles(event.target.files));
for (const name of ["dragenter", "dragover"]) {
  $("dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    $("dropzone").classList.add("over");
  });
}
for (const name of ["dragleave", "drop"]) {
  $("dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    $("dropzone").classList.remove("over");
  });
}
$("dropzone").addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
$("run").addEventListener("click", run);
$("show-adjustments").addEventListener("click", loadAdjustments);

boot().catch((error) => {
  $("route-text").textContent = `初始化失败：${error.message}`;
  $("route-dot").className = "dot off";
});
