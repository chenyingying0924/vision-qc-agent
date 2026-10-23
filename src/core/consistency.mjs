/**
 * Multi-image consistency — "is this really the same SKU?"
 *
 * Two independent signals, deliberately kept apart:
 * 1. **Deterministic**: per-image subject colour (measured locally) compared with
 *    a perceptual colour distance (CIE76 ΔE in Lab space). No model, no cost,
 *    same answer every run.
 * 2. **Semantic**: one multi-image model call answering "same product? same
 *    colour? same details?" across the batch.
 *
 * Reporting both is the point: when they disagree, a human should look. A model
 * saying "colour matches" while ΔE is 32 is exactly the kind of thing a QC tool
 * exists to surface.
 *
 * @module vision-qc-agent/core/consistency
 */

/** sRGB → linear RGB → XYZ (D65) → Lab. */
function srgbToLab(r, g, b) {
  const toLinear = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [toLinear(r), toLinear(g), toLinear(b)];
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 colour difference between two RGB triplets (0 = identical, >10 = visible). */
export function deltaE(rgbA, rgbB) {
  const a = srgbToLab(...rgbA);
  const b = srgbToLab(...rgbB);
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

/**
 * Interpret a ΔE value the way a designer would.
 * Thresholds follow common practice: <2 imperceptible, 2-5 noticeable on close
 * inspection, >10 clearly a different colour.
 */
export function describeDelta(value) {
  if (value < 2) return { level: "imperceptible", label: "几乎不可感知" };
  if (value < 5) return { level: "slight", label: "细看可辨" };
  if (value < 10) return { level: "noticeable", label: "肉眼可辨" };
  return { level: "severe", label: "明显不是同一色" };
}

/**
 * Pairwise colour comparison across measured images.
 * @param {Array<{name: string, measurement: object}>} entries
 * @returns {{pairs: object[], baseline: object|null, comparable: number, note?: string}}
 */
export function compareSubjectColors(entries) {
  const usable = entries
    .map((entry) => ({
      name: entry.name,
      color: entry.measurement?.metrics?.subjectColor ?? null,
      coverage: entry.measurement?.metrics?.colorRatio ?? 0,
    }))
    .filter((entry) => entry.color && entry.color.coverage >= 0.05);

  if (usable.length < 2) {
    return {
      pairs: [],
      baseline: null,
      comparable: usable.length,
      note: "少于两张图有可用的主体色样本（需要至少 5% 的彩色像素），跳过确定性色差比对",
    };
  }

  // The first image is the reference: in e-commerce the main image defines truth.
  const baseline = usable[0];
  const pairs = usable.slice(1).map((entry) => {
    const value = deltaE(
      [baseline.color.r, baseline.color.g, baseline.color.b],
      [entry.color.r, entry.color.g, entry.color.b],
    );
    return {
      a: baseline.name,
      b: entry.name,
      deltaE: Number(value.toFixed(1)),
      ...describeDelta(value),
      aColor: [baseline.color.r, baseline.color.g, baseline.color.b],
      bColor: [entry.color.r, entry.color.g, entry.color.b],
      aHex: rgbToHex(baseline.color),
      bHex: rgbToHex(entry.color),
      aCoverage: baseline.coverage,
      bCoverage: entry.coverage,
    };
  });
  return { pairs, baseline, comparable: usable.length };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

/** Rules applied to the semantic answer; thresholds are explicit on purpose. */
const CONSISTENCY_RULES = [
  {
    id: "C01",
    title: "全组图片必须是同一件商品",
    severity: "high",
    fact: "sameProduct",
    expect: true,
    suggest: "把不同商品的图拆成各自的 SKU 组重跑；混组会让后续所有判定失去意义。",
  },
  {
    id: "C02",
    title: "组内颜色必须一致（无色差风险）",
    severity: "high",
    fact: "colorConsistency",
    expect: ["same", "slight-variation"],
    suggest: "统一白平衡与光源后重拍差异图；深色/浅色面料分别校准。",
  },
  {
    id: "C03",
    title: "材质与工艺细节必须一致",
    severity: "medium",
    fact: "detailConsistency",
    expect: ["same", "slight-variation"],
    suggest: "核对是否换版或用了不同样衣；细节图与主图不一致是最常见的退货诱因。",
  },
  {
    id: "C04",
    title: "光影与拍摄条件应一致",
    severity: "low",
    fact: "lightingConsistency",
    expect: ["same", "slight-variation"],
    suggest: "同组图尽量同一次拍摄完成，避免拼凑感。",
  },
];

/** Which roles are acceptable for each image in a group. */
function roleOverlap(roles) {
  const seen = new Map();
  for (const role of roles) seen.set(role.role, (seen.get(role.role) ?? 0) + 1);
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([role]) => role);
  return { duplicated, distinct: seen.size };
}

/**
 * Tolerate casing/whitespace drift in the model's enum answer, but never invent
 * a value: an unrecognised answer becomes `undefined`, which the caller already
 * turns into "未判定" rather than "不一致".
 */
function lenientEnum(raw, expect) {
  if (typeof raw !== "string") return raw;
  const allowed = [].concat(expect);
  const trimmed = raw.trim();
  if (allowed.includes(trimmed)) return trimmed;
  const squash = (text) => text.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return allowed.find((candidate) => squash(candidate) === squash(trimmed));
}

/** `sameProduct` from `"false"` / `"否"` instead of a JSON boolean. */
function lenientBool(raw) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const token = raw.trim().toLowerCase();
    if (["true", "1", "yes", "是"].includes(token)) return true;
    if (["false", "0", "no", "否"].includes(token)) return false;
  }
  return undefined;
}

/**
 * Evaluate the consistency findings for one SKU group.
 * @param {object} params
 * @param {Array<{name: string, measurement: object, report?: object}>} params.entries
 * @param {object} [params.semantic] - model answer (see {@link buildConsistencyPrompt}).
 * @param {object} [params.meta] - model provenance.
 * @returns {object} a consistency report.
 */
export function evaluateConsistency({ entries, semantic, meta = {} }) {
  const color = compareSubjectColors(entries);
  const rules = [];
  const answer = semantic ?? {};

  for (const rule of CONSISTENCY_RULES) {
    const raw = rule.fact === "sameProduct"
      ? lenientBool(answer[rule.fact])
      : lenientEnum(answer[rule.fact], rule.expect);
    if (raw === undefined || raw === null) {
      rules.push({
        id: rule.id,
        title: rule.title,
        severity: rule.severity,
        status: "unknown",
        observed: "未获得",
        assertion: `模型判定 ${rule.fact} ∈ ${[].concat(rule.expect).join(" / ")}`,
        suggestion: "多图比对未返回该字段，建议人工复核。",
      });
      continue;
    }
    const passed = [].concat(rule.expect).includes(raw);
    rules.push({
      id: rule.id,
      title: rule.title,
      severity: rule.severity,
      status: passed ? "pass" : "fail",
      observed: String(raw),
      assertion: `模型判定 ${rule.fact} ∈ ${[].concat(rule.expect).join(" / ")}`,
      suggestion: passed ? "" : rule.suggest,
    });
  }

  // Deterministic colour rule, evaluated locally and cross-checked.
  const worst = color.pairs.reduce((acc, pair) => (acc === null || pair.deltaE > acc.deltaE ? pair : acc), null);
  if (worst) {
    const limit = 10;
    const passed = worst.deltaE < limit;
    rules.push({
      id: "C05",
      title: `实测主体色差 ΔE < ${limit}`,
      // Measured colour divergence is a hard defect: unlike the model's opinion it
      // cannot be argued away, so it outranks the semantic rules.
      severity: "high",
      status: passed ? "pass" : "fail",
      observed: `ΔE=${worst.deltaE}（${worst.b} vs ${worst.a}）`,
      assertion: `主体色 CIE76 色差 < ${limit}（实测优先于模型判断）`,
      suggestion: passed ? "" : "两张图的主体色实测差异已超过肉眼可辨阈值，优先按实测结论处理。",
      deterministic: true,
    });
  }

  // Report role coverage: a detail page group needs a hero image, and duplicate
  // roles usually mean the batch was assembled wrong.
  const roles = (answer.imageRoles ?? []).filter(Boolean);
  const roleInfo = roles.length ? roleOverlap(roles) : null;

  // Model vs measurement disagreement is the most valuable output of this check.
  const conflicts = [];
  if (answer.colorConsistency === "same" && worst && worst.deltaE >= 10) {
    conflicts.push(
      `模型判定「颜色一致」，但实测主体色差 ΔE=${worst.deltaE}（${worst.aHex} vs ${worst.bHex}）落在肉眼可辨区间 —— 以实测为准，建议人工确认。`,
    );
  }
  if (answer.colorConsistency && answer.colorConsistency !== "same" && worst && worst.deltaE < 5) {
    conflicts.push(
      `模型判定存在色差，但实测 ΔE=${worst.deltaE} 处于细看才可辨的水平 —— 可能是拍摄条件差异被误判为商品色差。`,
    );
  }

  const failures = rules.filter((rule) => rule.status === "fail");
  const highFails = failures.filter((rule) => rule.severity === "high").length;
  const verdict = highFails > 0 ? "fail" : failures.length > 0 ? "warn" : rules.every((rule) => rule.status === "unknown") ? "unknown" : "pass";

  return {
    group: { size: entries.length, names: entries.map((entry) => entry.name) },
    verdict,
    verdictLabel: { pass: "一致", warn: "存在差异", fail: "不一致", unknown: "无法判定" }[verdict],
    counts: {
      pass: rules.length - failures.length - rules.filter((rule) => rule.status === "unknown").length,
      fail: failures.length,
      unknown: rules.filter((rule) => rule.status === "unknown").length,
      total: rules.length,
    },
    rules,
    color,
    roles: roleInfo,
    conflicts,
    summary: String(answer.summary ?? ""),
    model: { provider: meta.provider ?? null, model: meta.model ?? null, ms: meta.ms ?? null, usage: meta.usage ?? null },
  };
}

/**
 * Build the multi-image comparison prompt.
 * @param {object} params
 * @param {Array<{name: string, measurement: object, report?: object}>} params.entries
 * @returns {{system: string, user: string}} prompt halves.
 */
export function buildConsistencyPrompt({ entries }) {
  const system = [
    "你是一名电商视觉一致性审核员。你会看到同一 SKU 组的多张图片（按顺序编号），需要判断它们是否真的描述同一件商品。",
    "",
    "输出要求：只输出一个 JSON 对象，不要代码块标记，不要解释性文字。字段如下：",
    '- "sameProduct": true/false —— 是否同一件商品（不同款、不同颜色算 false）',
    '- "colorConsistency": "same" | "slight-variation" | "different"',
    '- "detailConsistency": "same" | "slight-variation" | "different" —— 材质、工艺、版型细节是否一致',
    '- "lightingConsistency": "same" | "slight-variation" | "different"',
    '- "imageRoles": 字符串数组，与图片顺序一一对应，取值 "hero" | "scene" | "detail" | "parameter" | "size-chart" | "packaging" | "banner" | "other"',
    '- "notes": 字符串数组，逐条列出你观察到的具体差异（没有则给空数组）',
    '- "summary": 一句话中文总结（60 字以内）',
    '- "confidence": 0-1 的置信度',
    "",
    "判断原则：只依据你实际看到的画面；差异很小但仍可察觉时选 slight-variation；无法确定时选最保守的结论并在 notes 中说明。",
  ].join("\n");

  const lines = [
    `这是一个 SKU 组的 ${entries.length} 张图片，顺序如下：`,
    "",
  ];
  entries.forEach((entry, index) => {
    const parts = [`${index + 1}. ${entry.name}`];
    if (entry.measurement?.width) parts.push(`${entry.measurement.width}×${entry.measurement.height}`);
    const judged = entry.report?.facts ?? {};
    const hints = [];
    if (judged.mainSubjectPromise) hints.push(`主体呈现=${judged.mainSubjectPromise}`);
    if (judged.colorAccuracyRisk) hints.push(`单图色差风险=${judged.colorAccuracyRisk}`);
    if (judged.lightingQuality) hints.push(`布光=${judged.lightingQuality}`);
    if (judged.imageRole) hints.push(`已判用途=${judged.imageRole}`);
    if (hints.length) parts.push(hints.join("，"));
    lines.push(`- ${parts.join("　|　")}`);
  });
  const measured = entries
    .map((entry) => {
      const color = entry.measurement?.metrics?.subjectColor;
      return color
        ? `- ${entry.name}：主体色约 #${rgbToHex(color).slice(1)}（覆盖 ${(color.coverage * 100).toFixed(0)}% 的像素）`
        : `- ${entry.name}：无可提取的主体色（画面缺少彩色区域）`;
    })
    .join("\n");
  lines.push("", "以下是程序实测的主体色，可作为参考，但不要仅凭数值下结论：", measured);

  return { system, user: lines.join("\n") };
}

/** Render the consistency report as Markdown. */
export function renderConsistencyMarkdown(report, groupName = "SKU 组") {
  const icon = { pass: "✅", warn: "⚠️", fail: "❌", unknown: "❓" }[report.verdict] ?? "";
  const lines = [];
  lines.push(`# 多图一致性报告：${groupName}`);
  lines.push("");
  lines.push(`**结论：${icon} ${report.verdictLabel}**`);
  lines.push("");
  lines.push(`- 图片数：${report.group.size}`);
  lines.push(`- 检查项：通过 ${report.counts.pass} / 不通过 ${report.counts.fail} / 未判定 ${report.counts.unknown}`);
  if (report.model?.model) lines.push(`- 视觉模型：${report.model.provider}/${report.model.model}`);
  if (report.summary) {
    lines.push("");
    lines.push(`> ${report.summary}`);
  }
  lines.push("");
  lines.push("## 逐项判定");
  lines.push("");
  lines.push("| 编号 | 检查项 | 严重度 | 判定 | 实测 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const rule of report.rules) {
    const mark = { pass: "通过", fail: "不通过", unknown: "未判定" }[rule.status];
    lines.push(`| ${rule.id} | ${rule.title} | ${rule.severity} | ${mark} | ${rule.observed} |`);
  }
  if (report.color?.pairs?.length) {
    lines.push("");
    lines.push("## 实测色差（CIE76 ΔE，本地像素计算）");
    lines.push("");
    lines.push("| 对比 | 参考色 | 对比色 | ΔE | 判断 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const pair of report.color.pairs) {
      lines.push(`| ${pair.b} vs ${pair.a} | ${pair.aHex} | ${pair.bHex} | ${pair.deltaE} | ${pair.label} |`);
    }
  } else if (report.color?.note) {
    lines.push("");
    lines.push(`_实测色差跳过：${report.color.note}_`);
  }
  if (report.conflicts?.length) {
    lines.push("");
    lines.push("## 模型判断与实测结论冲突（需人工确认）");
    lines.push("");
    for (const conflict of report.conflicts) lines.push(`- ${conflict}`);
  }
  const failures = report.rules.filter((rule) => rule.status === "fail");
  if (failures.length) {
    lines.push("");
    lines.push("## 整改建议");
    lines.push("");
    for (const rule of failures) {
      lines.push(`- **[${rule.severity}] ${rule.title}**（实测 ${rule.observed}）`);
      if (rule.suggestion) lines.push(`  - 改法：${rule.suggestion}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("_一致性由「本地像素实测 + 一次多图语义比对」双重校验；两者冲突时以实测为准并提示人工复核。_");
  return lines.join("\n");
}

export { rgbToHex };
