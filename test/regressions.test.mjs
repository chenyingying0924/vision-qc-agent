/**
 * Regression tests for the defects found in the 2026-10-23 audit.
 *
 * Each block names the bug id from `docs/audit-report.md`, so a future reader can
 * tell *why* the assertion exists instead of treating it as incidental.
 * Offline only: no API key, no network, no browser.
 */
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { intFromEnv, loadConfig } from "../src/config.mjs";
import { normalizeModelFacts } from "../src/core/facts.mjs";
import { evaluate, loadChecklists, validateChecklist } from "../src/core/rules.mjs";
import { annotateReport } from "../src/core/feedback.mjs";
import { evaluateConsistency } from "../src/core/consistency.mjs";
import { inspectBatch } from "../src/core/pipeline.mjs";
import { analyzePngMetrics, inspectImage } from "../src/image/inspect.mjs";
import { encodePng } from "../src/image/synthetic.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checklists = loadChecklists(join(APP_ROOT, "checklists"));
const main = checklists.find((entry) => entry.id === "ecom-main-image");

/** Offline config: a missing key keeps `useMock` on even when `forceMock` is not passed. */
const baseConfig = {
  appRoot: APP_ROOT,
  concurrency: 2,
  mock: false,
  provider: "deepseek",
  model: "deepseek-v4-flash-vision-exp",
  apiKeyConfigured: false,
  maxImages: 12,
};

const png = (shade) => encodePng(200, 200, shade);

function measurementOf(buffer) {
  return { ...inspectImage(buffer), metrics: analyzePngMetrics(buffer), metricsNote: "test" };
}

/** Run a block with temporary environment variables, restored afterwards. */
function withEnv(patch, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* BUG-003 — numeric env values must fail fast, not become NaN         */
/* ------------------------------------------------------------------ */

test("intFromEnv rejects garbage instead of returning NaN", () => {
  withEnv({ QC_TEST_N: undefined }, () => {
    assert.equal(intFromEnv("QC_TEST_N", 3), 3, "unset falls back");
  });
  withEnv({ QC_TEST_N: "" }, () => {
    assert.equal(intFromEnv("QC_TEST_N", 3), 3, "empty falls back");
  });
  withEnv({ QC_TEST_N: "5" }, () => {
    assert.equal(intFromEnv("QC_TEST_N", 3), 5);
  });
  withEnv({ QC_TEST_N: "abc" }, () => {
    assert.throws(() => intFromEnv("QC_TEST_N", 3), /QC_TEST_N 必须是/);
  });
  withEnv({ QC_TEST_N: "3.5" }, () => {
    assert.throws(() => intFromEnv("QC_TEST_N", 3), /整数/);
  });
  withEnv({ QC_TEST_N: "0" }, () => {
    assert.throws(() => intFromEnv("QC_TEST_N", 3, { min: 1, max: 8 }), /1–8/);
  });
  withEnv({ QC_TEST_N: "99" }, () => {
    assert.throws(() => intFromEnv("QC_TEST_N", 3, { min: 1, max: 8 }), /1–8/);
  });
});

test("loadConfig names the offending variable and refuses an unknown provider", () => {
  withEnv({ QC_CONCURRENCY: "abc" }, () => {
    assert.throws(() => loadConfig(), /QC_CONCURRENCY/);
  });
  withEnv({ QC_PROVIDER: "bogus" }, () => {
    // BUG-016: an unknown provider used to keep the bogus name while calling
    // DeepSeek, so the call was billed but `costOf()` could not price it.
    assert.throws(() => loadConfig(), /QC_PROVIDER="bogus" 不受支持/);
  });
  withEnv({ QC_CONCURRENCY: "4", QC_DATA_DIR: "/tmp/qc-data-test" }, () => {
    const config = loadConfig();
    assert.equal(config.concurrency, 4);
    assert.equal(config.dataDir, "/tmp/qc-data-test");
  });
});

test("a NaN concurrency still processes every image and leaves no holes", async () => {
  const images = [
    { name: "a.png", buffer: png(() => [255, 255, 255]) },
    { name: "b.png", buffer: png(() => [30, 70, 130]) },
  ];
  const { batch, reports } = await inspectBatch({
    config: { ...baseConfig, concurrency: Number.NaN },
    images,
    forceMock: true,
    consistency: false,
  });
  assert.equal(reports.length, 2);
  assert.equal(reports.filter((report) => report === undefined || report === null).length, 0, "no holes");
  assert.equal(batch.ok + batch.failed, batch.total, "every image is accounted for");
  for (const report of reports) {
    assert.ok(report.image?.name, "a failed report still carries its file name");
  }
});

/* ------------------------------------------------------------------ */
/* BUG-004 / 006 / 007 — input contract at the engine boundary         */
/* ------------------------------------------------------------------ */

test("an unknown checklist id is refused instead of silently using another one", async () => {
  await assert.rejects(
    () => inspectBatch({ config: baseConfig, images: [{ name: "a.png", buffer: png(() => [255, 255, 255]) }], checklistId: "does-not-exist", forceMock: true, consistency: false }),
    (error) => {
      assert.equal(error.code, "UNKNOWN_CHECKLIST");
      assert.match(error.message, /ecom-main-image/, "the message lists the valid ids");
      return true;
    },
  );
  // Omitting the id still means "first checklist", as documented.
  const { batch } = await inspectBatch({ config: baseConfig, images: [{ name: "a.png", buffer: png(() => [255, 255, 255]) }], forceMock: true, consistency: false });
  assert.equal(batch.checklist.id, checklists[0].id);
});

test("a non-image upload fails with UNSUPPORTED_FORMAT and never reaches the model", async () => {
  const events = [];
  const { batch, reports } = await inspectBatch({
    config: baseConfig,
    images: [{ name: "notes.txt", buffer: Buffer.from("this is not an image at all") }],
    forceMock: true,
    consistency: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].error.code, "UNSUPPORTED_FORMAT");
  assert.equal(batch.failed, 1);
  // Fails *before* any vision work: no facts event, no fabricated verdict.
  assert.equal(events.some((event) => event.type === "image-facts"), false);
  assert.equal(events.some((event) => event.type === "image-measured"), false);
});

test("dropped images are reported, not silently ignored", async () => {
  const events = [];
  const { batch } = await inspectBatch({
    config: baseConfig,
    images: [{ name: "a.png", buffer: png(() => [255, 255, 255]) }],
    forceMock: true,
    consistency: false,
    dropped: 3,
    onEvent: (event) => events.push(event),
  });
  assert.equal(batch.dropped, 3);
  const start = events.find((event) => event.type === "batch-start");
  assert.equal(start.dropped, 3);
  const warning = events.find((event) => event.type === "batch-warning");
  assert.ok(warning, "a batch-warning event is emitted");
  assert.match(warning.message, /3 张/);
});

/* ------------------------------------------------------------------ */
/* BUG-008 — model output is validated against the fact catalogue      */
/* ------------------------------------------------------------------ */

test("model facts are coerced when the intent is unambiguous", () => {
  const { facts, coerced, dropped } = normalizeModelFacts({
    textInImage: "None",
    hasWatermark: "false",
    detailFlaws: "是",
    blurRisk: " none ",
    colorAccuracyRisk: "HIGH",
    productCoverage: "58%",
    summary: "should be stripped before this runs",
  });
  assert.equal(facts.textInImage, "none");
  assert.equal(facts.hasWatermark, false);
  assert.equal(facts.detailFlaws, true);
  assert.equal(facts.blurRisk, "none");
  assert.equal(facts.colorAccuracyRisk, "high");
  assert.equal(facts.productCoverage, 58);
  assert.equal(dropped.includes("summary"), true, "unknown keys are not passed through");
  assert.ok(coerced.length >= 5);
});

test("an out-of-vocabulary answer degrades to unknown, not to a false failure", () => {
  const { facts, dropped } = normalizeModelFacts({ textInImage: "a lot", hasWatermark: "maybe", productCoverage: "n/a" });
  assert.deepEqual(facts, {});
  assert.deepEqual(dropped.sort(), ["hasWatermark", "productCoverage", "textInImage"]);

  // Prove the rule engine's behaviour with the dropped facts: unknown, not fail.
  const report = evaluate({
    checklist: main,
    measurement: measurementOf(png(() => [255, 255, 255])),
    modelFacts: facts,
  });
  assert.equal(report.results.find((rule) => rule.id === "R02").status, "unknown");
  assert.equal(report.results.find((rule) => rule.id === "R03").status, "unknown");
});

test("percent values are clamped into 0-100 rather than trusted blindly", () => {
  const { facts } = normalizeModelFacts({ productCoverage: 140, compositionBalance: -20 });
  assert.equal(facts.productCoverage, 100);
  assert.equal(facts.compositionBalance, 0);
});

test("the <fact>Reason sibling used by `judge` rules survives normalisation", () => {
  const { facts, dropped } = normalizeModelFacts({
    compositionBalance: 42,
    compositionBalanceReason: "主体偏左，右侧留白过多",
    unrelatedReason: "not tied to any fact",
  });
  assert.equal(facts.compositionBalance, 42);
  assert.equal(facts.compositionBalanceReason, "主体偏左，右侧留白过多");
  assert.equal(dropped.includes("unrelatedReason"), true, "an orphan *Reason is still dropped");
});

test("consistency enums tolerate casing drift but not invented values", () => {
  const entries = [
    { name: "a.png", measurement: { ...measurementOf(encodePng(200, 200, (x) => (x < 100 ? [220, 30, 30] : [255, 255, 255]))) } },
    { name: "b.png", measurement: { ...measurementOf(encodePng(200, 200, (x) => (x < 100 ? [214, 34, 34] : [255, 255, 255]))) } },
  ];
  const lenient = evaluateConsistency({ entries, semantic: { sameProduct: "TRUE", colorConsistency: "Same", detailConsistency: "same", lightingConsistency: "same" } });
  assert.equal(lenient.rules.find((rule) => rule.id === "C01").status, "pass");
  assert.equal(lenient.rules.find((rule) => rule.id === "C02").status, "pass");

  const garbage = evaluateConsistency({ entries, semantic: { sameProduct: "probably", colorConsistency: "kinda", detailConsistency: "same", lightingConsistency: "same" } });
  assert.equal(garbage.rules.find((rule) => rule.id === "C01").status, "unknown");
  assert.equal(garbage.rules.find((rule) => rule.id === "C02").status, "unknown");
});

/* ------------------------------------------------------------------ */
/* BUG-009 — checklist validation must reject silently-broken rules    */
/* ------------------------------------------------------------------ */

test("checklist validation rejects values that would silently disable a rule", () => {
  const wrap = (rule) => ({ id: "x", name: "x", rules: [rule] });
  const base = { id: "A", title: "t", fact: "minSide", op: ">=", value: 800 };
  assert.equal(validateChecklist(wrap(base)).rules[0].value, 800);

  assert.throws(() => validateChecklist(wrap({ ...base, value: "800" })), /finite number/);
  assert.throws(() => validateChecklist(wrap({ ...base, op: "<=", value: null })), /finite number/);
  assert.throws(
    () => validateChecklist(wrap({ id: "A", title: "t", fact: "saturationRatio", op: "between", value: [45, 12] })),
    /ordered/,
  );
  assert.throws(
    () => validateChecklist(wrap({ id: "A", title: "t", fact: "saturationRatio", op: "between", value: ["10", 45] })),
    /two finite numbers/,
  );
  assert.throws(
    () => validateChecklist(wrap({ id: "A", title: "t", fact: "textInImage", op: "in", value: [] })),
    /must not be empty/,
  );
  assert.throws(
    () => validateChecklist(wrap({ id: "A", title: "t", fact: "hasText", op: "==", value: undefined })),
    /value is required/,
  );
});

test("every shipped checklist still validates after the stricter rules", () => {
  assert.equal(checklists.length, 4);
  for (const checklist of checklists) {
    assert.ok(checklist.rules.length >= 11, `${checklist.id} keeps its rules`);
  }
});

/* ------------------------------------------------------------------ */
/* BUG-011 — report counts must add up                                 */
/* ------------------------------------------------------------------ */

test("counts add up after an overturn (pass + fail + unknown + overturned = total)", () => {
  const report = evaluate({
    checklist: main,
    measurement: measurementOf(png(() => [255, 255, 255])),
    modelFacts: { textInImage: "heavy", hasWatermark: true, detailFlaws: true, blurRisk: "obvious", lightingQuality: "harsh", colorAccuracyRisk: "high", detailsVisible: false, hasExtraObjects: true, productCoverage: 40 },
  });
  const store = {
    size: 1,
    forImage: () => [{ ruleId: "R02", reason: "rule-misapplied", note: "", reviewer: "test", at: new Date().toISOString() }],
  };
  const annotated = annotateReport({ ...report, ok: true, image: { name: "hero.png" } }, store);
  const { pass, fail, unknown, overturned, total } = annotated.counts;
  assert.equal(overturned, 1);
  assert.equal(pass + fail + unknown + overturned, total, `counts must sum to ${total}, got ${JSON.stringify(annotated.counts)}`);
});
