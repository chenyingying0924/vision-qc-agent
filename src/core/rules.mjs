/**
 * Checklist loading, validation and the deterministic rule engine.
 *
 * Design choice worth defending in a review: the model is used for *perception*
 * (structured visual facts) and the rules are evaluated in plain JavaScript.
 * That keeps verdicts reproducible, makes "why did this fail?" auditable, and
 * means editing a threshold costs zero tokens and zero latency.
 *
 * @module vision-qc-agent/core/rules
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENUM_HINTS, FACT_CATALOG } from "./facts.mjs";

export const SEVERITY_WEIGHT = { high: 10, medium: 5, low: 2 };
export const OPERATORS = [">=", ">", "<=", "<", "==", "!=", "in", "between", "judge"];

const ORDERED_OPERATORS = {
  ">=": (a, b) => a >= b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  "<": (a, b) => a < b,
};

/** Load every checklist in a directory, sorted for stable UI order. */
export function loadChecklists(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return files
    .map((name) => validateChecklist(JSON.parse(readFileSync(join(dir, name), "utf8")), name))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** Validate one checklist document and fill defaults. Throws on structural errors. */
export function validateChecklist(doc, origin = "inline") {
  if (!doc || typeof doc !== "object") throw new Error(`${origin}: checklist must be an object`);
  if (typeof doc.id !== "string" || doc.id.length === 0) throw new Error(`${origin}: checklist.id is required`);
  if (typeof doc.name !== "string" || doc.name.length === 0) throw new Error(`${origin}: checklist.name is required`);
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    throw new Error(`${origin}: checklist.rules must be a non-empty array`);
  }
  const seen = new Set();
  const rules = doc.rules.map((rule, index) => {
    const where = `${origin}: rule[${index}]`;
    if (typeof rule.id !== "string" || rule.id.length === 0) throw new Error(`${where}.id is required`);
    if (seen.has(rule.id)) throw new Error(`${where}.id "${rule.id}" is duplicated`);
    seen.add(rule.id);
    if (typeof rule.title !== "string" || rule.title.length === 0) throw new Error(`${where}.title is required`);
    const fact = FACT_CATALOG[rule.fact];
    if (!fact) throw new Error(`${where}.fact "${rule.fact}" is not in the fact catalogue`);
    if (!OPERATORS.includes(rule.op)) throw new Error(`${where}.op "${rule.op}" must be one of ${OPERATORS.join(", ")}`);
    if (rule.severity !== undefined && !(rule.severity in SEVERITY_WEIGHT)) {
      throw new Error(`${where}.severity must be one of ${Object.keys(SEVERITY_WEIGHT).join(", ")}`);
    }
    if (rule.op === "between" && (!Array.isArray(rule.value) || rule.value.length !== 2)) {
      throw new Error(`${where}.value must be a [min, max] pair for the "between" operator`);
    }
    if (rule.op === "between") {
      const [low, high] = rule.value;
      if (!Number.isFinite(low) || !Number.isFinite(high)) {
        throw new Error(`${where}.value must contain two finite numbers for the "between" operator`);
      }
      if (low > high) throw new Error(`${where}.value must be ordered [min, max]; got [${low}, ${high}]`);
    }
    if (rule.op === "in" && !Array.isArray(rule.value)) {
      throw new Error(`${where}.value must be an array for the "in" operator`);
    }
    if (rule.op === "in" && rule.value.length === 0) {
      throw new Error(`${where}.value must not be empty for the "in" operator`);
    }
    // Ordered comparisons against a non-number used to silently score against 0
    // (`target = typeof value === "number" ? value : 0`), i.e. `{op:">=",value:"800"}`
    // became `>= 0` and always passed while the report still printed ">= 800".
    if (ORDERED_OPERATORS[rule.op] && !Number.isFinite(rule.value)) {
      throw new Error(`${where}.value must be a finite number for the "${rule.op}" operator; got ${JSON.stringify(rule.value)}`);
    }
    if ((rule.op === "==" || rule.op === "!=") && rule.value === undefined) {
      throw new Error(`${where}.value is required for the "${rule.op}" operator`);
    }
    const worst = rule.severity ?? "medium";
    return {
      why: "",
      suggest: "",
      source: fact.source,
      group: "未分组",
      ...rule,
      weight: rule.weight ?? SEVERITY_WEIGHT[worst],
    };
  });
  return {
    $schema: doc.$schema ?? "vision-qc-agent/checklist@1",
    id: doc.id,
    name: doc.name,
    version: doc.version ?? "0.0.0",
    description: doc.description ?? "",
    meta: doc.meta ?? {},
    rules,
  };
}

/** Facts available to rules for one image: pipeline measurements + model output. */
export function factBag(measurement, modelFacts = {}) {
  const metrics = measurement.metrics ?? {};
  const pipeline = {
    format: measurement.format,
    width: measurement.width,
    height: measurement.height,
    minSide: Math.min(measurement.width || 0, measurement.height || 0),
    megapixels: measurement.megapixels,
    fileSizeKB: Math.round(measurement.bytes / 1024),
    aspectLabel: measurement.aspectLabel,
    backgroundWhiteness: metrics.borderWhiteness === undefined ? undefined : Math.round(metrics.borderWhiteness * 1000) / 10,
    backgroundUniformity:
      metrics.borderSd === undefined ? undefined : Math.round(Math.max(0, 100 - metrics.borderSd * 2) * 10) / 10,
    centerCoverage: metrics.centerInkRatio === undefined ? undefined : Math.round(metrics.centerInkRatio * 1000) / 10,
    saturationRatio: metrics.saturationRatio === undefined ? undefined : Math.round(metrics.saturationRatio * 1000) / 10,
    brightnessSd: metrics.lumaSd === undefined ? undefined : Math.round(Math.min(100, metrics.lumaSd) * 10) / 10,
  };
  const model = {};
  for (const [key, value] of Object.entries(modelFacts ?? {})) {
    if (value === null || value === undefined) continue;
    model[key] = value;
  }
  // Pipeline measurements win over the model for the same key: they are ground truth.
  return { ...model, ...pipeline, metrics };
}

function normalizeScore(raw, fact) {
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  if (fact.kind === "percent") {
    // The prompt asks for 0-100, but models occasionally answer "0.85" for 85%.
    // Only *fractional* values below 1 are rescaled: an integer 1 is a real 1%,
    // and silently turning it into 100% would flip a rule for the wrong reason.
    return raw > 0 && raw < 1 && !Number.isInteger(raw) ? raw * 100 : raw;
  }
  return raw;
}

/**
 * Score one fact value against one rule on a 0-100 scale.
 *
 * Contract: a satisfied assertion scores 100, so `status === "pass"` and
 * `score === 100` agree. Values that miss the threshold degrade proportionally
 * instead of dropping to zero — that is what makes the aggregate score
 * comparable between "just under" and "wildly wrong".
 */
export function scoreAgainst(raw, rule, fact) {
  const numeric = normalizeScore(raw, fact);
  const target = typeof rule.value === "number" ? rule.value : 0;
  switch (rule.op) {
    case ">=":
    case ">": {
      if (typeof numeric !== "number") return 0;
      // Strict and inclusive operators must not collapse to the same check at
      // the boundary; `> 800` is false for exactly 800.
      const satisfied = rule.op === ">" ? numeric > target : numeric >= target;
      if (satisfied) return 100;
      const floor = rule.floor ?? Math.min(0, target);
      if (floor === target) return 0;
      return Math.max(0, Math.round(((numeric - floor) / (target - floor)) * 100));
    }
    case "<=":
    case "<": {
      // `fact` is a "badness" metric: smaller is better.
      if (typeof numeric !== "number") return 0;
      const ceiling = rule.ceiling ?? Math.max(target * 3, target + 1);
      const satisfied = rule.op === "<" ? numeric < target : numeric <= target;
      if (satisfied) return 100;
      if (numeric >= ceiling) return 0;
      return Math.max(0, Math.round(((ceiling - numeric) / (ceiling - target)) * 100));
    }
    case "between": {
      const [min, max] = rule.value;
      if (typeof numeric !== "number") return 0;
      if (numeric >= min && numeric <= max) return 100;
      const span = Math.max(max - min, 1);
      const distance = numeric < min ? min - numeric : numeric - max;
      return Math.max(0, Math.round((1 - distance / span) * 100));
    }
    case "==": {
      if (typeof rule.value === "boolean") return raw === rule.value ? 100 : 0;
      if (typeof rule.value === "number") {
        if (typeof numeric !== "number") return 0;
        const tolerance = rule.tolerance ?? Math.max(1, Math.abs(rule.value) * 0.1);
        return Math.abs(numeric - rule.value) <= tolerance ? 100 : 0;
      }
      return raw === rule.value ? 100 : 0;
    }
    case "!=":
      return raw !== rule.value ? 100 : 0;
    case "in":
      if (!Array.isArray(rule.value)) return 0;
      return rule.value.some((allowed) => allowed === raw || (typeof allowed === "number" && allowed === numeric))
        ? 100
        : 0;
    case "judge":
      if (raw === true) return 100;
      if (raw === false) return 0;
      if (typeof numeric === "number") return Math.max(0, Math.min(100, numeric));
      return 0;
    default:
      return 0;
  }
}

/** Describe the assertion in the report, e.g. `背景白度 >= 92%`. */
function expressAssertion(rule) {
  const label = FACT_CATALOG[rule.fact]?.label ?? rule.fact;
  if (rule.op === "judge") return `${label}：需要模型判定通过`;
  if (rule.op === "in") return `${label} ∈ {${[].concat(rule.value).join(" / ")}}`;
  if (rule.op === "between") return `${label} ∈ [${rule.value[0]}, ${rule.value[1]}]`;
  return `${label} ${rule.op} ${rule.value}${rule.unit ?? ""}`;
}

function formatObserved(raw, rule) {
  if (raw === undefined || raw === null) return "未获得";
  if (typeof raw === "boolean") return raw ? "是" : "否";
  if (typeof raw === "number") return `${raw}${rule.unit ?? ""}`;
  return String(raw);
}

/** Explain an un-obtainable fact so the report never shows a bare "unknown". */
function missingFactMessage(rule) {
  const descriptor = FACT_CATALOG[rule.fact];
  const label = descriptor?.label ?? rule.fact;
  const source =
    descriptor?.source === "pipeline"
      ? "本地像素测量未取得该指标（例如非 PNG 无法本地解码）"
      : "视觉模型本次未返回该字段";
  return `${label}未能取得判定数据（${source}），建议人工复核。`;
}

/**
 * Append the human-readable meaning of an enum value to the suggested fix, so a
 * report says "文字过多，会遮挡商品主体" instead of only "heavy".
 */
function withEnumHint(rule, raw, suggest) {
  const hints = ENUM_HINTS[rule.fact];
  const hint = hints && typeof raw === "string" ? hints[raw] : undefined;
  if (!hint) return suggest;
  const base = String(suggest ?? "").replace(/[。.]$/, "");
  return `${base ? `${base}；` : ""}当前判定值「${raw}」的含义：${hint}。`;
}

/**
 * Evaluate one checklist against one image.
 * @param {object} params
 * @param {object} params.checklist - validated checklist.
 * @param {object} params.measurement - output of {@link import("../image/inspect.mjs").measure}.
 * @param {object} [params.modelFacts] - structured facts returned by the vision model.
 * @param {object} [params.modelMeta] - `{reason, confidence, model, ms, usage}` for provenance.
 * @returns {object} the evaluated report body (no rendering).
 */
export function evaluate({ checklist, measurement, modelFacts = {}, modelMeta = {} }) {
  const bag = factBag(measurement, modelFacts);
  const results = checklist.rules.map((rule) => {
    const raw = bag[rule.fact];
    if (raw === undefined || raw === null) {
      return {
        id: rule.id,
        group: rule.group,
        title: rule.title,
        why: rule.why,
        severity: rule.severity ?? "medium",
        weight: rule.weight,
        status: "unknown",
        observed: "未获得",
        assertion: expressAssertion(rule),
        score: 0,
        suggestion: missingFactMessage(rule),
        source: rule.source,
        reason: "",
      };
    }
    const score = scoreAgainst(raw, rule, FACT_CATALOG[rule.fact] ?? { kind: "enum" });
    const passed = score >= (rule.threshold ?? 100);
    return {
      id: rule.id,
      group: rule.group,
      title: rule.title,
      why: rule.why,
      severity: rule.severity ?? "medium",
      weight: rule.weight,
      status: passed ? "pass" : "fail",
      observed: formatObserved(raw, rule),
      assertion: expressAssertion(rule),
      score,
      suggestion: passed ? "" : withEnumHint(rule, raw, rule.suggest),
      source: rule.source,
      reason: rule.op === "judge" ? String(modelFacts[`${rule.fact}Reason`] ?? "") : "",
    };
  });

  const graded = results.filter((result) => result.status !== "unknown");
  const maxPoints = graded.reduce((sum, result) => sum + result.weight, 0);
  const earnedPoints = graded.reduce((sum, result) => sum + (result.weight * result.score) / 100, 0);
  const score = maxPoints === 0 ? 0 : Math.round((earnedPoints / maxPoints) * 100);

  const failures = results.filter((result) => result.status === "fail");
  const highFails = failures.filter((result) => result.severity === "high").length;
  const mediumFails = failures.filter((result) => result.severity === "medium").length;
  const lowFails = failures.length - highFails - mediumFails;
  const unknown = results.filter((result) => result.status === "unknown").length;

  let verdict = "pass";
  if (highFails > 0 || mediumFails >= 3) verdict = "fail";
  else if (mediumFails > 0 || lowFails >= 2) verdict = "warn";
  if (graded.length === 0) verdict = "unknown";

  const recommendations = failures
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((result) => ({
      id: result.id,
      severity: result.severity,
      title: result.title,
      observed: result.observed,
      assertion: result.assertion,
      suggestion: result.suggestion,
    }));

  return {
    score,
    verdict,
    verdictLabel: { pass: "合格", warn: "需优化", fail: "不合格", unknown: "无法判定" }[verdict],
    counts: {
      pass: results.filter((result) => result.status === "pass").length,
      fail: failures.length,
      unknown,
      total: results.length,
    },
    severityBreakdown: { high: highFails, medium: mediumFails, low: lowFails },
    results,
    recommendations,
    checklist: {
      id: checklist.id,
      name: checklist.name,
      version: checklist.version,
      meta: checklist.meta,
    },
    model: {
      provider: modelMeta.provider ?? null,
      model: modelMeta.model ?? null,
      ms: modelMeta.ms ?? null,
      usage: modelMeta.usage ?? null,
      summary: String(modelMeta.reason ?? modelFacts.summary ?? ""),
      confidence: typeof modelMeta.confidence === "number" ? modelMeta.confidence : null,
      /** Values the model returned outside the fact catalogue, and what was coerced. */
      normalized: modelMeta.normalized ?? null,
    },
  };
}

/** Render an evaluated report as Markdown for download / commit. */
export function renderMarkdown(report) {
  const icon = { pass: "✅", fail: "❌", warn: "⚠️", unknown: "❓" }[report.verdict] ?? "";
  const lines = [];
  lines.push(`# 视觉质检报告：${report.image.name}`);
  lines.push("");
  lines.push(`**结论：${icon} ${report.verdictLabel}（${report.score}/100）**`);
  lines.push("");
  lines.push(`- 检查项：通过 ${report.counts.pass} / 不通过 ${report.counts.fail} / 未判定 ${report.counts.unknown}（共 ${report.counts.total}）`);
  if (report.counts.overturned > 0) {
    lines.push(`- 人工推翻：${report.counts.overturned} 项（以质检员判定为准，机器原判保留为 machineStatus）`);
  }
  lines.push(`- 清单：${report.checklist.name} v${report.checklist.version}`);
  if (report.cost) {
    lines.push(`- 本次成本：${report.cost.currency} ${report.cost.total.toFixed(6)} · ${report.cost.tokens.total} tokens`);
  }
  if (report.image.width) {
    lines.push(`- 图像：${report.image.width}×${report.image.height} · ${report.image.format} · ${report.image.fileSizeKB} KB`);
  }
  if (report.model?.model) {
    lines.push(`- 视觉模型：${report.model.provider}/${report.model.model}`);
  }
  if (report.model?.summary) {
    lines.push("");
    lines.push(`> 模型概述：${report.model.summary}`);
  }
  const droppedFields = report.model?.normalized?.dropped ?? [];
  if (droppedFields.length > 0) {
    lines.push("");
    lines.push(`> 模型返回了 ${droppedFields.length} 个不在事实目录内的字段，已丢弃并按「未判定」处理：${droppedFields.join("、")}`);
  }
  lines.push("");
  lines.push("## 逐项判定");
  lines.push("");
  lines.push("| 编号 | 检查项 | 严重度 | 判定 | 实测 | 要求 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const result of report.results) {
    const mark = { pass: "通过", fail: "不通过", unknown: "未判定", overturned: `已推翻（原判 ${result.machineStatus}）` }[result.status] ?? result.status;
    lines.push(
      `| ${result.id} | ${result.title} | ${result.severity} | ${mark} | ${result.observed} | ${result.assertion} |`,
    );
  }
  const overrides = report.results.filter((result) => result.overridden);
  if (overrides.length > 0) {
    lines.push("");
    lines.push("## 人工推翻记录");
    lines.push("");
    for (const result of overrides) {
      lines.push(
        `- **${result.id} ${result.title}**：${result.override.reasonLabel}${result.override.note ? ` —— ${result.override.note}` : ""}（${result.override.reviewer}，${result.override.at.slice(0, 10)}）`,
      );
    }
  }
  if (report.recommendations.length > 0) {
    lines.push("");
    lines.push("## 整改建议（按严重度排序）");
    lines.push("");
    for (const item of report.recommendations) {
      lines.push(`- **[${item.severity}] ${item.title}**（实测 ${item.observed}，要求 ${item.assertion}）`);
      if (item.suggestion) lines.push(`  - 改法：${item.suggestion}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("_由 vision-qc-agent 生成：视觉事实由多模态模型提取，规则判定在本地确定性执行。_");
  return lines.join("\n");
}
