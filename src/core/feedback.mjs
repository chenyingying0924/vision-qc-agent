/**
 * Human-in-the-loop: reviewers overturn verdicts, and the overturns become evidence.
 *
 * This is the piece that turns a demo into something an operations team would
 * actually adopt. An inspector who disagrees with a rule clicks "推翻", gives a
 * reason, and the record is appended to an append-only JSONL log. From that log
 * the system derives two things it could never get from the model alone:
 *
 * 1. **Rule reliability** — how often each rule is overturned (a rule overturned
 *    40% of the time is a badly written rule, not a bad model).
 * 2. **Threshold advice** — for numeric rules, the observed values of overturned
 *    cases suggest where the threshold should move. The system *proposes*; a
 *    human still edits the checklist, because silently retuning a QC standard
 *    from feedback is how you get a rule that passes everything.
 *
 * @module vision-qc-agent/core/feedback
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACT_CATALOG } from "./facts.mjs";

/** Reasons a reviewer may cite; kept small so the log stays analysable. */
export const OVERTURN_REASONS = {
  "threshold-wrong": "阈值不合理（业务上可接受）",
  "fact-wrong": "视觉事实判断错误",
  "rule-misapplied": "规则不适用这类商品",
  "business-exception": "业务特批（上新/清仓等）",
  "duplicate": "与其他检查项重复",
  "other": "其他",
};

const LINE = JSON.stringify;

/**
 * Append-only store for overturn records.
 */
export class FeedbackStore {
  /**
   * @param {string} [path] - JSONL file; defaults to `<appRoot>/data/feedback.jsonl`.
   */
  constructor(path) {
    this.path = path ?? join(process.cwd(), "data", "feedback.jsonl");
    this.records = [];
    this.reload();
  }

  /** Read the log from disk into memory (idempotent). */
  reload() {
    if (!existsSync(this.path)) {
      this.records = [];
      return this.records;
    }
    this.records = readFileSync(this.path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    return this.records;
  }

  /**
   * Record one overturn.
   * @param {object} input
   * @param {string} input.imageName - which image.
   * @param {string} input.ruleId - which rule was overturned.
   * @param {string} [input.originalStatus] - verdict before the overturn (`fail`).
   * @param {string} [input.reason] - one of {@link OVERTURN_REASONS}.
   * @param {string} [input.note] - free text from the reviewer.
   * @param {string} [input.reviewer] - who did it.
   * @param {string} [input.observed] - the measured value the reviewer disagreed with.
   * @param {object} [input.context] - `{checklistId, assertion, value, op, severity}`.
   * @returns {object} the stored record.
   */
  record({
    imageName,
    ruleId,
    originalStatus = "fail",
    reason = "other",
    note = "",
    reviewer = "anonymous",
    observed,
    context = {},
  }) {
    if (!imageName || !ruleId) throw new Error("feedback: imageName 与 ruleId 必填");
    if (!(reason in OVERTURN_REASONS)) throw new Error(`feedback: 未知原因 "${reason}"`);
    // Re-read before appending: the file may have been edited or replaced while
    // the process was running, and the in-memory list must not drift from it.
    this.reload();
    const entry = {
      at: new Date().toISOString(),
      imageName,
      ruleId,
      originalStatus,
      reason,
      note: String(note).slice(0, 500),
      reviewer,
      checklistId: context.checklistId ?? null,
      observed: observed ?? context.observed ?? null,
      assertion: context.assertion ?? null,
      op: context.op ?? null,
      ruleValue: context.value ?? null,
      severity: context.severity ?? null,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${LINE(entry)}\n`, "utf8");
    this.records.push(entry);
    return entry;
  }

  /**
   * Overturns that apply to one image, optionally scoped to a checklist.
   *
   * Rule ids are reused across checklists (every checklist has an R05), so an
   * overturn recorded for the main-image checklist must not silently rewrite a
   * detail-page verdict. Records without a checklist id stay global.
   */
  forImage(imageName, checklistId) {
    const needle = String(imageName).toLowerCase();
    return this.records.filter(
      (record) =>
        record.imageName.toLowerCase() === needle &&
        (checklistId === undefined || record.checklistId === null || record.checklistId === checklistId),
    );
  }

  /** Group counts by rule id, optionally scoped to one checklist. */
  byRule(checklistId) {
    const groups = new Map();
    for (const record of this.records) {
      if (checklistId !== undefined && record.checklistId !== null && record.checklistId !== checklistId) continue;
      const group = groups.get(record.ruleId) ?? { ruleId: record.ruleId, count: 0, reasons: {}, latest: record.at, samples: [] };
      group.count += 1;
      group.reasons[record.reason] = (group.reasons[record.reason] ?? 0) + 1;
      group.latest = record.at > group.latest ? record.at : group.latest;
      if (group.samples.length < 5) group.samples.push({ imageName: record.imageName, observed: record.observed, note: record.note });
      groups.set(record.ruleId, group);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }

  /** Total overturn count, for the batch panel. */
  get size() {
    return this.records.length;
  }
}

/**
 * Turn the overturn log into threshold advice for one checklist.
 *
 * Only numeric assertions produce a number; everything else yields a
 * qualitative recommendation (rewrite the rule, restrict its category, or keep
 * it as a hard rule and stop overturning it).
 *
 * @param {object} params
 * @param {object} params.checklist - validated checklist.
 * @param {FeedbackStore} params.store - the log.
 * @param {object} [params.options]
 * @param {number} [params.options.minSamples] - overturns needed before advising.
 * @param {number} [params.options.thresholdRate] - share of a rule's failures that must be overturned to advise.
 * @param {Map<string, number>} [params.options.failuresByRule] - failure counts from a real batch, for the rate.
 * @returns {Array<object>} one suggestion per rule with enough evidence.
 */
export function suggestAdjustments({ checklist, store, options = {} }) {
  const minSamples = options.minSamples ?? 2;
  const thresholdRate = options.thresholdRate ?? 0.3;
  const failuresByRule = options.failuresByRule ?? new Map();
  const suggestions = [];

  for (const group of store.byRule(checklist.id)) {
    const rule = checklist.rules.find((entry) => entry.id === group.ruleId);
    if (!rule) continue;
    const failures = failuresByRule.get(rule.id) ?? 0;
    const rate = failures > 0 ? group.count / failures : null;
    const enough = group.count >= minSamples;
    const tooOften = rate === null || rate >= thresholdRate;
    if (!enough && !tooOften) continue;

    const reasonTop = Object.entries(group.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
    const numeric = typeof rule.value === "number" && Number.isFinite(rule.value);
    const observations = group.samples
      .map((sample) => Number(String(sample.observed ?? "").replace(/[^\d.-]/g, "")))
      .filter((value) => Number.isFinite(value));

    // Evidence gate: either enough overturns to speak, or a genuinely high
    // overturn rate among real failures. A single overturn with no failure
    // statistics is not yet a signal, and saying otherwise would train people
    // to ignore the advice.
    if (group.count < minSamples && !(failures > 0 && rate >= thresholdRate)) continue;

    const suggestion = {
      ruleId: rule.id,
      title: rule.title,
      overturns: group.count,
      failures,
      overturnRate: rate === null ? null : Number(rate.toFixed(2)),
      topReason: reasonTop,
      topReasonLabel: OVERTURN_REASONS[reasonTop],
      fact: rule.fact,
      factKind: FACT_CATALOG[rule.fact]?.kind ?? null,
      currentValue: rule.value,
      op: rule.op,
      confidence: "low",
      advice: "",
      proposedValue: null,
      samples: group.samples,
    };

    if (numeric && observations.length > 0 && (rule.op === ">=" || rule.op === ">")) {
      // Reviewers accepted values below the threshold: the threshold is probably
      // too strict. Propose the median of the accepted values, rounded.
      const sorted = observations.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const proposed = Math.floor(median);
      suggestion.proposedValue = proposed;
      suggestion.advice = `业务上接受了低至 ${sorted[0]}${rule.unit ?? ""} 的样本（中位数 ${median}${rule.unit ?? ""}）。建议把阈值从 ${rule.value}${rule.unit ?? ""} 下调到约 ${proposed}${rule.unit ?? ""}，或改为按商品类目分档。下调属于放宽标准，需质检负责人确认后手工修改 checklists/${checklist.id}.json。`;
      suggestion.confidence = group.count >= 5 ? "medium" : "low";
    } else if (numeric && (rule.op === "<=" || rule.op === "<")) {
      suggestion.advice = `该"上限型"规则被多次推翻，说明上限可能过严。请人工评估是否放宽（当前上限 ${rule.value}${rule.unit ?? ""}）。`;
    } else if (rule.op === "==" || rule.op === "in") {
      suggestion.advice = `该"枚举/等值"规则被推翻 ${group.count} 次，最常引用的原因是「${OVERTURN_REASONS[reasonTop]}」。枚举阈值无法自动调整：建议要么把允许值放宽（如把 heavy 加入允许集合），要么限定该规则只对特定类目生效。`;
      suggestion.confidence = group.count >= 4 ? "medium" : "low";
    } else {
      suggestion.advice = `该规则被推翻 ${group.count} 次，请人工复核规则定义是否与实际业务一致。`;
    }

    if (tooOften && failures > 0) {
      suggestion.advice += ` 另外：该规则本批次失败 ${failures} 次、被推翻 ${group.count} 次，推翻率 ${(rate * 100).toFixed(0)}%，属于"规则本身可疑"的信号，建议优先重写。`;
    }
    suggestions.push(suggestion);
  }

  return suggestions.sort((a, b) => b.overturns - a.overturns);
}

/**
 * Overlay stored overturns onto a report so the UI shows the reviewer's verdict,
 * not the machine's. Machine output is preserved under `machineStatus`.
 * @param {object} report - an evaluated report.
 * @param {FeedbackStore} store - the log.
 * @returns {object} the same report with `overridden` flags applied.
 */
export function annotateReport(report, store) {
  // Deliberately tolerant of `ok`: a report built directly by `evaluate()` has no
  // orchestration flag, and refusing to annotate it would hide reviewer decisions.
  if (!store || store.size === 0 || !report?.results || !report?.image?.name) return report;
  const overturns = store.forImage(report.image.name, report.checklist?.id);
  if (overturns.length === 0) return report;
  const byRule = new Map(overturns.map((record) => [record.ruleId, record]));
  const results = report.results.map((result) => {
    const record = byRule.get(result.id);
    if (!record) return result;
    return {
      ...result,
      machineStatus: result.status,
      status: "overturned",
      overridden: true,
      override: { reason: record.reason, reasonLabel: OVERTURN_REASONS[record.reason], note: record.note, reviewer: record.reviewer, at: record.at },
    };
  });
  const failed = results.filter((result) => result.status === "fail");
  const unknown = results.filter((result) => result.status === "unknown");
  const highFails = failed.filter((result) => result.severity === "high").length;
  const mediumFails = failed.filter((result) => result.severity === "medium").length;
  const lowFails = failed.length - highFails - mediumFails;
  const graded = results.filter((result) => result.status !== "unknown");
  const maxPoints = graded.reduce((sum, result) => sum + result.weight, 0);
  const earned = graded.reduce(
    (sum, result) => sum + (result.weight * (result.status === "overturned" ? 100 : result.score)) / 100,
    0,
  );
  const score = maxPoints === 0 ? 0 : Math.round((earned / maxPoints) * 100);
  let verdict = "pass";
  if (highFails > 0 || mediumFails >= 3) verdict = "fail";
  else if (mediumFails > 0 || lowFails >= 2) verdict = "warn";
  if (graded.length === 0) verdict = "unknown";
  return {
    ...report,
    score,
    verdict,
    verdictLabel: { pass: "合格", warn: "需优化", fail: "不合格", unknown: "无法判定" }[verdict],
    results,
    counts: { pass: results.length - failed.length - unknown.length, fail: failed.length, unknown: unknown.length, total: results.length, overturned: results.filter((result) => result.overridden).length },
    recommendations: report.recommendations.filter((item) => !byRule.has(item.id)),
    override: { count: overturns.length, latest: overturns[overturns.length - 1].at },
  };
}
