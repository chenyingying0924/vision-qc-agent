/**
 * Tests for the three extensions: cost accounting, multi-image consistency and
 * the human-in-the-loop overturn log. Offline only — no API key, no browser.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RATE_CARD,
  costOf,
  formatMoney,
  isOffPeak,
  mergeUsage,
  normalizeUsage,
  projection,
  ratesFor,
  scheduleAdvice,
  summarizeCost,
} from "../src/core/pricing.mjs";
import {
  buildConsistencyPrompt,
  compareSubjectColors,
  deltaE,
  describeDelta,
  evaluateConsistency,
  renderConsistencyMarkdown,
} from "../src/core/consistency.mjs";
import { FeedbackStore, OVERTURN_REASONS, annotateReport, suggestAdjustments } from "../src/core/feedback.mjs";
import { evaluate, loadChecklists } from "../src/core/rules.mjs";
import { inspectBatch } from "../src/core/pipeline.mjs";
import { analyzePngMetrics, inspectImage } from "../src/image/inspect.mjs";
import { encodePng } from "../src/image/synthetic.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checklists = loadChecklists(join(APP_ROOT, "checklists"));

/** The usage object observed from a real DeepSeek vision call. */
const PROBE_USAGE = {
  prompt_tokens: 249,
  completion_tokens: 79,
  total_tokens: 328,
  prompt_cache_hit_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 70 },
};

/* ------------------------------------------------------------------ */
/* pricing                                                             */
/* ------------------------------------------------------------------ */

test("cost matches the vendor's worked example for deepseek-flash", () => {
  const peak = costOf({ provider: "deepseek", model: "deepseek-flash", usage: PROBE_USAGE, at: "2026-09-17T02:00:00Z" });
  const offPeak = costOf({ provider: "deepseek", model: "deepseek-flash", usage: PROBE_USAGE, at: "2026-09-17T12:00:00Z" });
  // 249/1e6*0.30 + 79/1e6*1.20 = 0.0001695 ; off-peak is exactly half.
  assert.ok(Math.abs(peak.total - 0.0001695) < 1e-9, `peak was ${peak.total}`);
  assert.ok(Math.abs(offPeak.total - 0.00008475) < 1e-9, `off-peak was ${offPeak.total}`);
  assert.equal(peak.total, offPeak.total * 2);
});

test("off-peak window follows the published UTC schedule", () => {
  assert.equal(isOffPeak("2026-09-17T02:00:00Z"), false, "Thursday 02:00 UTC is peak");
  assert.equal(isOffPeak("2026-09-17T07:30:00Z"), false, "Thursday 07:30 UTC is peak");
  assert.equal(isOffPeak("2026-09-17T12:00:00Z"), true, "Thursday noon UTC is off-peak");
  assert.equal(isOffPeak("2026-09-19T02:00:00Z"), true, "Saturday is off-peak all day");
  assert.equal(isOffPeak("2026-09-20T08:00:00Z"), true, "Sunday is off-peak all day");
  assert.equal(isOffPeak("not a date"), false);
});

test("cache hits are billed in their own bucket, never at the miss rate", () => {
  const allMiss = costOf({
    provider: "deepseek",
    model: "deepseek-flash",
    usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
    at: "2026-09-17T02:00:00Z",
  });
  const allHit = costOf({
    provider: "deepseek",
    model: "deepseek-flash",
    usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_hit_tokens: 1000 },
    at: "2026-09-17T02:00:00Z",
  });
  assert.equal(Number(allMiss.total.toFixed(6)), 0.0003);
  assert.equal(Number(allHit.total.toFixed(7)), 0.000006);
  assert.ok(allHit.total < allMiss.total / 40, "cache hits must be far cheaper");
});

test("reasoning tokens are not billed twice", () => {
  const usage = { prompt_tokens: 0, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 90 } };
  const cost = costOf({ provider: "deepseek", model: "deepseek-flash", usage, at: "2026-09-17T02:00:00Z" });
  assert.equal(Number(cost.total.toFixed(6)), Number((100 * 1.2e-6).toFixed(6)));
  assert.equal(cost.tokens.reasoning, 90);
});

test("usage normalisation accepts every vendor shape", () => {
  assert.deepEqual(normalizeUsage(PROBE_USAGE), { input: 249, inputMiss: 249, cachedInput: 0, output: 79, reasoning: 70, total: 328 });
  const openai = normalizeUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } });
  assert.equal(openai.cachedInput, 6);
  assert.equal(openai.inputMiss, 4);
  const anthropic = normalizeUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 });
  assert.equal(anthropic.input, 10);
  assert.equal(anthropic.cachedInput, 3);
  assert.deepEqual(normalizeUsage(undefined), { input: 0, inputMiss: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 });
});

test("repair retries merge usage so tokens match the charged cost", () => {
  // Two billable calls: the first answer was not parseable, the retry succeeded.
  const first = { prompt_tokens: 1000, completion_tokens: 300, prompt_cache_hit_tokens: 200 };
  const second = { prompt_tokens: 900, completion_tokens: 200, prompt_cache_hit_tokens: 100 };
  const merged = mergeUsage(first, second);
  assert.equal(merged.prompt_tokens, 1900);
  assert.equal(merged.completion_tokens, 500);
  assert.equal(merged.prompt_cache_hit_tokens, 300);
  assert.equal(merged.calls, 2);

  const cost = costOf({ provider: "deepseek", model: "deepseek-flash", usage: merged, at: "2026-09-17T02:00:00Z" });
  assert.equal(cost.tokens.input, 1900, "the panel's token count must include both calls");
  // (1900-300) miss + 300 cache + 500 output, all at the published peak rates.
  const expected = (1600 * 0.3 + 300 * 0.006 + 500 * 1.2) / 1_000_000;
  assert.ok(Math.abs(cost.total - expected) < 1e-12, `expected ${expected}, got ${cost.total}`);
});

test("every rate card row is per-1M and carries a source", () => {
  for (const [provider, card] of Object.entries(RATE_CARD)) {
    assert.equal(card.unit, "per 1M tokens", `${provider} unit`);
    assert.ok(card.source, `${provider} source`);
    for (const [model, row] of Object.entries(card.models)) {
      assert.ok(row.input >= 0 && row.output >= 0 && row.cachedInput >= 0, `${provider}/${model} non-negative`);
      assert.ok(row.cachedInput <= row.input, `${provider}/${model} cache must not cost more than miss`);
    }
  }
  // `ratesFor` applies the DeepSeek off-peak discount based on the current time,
  // so the assertion must pin the moment — otherwise this test passes or fails
  // depending on when it runs (UTC 01–04 / 06–10 Mon–Fri are peak hours).
  const peak = ratesFor("deepseek", "deepseek-v4-flash-vision-exp", { at: "2026-09-17T02:00:00Z" });
  assert.equal(peak.exact, true);
  assert.equal(peak.input, 0.3);
  assert.equal(peak.offPeak, false);
  const offPeak = ratesFor("deepseek", "deepseek-v4-flash-vision-exp", { at: "2026-09-17T12:00:00Z" });
  assert.equal(offPeak.input, 0.15);
  assert.equal(offPeak.offPeak, true);
  const unknown = ratesFor("deepseek", "no-such-model", { at: "2026-09-17T02:00:00Z" });
  assert.equal(unknown.exact, false);
  assert.match(unknown.note, /未在费率表中找到/);
});

test("batch cost summary aggregates tokens, cache value and per-image cost", () => {
  const one = costOf({ provider: "deepseek", model: "deepseek-flash", usage: PROBE_USAGE, at: "2026-09-17T02:00:00Z" });
  const summary = summarizeCost([
    { cost: one, ms: 1200 },
    { cost: one, ms: 800 },
  ]);
  assert.equal(summary.images, 2);
  assert.equal(summary.tokens.total, 656);
  assert.equal(summary.tokensPerImage, 328);
  assert.equal(summary.modelMs, 2000);
  assert.equal(Number((summary.perImage * 2).toFixed(7)), Number(summary.total.toFixed(7)));
  assert.ok(Math.abs(summary.noCacheTotal - summary.total) < 1e-12, "with no cache hits the counterfactual equals the actual");
  assert.ok(formatMoney(summary.total).startsWith("$"));
  assert.equal(projection(0.0001695).find((row) => row.volume === 1000).cost.toFixed(4), "0.1695");
});

test("schedule advice shows the off-peak saving", () => {
  const advice = scheduleAdvice({ inputTokens: 1000, outputTokens: 500 });
  assert.equal(advice.savingRate, 0.5);
  assert.ok(advice.offPeak < advice.peak);
  assert.match(advice.advice, /错峰/);
});

/* ------------------------------------------------------------------ */
/* consistency                                                         */
/* ------------------------------------------------------------------ */

/** Build the measurement shape the pipeline produces, from synthetic pixels. */
function measurement(name, shade) {
  const buffer = encodePng(400, 400, shade);
  return { name, ...inspectImage(buffer), metrics: analyzePngMetrics(buffer), metricsNote: "test" };
}

/** A realistic "product on a white field": a centred coloured block. */
function productOnWhite(name, rgb) {
  return measurement(name, (x, y) => (Math.abs(x - 200) < 140 && Math.abs(y - 200) < 140 ? rgb : [255, 255, 255]));
}

test("deltaE separates identical, similar and different colours", () => {
  assert.equal(deltaE([10, 20, 30], [10, 20, 30]), 0);
  assert.ok(deltaE([10, 20, 30], [12, 22, 31]) < 2);
  assert.ok(deltaE([220, 20, 20], [20, 20, 220]) > 50);
  assert.equal(describeDelta(1).level, "imperceptible");
  assert.equal(describeDelta(3).level, "slight");
  assert.equal(describeDelta(7).level, "noticeable");
  assert.equal(describeDelta(30).level, "severe");
});

test("subject colour is measured from vivid pixels, not the white backdrop", () => {
  const red = productOnWhite("red.png", [210, 30, 30]);
  assert.ok(red.metrics.subjectColor, "expected a subject colour");
  assert.ok(red.metrics.subjectColor.r > 180, `expected red-dominant, got ${JSON.stringify(red.metrics.subjectColor)}`);
  assert.ok(red.metrics.borderWhiteness > 0.9, "the border should still read as white");
});

test("pairwise comparison reports the worst pair against the first image", () => {
  const entries = [
    { name: "01-hero.png", measurement: productOnWhite("01-hero.png", [30, 70, 200]) },
    { name: "02-detail.png", measurement: productOnWhite("02-detail.png", [34, 72, 198]) },
    { name: "03-wrong-colour.png", measurement: productOnWhite("03-wrong-colour.png", [200, 60, 40]) },
  ];
  const color = compareSubjectColors(entries);
  assert.equal(color.pairs.length, 2);
  assert.equal(color.baseline.name, "01-hero.png");
  assert.ok(color.pairs[0].deltaE < 5, "the near-identical detail shot should pass");
  assert.ok(color.pairs[1].deltaE > 50, "the wrong colour shot should be flagged");
  assert.equal(color.pairs[1].level, "severe");
  assert.match(color.pairs[1].aHex, /^#[0-9a-f]{6}$/);
});

test("images without a colour sample are excluded instead of guessed", () => {
  const color = compareSubjectColors([
    { name: "white.png", measurement: measurement("white.png", () => [255, 255, 255]) },
    { name: "also-white.png", measurement: measurement("also-white.png", () => [250, 250, 250]) },
  ]);
  assert.equal(color.pairs.length, 0);
  assert.match(color.note, /少于两张图/);
});

test("consistency evaluation flags model/measurement conflicts", () => {
  const entries = [
    { name: "a.png", measurement: productOnWhite("a.png", [220, 30, 30]) },
    { name: "b.png", measurement: productOnWhite("b.png", [30, 30, 220]) },
  ];
  const report = evaluateConsistency({
    entries,
    semantic: {
      sameProduct: true,
      colorConsistency: "same", // the lie this tool exists to catch
      detailConsistency: "same",
      lightingConsistency: "same",
      imageRoles: ["hero", "detail"],
      notes: [],
      summary: "看起来是同款不同色",
    },
  });
  assert.equal(report.verdict, "fail");
  assert.equal(report.rules.find((rule) => rule.id === "C05").status, "fail");
  assert.equal(report.conflicts.length, 1);
  assert.match(report.conflicts[0], /以实测为准/);
  const markdown = renderConsistencyMarkdown(report, "SKU-A");
  assert.match(markdown, /多图一致性报告：SKU-A/);
  assert.match(markdown, /模型判断与实测结论冲突/);
  assert.match(markdown, /C05/);
});

test("missing semantic fields degrade to unknown, not to pass", () => {
  const entries = [
    { name: "a.png", measurement: productOnWhite("a.png", [10, 120, 60]) },
    { name: "b.png", measurement: productOnWhite("b.png", [12, 122, 62]) },
  ];
  const report = evaluateConsistency({ entries, semantic: {} });
  assert.equal(report.counts.unknown, 4, "C01–C04 unknown, C05 evaluated locally");
  assert.equal(report.rules.find((rule) => rule.id === "C01").status, "unknown");
  assert.equal(report.rules.find((rule) => rule.id === "C05").status, "pass");
});

test("consistency prompt asks for every field it later reads", () => {
  const prompt = buildConsistencyPrompt({
    entries: [{ name: "a.png", measurement: productOnWhite("a.png", [200, 30, 30]), report: { facts: { imageRole: "hero" } } }],
  });
  for (const key of ["sameProduct", "colorConsistency", "detailConsistency", "lightingConsistency", "imageRoles", "summary"]) {
    assert.match(prompt.system, new RegExp(key));
  }
  assert.match(prompt.user, /a\.png/);
  assert.match(prompt.user, /主体色/);
});

/* ------------------------------------------------------------------ */
/* human-in-the-loop                                                   */
/* ------------------------------------------------------------------ */

function freshStore() {
  return new FeedbackStore(join(mkdtempSync(join(tmpdir(), "qc-feedback-")), "feedback.jsonl"));
}

test("overturns are appended, reloadable and grouped by rule", () => {
  const store = freshStore();
  store.record({ imageName: "a.png", ruleId: "R05", reason: "business-exception", observed: "55%", note: "清仓" });
  store.record({ imageName: "b.png", ruleId: "R05", reason: "threshold-wrong", observed: "56%" });
  store.record({ imageName: "c.png", ruleId: "R10", reason: "other" });
  assert.equal(store.size, 3);
  assert.equal(readFileSync(store.path, "utf8").trim().split("\n").length, 3, "one JSON object per line");
  const reopened = new FeedbackStore(store.path);
  assert.equal(reopened.size, 3);
  const grouped = reopened.byRule();
  assert.equal(grouped[0].ruleId, "R05");
  assert.equal(grouped[0].count, 2);
  assert.equal(reopened.forImage("a.png").length, 1);
  assert.throws(() => store.record({ imageName: "a.png", ruleId: "R01", reason: "nonsense" }), /未知原因/);
  assert.throws(() => store.record({ imageName: "", ruleId: "R01" }), /必填/);
  assert.ok(Object.keys(OVERTURN_REASONS).length >= 5);
});

test("threshold advice proposes a value from the accepted samples", () => {
  const store = freshStore();
  for (const observed of ["52%", "54%", "55%", "53%"]) {
    store.record({ imageName: `${observed}.png`, ruleId: "R05", reason: "business-exception", observed });
  }
  const checklist = checklists.find((entry) => entry.id === "ecom-main-image");
  const suggestions = suggestAdjustments({ checklist, store });
  const target = suggestions.find((suggestion) => suggestion.ruleId === "R05");
  assert.ok(target, "R05 should be suggested");
  assert.equal(target.overturns, 4);
  assert.equal(target.proposedValue, 54, "median of 52/53/54/55");
  assert.match(target.advice, /下调/);
  assert.match(target.advice, /需质检负责人确认/);
});

test("a single overturn without failure statistics is not yet advice", () => {
  const store = freshStore();
  store.record({ imageName: "a.png", ruleId: "R10", reason: "other", observed: "medium" });
  const checklist = checklists.find((entry) => entry.id === "ecom-main-image");
  const noStats = suggestAdjustments({ checklist, store });
  assert.equal(noStats.length, 0, "evidence gate must hold");
  // With real failure counts and a high overturn rate, the same rule qualifies.
  const withStats = suggestAdjustments({ checklist, store, options: { failuresByRule: new Map([["R10", 1]]) } });
  assert.equal(withStats.length, 1);
  assert.match(withStats[0].advice, /枚举/);
});

test("non-numeric rules get qualitative advice instead of a fake number", () => {
  const store = freshStore();
  store.record({ imageName: "a.png", ruleId: "R02", reason: "rule-misapplied", observed: "heavy" });
  store.record({ imageName: "b.png", ruleId: "R02", reason: "rule-misapplied", observed: "heavy" });
  const checklist = checklists.find((entry) => entry.id === "ecom-main-image");
  const [suggestion] = suggestAdjustments({ checklist, store });
  assert.equal(suggestion.proposedValue, null);
  assert.match(suggestion.advice, /枚举|限定该规则/);
});

test("an applied overturn lifts the verdict and keeps the machine status", () => {
  const checklist = checklists.find((entry) => entry.id === "ecom-main-image");
  const base = measurement("hero.png", (x, y) => (Math.abs(x - 200) < 150 && Math.abs(y - 200) < 150 ? [30, 70, 130] : [255, 255, 255]));
  const report = evaluate({
    checklist,
    measurement: base,
    modelFacts: {
      textInImage: "heavy",
      hasWatermark: true,
      productCoverage: 40,
      detailFlaws: true,
      blurRisk: "none",
      lightingQuality: "good",
      colorAccuracyRisk: "low",
      detailsVisible: true,
      hasExtraObjects: false,
    },
  });
  assert.equal(report.verdict, "fail");
  const before = report.score;

  const store = freshStore();
  store.record({ imageName: "hero.png", ruleId: "R02", reason: "rule-misapplied", note: "这不是促销图，是品牌 slogan" });
  // `evaluate()` returns the body only; the pipeline adds identity afterwards.
  const annotated = annotateReport({ ...report, ok: true, image: { name: "hero.png" } }, store);
  const rule = annotated.results.find((entry) => entry.id === "R02");
  assert.equal(rule.status, "overturned");
  assert.equal(rule.machineStatus, "fail");
  assert.equal(annotated.counts.overturned, 1);
  assert.ok(annotated.score > before, "an accepted overturn must not leave the score unchanged");
  assert.equal(annotated.recommendations.some((item) => item.id === "R02"), false, "the recommendation must disappear");
  assert.equal(annotated.override.count, 1);
});

test("annotateReport is a no-op without records for that image", () => {
  const store = freshStore();
  const report = { ok: true, image: { name: "x.png" }, results: [], counts: {}, recommendations: [] };
  assert.equal(annotateReport(report, store), report);
  assert.equal(annotateReport(report, undefined), report);
  // A store that knows nothing about this image must leave the verdict alone.
  const other = { ok: true, image: { name: "y.png" }, results: [{ id: "R01", status: "fail", weight: 10, score: 0, severity: "high" }], counts: {}, recommendations: [] };
  assert.equal(annotateReport(other, store), other);
});

/* ------------------------------------------------------------------ */
/* pipeline integration: caching, duplicate names, scoped overturns    */
/* ------------------------------------------------------------------ */

/** A config that never touches the network, so these tests stay offline. */
const testConfig = {
  appRoot: APP_ROOT,
  concurrency: 2,
  mock: false,
  provider: "deepseek",
  model: "deepseek-v4-flash-vision-exp",
  apiKeyConfigured: false,
  maxImages: 12,
};

function imageWithName(name, shade) {
  return { name, buffer: encodePng(240, 240, shade) };
}

test("duplicate file names do not cross-wire the consistency buffers", async () => {
  const images = [
    imageWithName("same.png", () => [200, 30, 30]),
    imageWithName("same.png", () => [30, 30, 200]),
  ];
  const { consistency } = await inspectBatch({ config: testConfig, images, forceMock: true, consistency: true });
  assert.equal(consistency.ok, true);
  assert.equal(consistency.group.size, 2, "both images must be compared");
  assert.equal(consistency.color.pairs.length, 1);
  assert.ok(consistency.color.pairs[0].deltaE > 20, "red vs blue must be measured, not the same buffer twice");
});

test("cached reports are re-annotated when a reviewer overturns later", async () => {
  const cache = new Map();
  const image = imageWithName("cache-me.png", () => [30, 70, 130]);
  const first = await inspectBatch({ config: testConfig, images: [image], forceMock: true, cache, consistency: false });
  assert.equal(first.reports[0].cached, false);
  assert.notEqual(first.reports[0].results.find((rule) => rule.id === "R02").status, "overturned");

  const store = freshStore();
  store.record({
    imageName: "cache-me.png",
    ruleId: "R02",
    reason: "rule-misapplied",
    context: { checklistId: "ecom-main-image" },
  });
  const second = await inspectBatch({
    config: testConfig,
    images: [image],
    forceMock: true,
    cache,
    consistency: false,
    feedback: store,
  });
  const report = second.reports[0];
  assert.equal(report.cached, true, "the second run must hit the cache");
  assert.equal(report.results.find((rule) => rule.id === "R02").status, "overturned", "a later overturn must apply to the cached evaluation");
  assert.equal(second.batch.cost.cached, 1, "cached replays are counted separately");
  assert.equal(second.batch.cost.images, 0, "a cached replay must not be billed");
});

test("overturns are scoped to their checklist, because rule ids repeat", async () => {
  const store = freshStore();
  store.record({
    imageName: "shared.png",
    ruleId: "R02",
    reason: "rule-misapplied",
    context: { checklistId: "ecom-main-image" },
  });
  const image = imageWithName("shared.png", () => [30, 70, 130]);
  const other = await inspectBatch({
    config: testConfig,
    images: [image],
    checklistId: "design-review",
    forceMock: true,
    consistency: false,
    feedback: store,
  });
  const rule = other.reports[0].results.find((entry) => entry.id === "R02");
  // design-review also has an R02; the main-image overturn must not touch it.
  assert.notEqual(rule?.status, "overturned", "an overturn from another checklist must not leak");
});

/* ------------------------------------------------------------------ */
/* checklists shipped with the project                                 */
/* ------------------------------------------------------------------ */

test("all four checklists load, are distinct, and share facts with different thresholds", () => {
  assert.equal(checklists.length, 4, "主图 / 详情页 / 直播封面 / 设计稿");
  const ids = checklists.map((checklist) => checklist.id);
  assert.deepEqual(ids.slice().sort(), ["design-review", "detail-page", "ecom-main-image", "live-cover"]);

  // The pluggability proof: the same fact is thresholded differently per purpose.
  const coverage = new Map();
  for (const checklist of checklists) {
    const rule = checklist.rules.find((entry) => entry.fact === "productCoverage");
    if (rule) coverage.set(checklist.id, rule.value);
  }
  assert.ok(coverage.size >= 2, "at least two checklists constrain productCoverage");
  assert.equal(new Set(coverage.values()).size, coverage.size, `thresholds must differ: ${JSON.stringify([...coverage])}`);

  // Compliance rules must not leak into the design-review checklist.
  const design = checklists.find((checklist) => checklist.id === "design-review");
  assert.equal(design.rules.some((rule) => rule.fact === "backgroundWhiteness"), false);
  assert.equal(design.rules.some((rule) => rule.fact === "hasWatermark"), false);
});
