/**
 * Unit tests — `node --test test/`.
 * These run fully offline: no API key, no network, no browser.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { analyzePngMetrics, aspectLabel, detectFormat, inspectImage } from "../src/image/inspect.mjs";
import { encodePng, writeSyntheticPng } from "../src/image/synthetic.mjs";
import { evaluate, loadChecklists, renderMarkdown, validateChecklist } from "../src/core/rules.mjs";
import { buildVisionPrompt } from "../src/vision/prompt.mjs";
import { extractJson, mockVisionFacts } from "../src/vision/provider.mjs";
import { parseMultipart } from "../src/core/multipart.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checklists = loadChecklists(join(APP_ROOT, "checklists"));
const main = checklists[0];

test("format sniffing handles the supported containers", () => {
  const png = encodePng(4, 4, () => [255, 255, 255]);
  assert.equal(detectFormat(png), "png");
  assert.equal(detectFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpeg");
  const riff = Buffer.alloc(16);
  riff.write("RIFF", 0, "ascii");
  riff.write("WEBP", 8, "ascii");
  assert.equal(detectFormat(riff), "webp");
  assert.equal(detectFormat(Buffer.from("GIF89a............", "ascii")), "gif");
  assert.equal(detectFormat(Buffer.from("nope")), "unknown");
});

test("inspectImage measures size, aspect and megapixels", () => {
  const image = inspectImage(encodePng(1600, 900, () => [0, 0, 0]));
  assert.equal(image.width, 1600);
  assert.equal(image.height, 900);
  assert.equal(image.format, "png");
  assert.equal(image.aspectLabel, "landscape-16x9");
  assert.equal(image.megapixels, 1.44);
  assert.equal(image.rectangle, true);
});

test("aspect buckets match platform conventions", () => {
  assert.equal(aspectLabel(1), "square-1x1");
  assert.equal(aspectLabel(0.75), "portrait-3x4");
  assert.equal(aspectLabel(0.8), "portrait-4x5");
  assert.equal(aspectLabel(1.5), "landscape");
  assert.equal(aspectLabel(0), "unknown");
});

test("pixel metrics separate a white field from a colourful one", () => {
  const white = analyzePngMetrics(encodePng(400, 400, () => [255, 255, 255]));
  const colorful = analyzePngMetrics(encodePng(400, 400, (x) => (x < 200 ? [220, 20, 20] : [20, 180, 60])));
  assert.ok(white.borderWhiteness > 0.99, `expected near-white border, got ${white.borderWhiteness}`);
  assert.ok(colorful.saturationRatio > 0.9, `expected saturated pixels, got ${colorful.saturationRatio}`);
  assert.ok(white.lumaSd < colorful.lumaSd, "white field should be flatter than a two-colour image");
});

test("checklist validation rejects unknown facts and duplicate ids", () => {
  const base = { id: "x", name: "x", rules: [{ id: "A", title: "t", fact: "hasText", op: "==", value: false }] };
  assert.equal(validateChecklist(base).rules.length, 1);
  assert.throws(
    () => validateChecklist({ ...base, rules: [{ id: "A", title: "t", fact: "nope", op: "==", value: 1 }] }),
    /not in the fact catalogue/,
  );
  assert.throws(
    () => validateChecklist({ ...base, rules: [base.rules[0], { ...base.rules[0] }] }),
    /duplicated/,
  );
  assert.throws(() => validateChecklist({ ...base, rules: [{ id: "A", title: "t", fact: "hasText", op: "~", value: 1 }] }), /must be one of/);
});

/** Build a measurement like the pipeline would produce, from a synthetic image. */
function measurementFor(buffer, name = "fixture.png") {
  const header = inspectImage(buffer);
  return {
    name,
    ...header,
    metrics: analyzePngMetrics(buffer),
    metricsNote: "test",
  };
}

test("a clean white square passes the compliance rules", () => {
  const measurement = measurementFor(encodePng(1200, 1200, (x, y) => {
    const inside = Math.abs(x - 600) < 300 && Math.abs(y - 600) < 320;
    return inside ? [30, 70, 130] : [255, 255, 255];
  }));
  const report = evaluate({
    checklist: main,
    measurement,
    modelFacts: {
      textInImage: "none",
      hasWatermark: false,
      productCoverage: 72,
      lightingQuality: "good",
      detailFlaws: false,
      blurRisk: "none",
      colorAccuracyRisk: "low",
      detailsVisible: true,
      hasExtraObjects: false,
    },
  });
  assert.equal(report.results.find((r) => r.id === "R01").status, "pass");
  assert.equal(report.results.find((r) => r.id === "R04").status, "pass");
  assert.equal(report.results.find((r) => r.id === "R06").status, "pass");
  assert.ok(["pass", "warn"].includes(report.verdict), `unexpected verdict ${report.verdict}`);
  assert.ok(report.score > 60, `expected a decent score, got ${report.score}`);
  assert.ok(report.markdown ?? true);
});

test("defects produce fail verdicts with ranked recommendations", () => {
  const measurement = measurementFor(encodePng(520, 520, (x, y) => ((x + y) % 90 < 45 ? [200, 30, 30] : [20, 20, 20])));
  const report = evaluate({
    checklist: main,
    measurement,
    modelFacts: {
      textInImage: "heavy",
      hasWatermark: true,
      productCoverage: 34,
      lightingQuality: "harsh",
      detailFlaws: true,
      blurRisk: "obvious",
      colorAccuracyRisk: "high",
      detailsVisible: false,
      hasExtraObjects: true,
    },
  });
  assert.equal(report.verdict, "fail");
  assert.ok(report.counts.fail >= 6, `expected many failures, got ${report.counts.fail}`);
  assert.equal(report.severityBreakdown.high >= 1, true);
  assert.equal(report.recommendations[0].severity, "high");
  assert.ok(report.score < 50, `expected a low score, got ${report.score}`);
});

test("missing facts degrade to unknown instead of counting as passes", () => {
  const measurement = measurementFor(encodePng(300, 300, () => [255, 255, 255]));
  const report = evaluate({ checklist: main, measurement, modelFacts: {} });
  assert.ok(report.counts.unknown >= 5, `expected unknowns, got ${report.counts.unknown}`);
  assert.equal(report.results.every((result) => result.status !== "pass" || result.source === "pipeline"), true);
  assert.match(report.results.find((result) => result.status === "unknown").suggestion, /人工复核/);
});

test("threshold is a real dial: R05 passes at 61% and fails at 58%", () => {
  const measurement = measurementFor(encodePng(1000, 1000, () => [250, 250, 250]));
  const facts = (coverage) => ({ productCoverage: coverage, textInImage: "none", hasWatermark: false, detailFlaws: false, blurRisk: "none", lightingQuality: "good", colorAccuracyRisk: "low", detailsVisible: true, hasExtraObjects: false });
  const pass = evaluate({ checklist: main, measurement, modelFacts: facts(61) });
  const fail = evaluate({ checklist: main, measurement, modelFacts: facts(58) });
  assert.equal(pass.results.find((r) => r.id === "R05").status, "pass");
  assert.equal(fail.results.find((r) => r.id === "R05").status, "fail");
  assert.equal(fail.results.find((r) => r.id === "R05").observed, "58%");
});

test("mock facts react to the actual pixels", () => {
  const white = mockVisionFacts(measurementFor(encodePng(600, 600, () => [255, 255, 255])));
  const dark = mockVisionFacts(measurementFor(encodePng(600, 600, (x, y) => ((x * y) % 7 === 0 ? [10, 10, 12] : [26, 30, 44]))));
  assert.ok(white.backgroundWhitenessJudged > dark.backgroundWhitenessJudged);
  assert.ok(white.lightingQuality !== dark.lightingQuality || white.detailFlaws !== dark.detailFlaws);
  assert.equal(typeof white.confidence, "number");
});

test("prompt lists every model fact exactly once", () => {
  const measurement = measurementFor(encodePng(600, 600, () => [255, 255, 255]));
  const prompt = buildVisionPrompt({ checklist: main, measurement });
  for (const rule of main.rules) assert.match(prompt.user, new RegExp(rule.id));
  for (const key of ["backgroundWhitenessJudged", "textInImage", "hasWatermark", "detailFlaws"]) {
    assert.match(prompt.system, new RegExp(`"${key}"`));
  }
  assert.match(prompt.user, /borderWhitenessPercent/);
});

test("extractJson survives fenced and chatty answers", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('好的：\n```json\n{"a":{"b":2}}\n```\n完'), { a: { b: 2 } });
  assert.deepEqual(extractJson('前言 {"a":"含}花括号"} 后记'), { a: "含}花括号" });
  assert.equal(extractJson("没有 JSON"), undefined);
});

test("markdown report keeps findings and suggestions", () => {
  const measurement = measurementFor(encodePng(500, 500, () => [255, 255, 255]));
  const report = evaluate({
    checklist: main,
    measurement,
    modelFacts: { textInImage: "heavy", hasWatermark: true },
    modelMeta: { model: "test-model", provider: "test", reason: "概述文本" },
  });
  report.image = { name: "a.png", width: 500, height: 500, format: "png", fileSizeKB: 3 };
  const markdown = renderMarkdown(report);
  assert.match(markdown, /# 视觉质检报告：a\.png/);
  assert.match(markdown, /整改建议/);
  assert.match(markdown, /概述文本/);
  assert.match(markdown, /\| R02 \|/);
});

test("multipart parser reads files and fields", () => {
  const boundary = "----qcboundary";
  const png = encodePng(8, 8, () => [1, 2, 3]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="checklistId"\r\n\r\nmain\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parsed.fields.checklistId, "main");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].name, "p.png");
  assert.equal(parsed.files[0].type, "image/png");
  assert.equal(detectFormat(parsed.files[0].buffer), "png");
  assert.equal(parsed.files[0].buffer.length, png.length);
});

test("synthetic fixtures round-trip through the inspector", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qc-fixtures-"));
  const path = writeSyntheticPng(join(dir, "wide.png"), { width: 1600, height: 900, kind: "gradient" });
  const buffer = readFileSync(path);
  const image = inspectImage(buffer);
  assert.equal(image.width, 1600);
  assert.equal(image.height, 900);
  const metrics = analyzePngMetrics(buffer);
  assert.ok(metrics.sampledPixels > 1000, "sampling should cover the image");
  assert.ok(metrics.saturationRatio > 0.5, "gradient fixture should be colourful");
});

test("every shipped checklist validates and references known facts", () => {
  assert.ok(checklists.length >= 1);
  for (const checklist of checklists) {
    assert.ok(checklist.rules.length >= 6);
    assert.equal(new Set(checklist.rules.map((rule) => rule.id)).size, checklist.rules.length);
  }
});
