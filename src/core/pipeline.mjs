/**
 * The inspection pipeline: image bytes in, evaluated report out.
 *
 * One image costs one vision call; everything else (measurement, rule
 * evaluation, scoring, rendering) is local and free. Each step reports
 * progress so the UI can show the agent "looking → thinking → judging".
 *
 * @module vision-qc-agent/core/pipeline
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, loadChecklists, renderMarkdown } from "./rules.mjs";
import { evaluateConsistency, renderConsistencyMarkdown } from "./consistency.mjs";
import { summarizeCost } from "./pricing.mjs";
import { annotateReport } from "./feedback.mjs";
import { measure } from "../image/inspect.mjs";
import { analyzeConsistency, analyzeVision, mockVisionFacts } from "../vision/provider.mjs";

/** Bump when the prompt or evaluation semantics change, to invalidate old cache entries. */
const CACHE_SCHEMA = "v2";

/**
 * Stable identity for a run cache: image bytes + checklist *content* + model.
 * Hashing the rules (not just the id) means editing a threshold invalidates the
 * cached verdicts, which a naive id-only key would happily serve stale.
 */
function runKey(buffer, checklist, modelTag) {
  const checklistHash = createHash("sha256").update(JSON.stringify(checklist.rules)).digest("hex").slice(0, 8);
  return createHash("sha256")
    .update(buffer)
    .update(`${checklist.id}@${checklistHash}|${modelTag}|${CACHE_SCHEMA}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Inspect a batch of images.
 * @param {object} params
 * @param {object} params.config - resolved configuration.
 * @param {Array<{name: string, buffer: Buffer}>} params.images - uploaded files.
 * @param {string} [params.checklistId] - checklist to apply; defaults to the first.
 * @param {(event: object) => void} [params.onEvent] - progress sink.
 * @param {boolean} [params.forceMock] - ignore the API even when a key exists.
 * @param {Map<string, object>} [params.cache] - run cache keyed by {@link runKey}.
 * @returns {Promise<{batch: object, reports: object[]}>} batch summary plus per-image reports.
 */
export async function inspectBatch({
  config,
  images,
  checklistId,
  onEvent = () => {},
  forceMock = false,
  cache,
  consistency = true,
  consistencyCache,
  feedback,
}) {
  const checklists = loadChecklists(join(config.appRoot, "checklists"));
  const checklist = checklists.find((entry) => entry.id === checklistId) ?? checklists[0];
  if (!checklist) throw new Error("no checklist available");
  const useMock = forceMock || config.mock || !config.apiKeyConfigured;
  const modelTag = useMock ? "mock:v1" : `${config.provider}:${config.model}`;
  const startedAt = Date.now();

  onEvent({ type: "batch-start", total: images.length, checklist: { id: checklist.id, name: checklist.name }, model: modelTag, mock: useMock });

  const queue = images.slice();
  const reports = new Array(images.length);
  let cursor = 0;

  async function worker(workerId) {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const image = queue[index];
      try {
        const report = await inspectOne({ config, checklist, image, useMock, modelTag, cache, onEvent, index, workerId, feedback });
        reports[index] = report;
      } catch (error) {
        onEvent({ type: "image-error", index, name: image.name, message: error.message, code: error.code ?? "ERROR" });
        reports[index] = {
          ok: false,
          image: { name: image.name },
          error: { message: error.message, code: error.code ?? "ERROR" },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(config.concurrency, images.length)) }, (_, i) => worker(i + 1)));

  // Pair each report with the image it came from. Matching by file name would
  // break on duplicate names (very common across folders), so the queue index
  // is the identity here.
  const pairs = [];
  reports.forEach((report, index) => {
    if (report?.ok) pairs.push({ report, image: images[index] });
  });
  const succeeded = pairs.map((pair) => pair.report);

  // Consistency needs at least two images; it is a separate, optional call.
  // It is cached per group as well, otherwise re-uploading an already cached
  // batch would still pay for one fresh multi-image comparison.
  let groupCheck = null;
  if (consistency && succeeded.length >= 2) {
    const groupKey = createHash("sha256")
      .update(succeeded.map((report) => report.key).sort().join("|"))
      .update(modelTag)
      .digest("hex")
      .slice(0, 16);
    if (consistencyCache?.has(groupKey)) {
      groupCheck = { ...consistencyCache.get(groupKey), cached: true, cost: null };
      onEvent({ type: "consistency-report", report: groupCheck });
    } else {
      try {
        groupCheck = await checkConsistency({ config, pairs, useMock, onEvent });
        consistencyCache?.set(groupKey, groupCheck);
      } catch (error) {
        onEvent({ type: "consistency-error", message: error.message, code: error.code ?? "ERROR" });
        groupCheck = { ok: false, error: { message: error.message, code: error.code ?? "ERROR" } };
      }
    }
  }

  // Only bill the calls this run actually made: replayed cache hits cost nothing.
  const billed = succeeded.filter((report) => !report.cached);
  const cost = summarizeCost(billed.map((report) => ({ cost: report.cost, ms: report.prompt?.ms })));
  const consistencyCost = groupCheck?.cost ?? null;
  const batch = {
    startedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    checklist: { id: checklist.id, name: checklist.name, version: checklist.version },
    model: modelTag,
    mock: useMock,
    total: images.length,
    ok: succeeded.length,
    failed: reports.length - succeeded.length,
    cached: succeeded.length - billed.length,
    averageScore: succeeded.length
      ? Math.round(succeeded.reduce((sum, report) => sum + report.score, 0) / succeeded.length)
      : 0,
    verdicts: succeeded.reduce((acc, report) => {
      acc[report.verdict] = (acc[report.verdict] ?? 0) + 1;
      return acc;
    }, {}),
    cost: {
      ...cost,
      cached: succeeded.length - billed.length,
      consistency: consistencyCost
        ? { total: consistencyCost.total, tokens: consistencyCost.tokens, currency: consistencyCost.currency }
        : null,
      grandTotal: cost.total + (consistencyCost?.total ?? 0),
      currency: cost.currency,
    },
    consistency: groupCheck
      ? {
          ok: groupCheck.ok !== false,
          verdict: groupCheck.verdict,
          verdictLabel: groupCheck.verdictLabel,
          conflicts: groupCheck.conflicts?.length ?? 0,
          cached: Boolean(groupCheck.cached),
        }
      : null,
  };
  onEvent({ type: "cost", cost: batch.cost });
  if (groupCheck?.ok !== false && groupCheck) onEvent({ type: "consistency-report", report: groupCheck });
  onEvent({ type: "batch-end", batch });
  return { batch, reports, consistency: groupCheck };
}

/**
 * Run the SKU-group consistency check over the finished per-image reports.
 * One extra model call compares every image at once; the deterministic colour
 * comparison is free.
 */
async function checkConsistency({ config, pairs, useMock, onEvent }) {
  const entries = pairs.map(({ report, image }) => ({
    name: report.image.name,
    measurement: { ...report.image, metrics: report.image.metrics },
    report,
    buffer: image.buffer,
  }));

  onEvent({ type: "consistency-start", images: entries.length });

  let semantic;
  let meta = { provider: "mock", model: "deterministic-pixel-heuristics", ms: 0, mode: "mock", usage: null };
  if (useMock) {
    const colors = entries.map((entry) => entry.measurement?.metrics?.subjectColor);
    const comparable = colors.filter(Boolean);
    const spread = comparable.length >= 2
      ? Math.max(...comparable.map((color) => color.r)) - Math.min(...comparable.map((color) => color.r))
      : 0;
    semantic = {
      sameProduct: true,
      colorConsistency: spread > 40 ? "different" : spread > 15 ? "slight-variation" : "same",
      detailConsistency: "same",
      lightingConsistency: "same",
      imageRoles: entries.map((entry) => entry.report?.facts?.imageRole ?? "other"),
      notes: ["[模式化估计] 基于主体色实测差值推断的一致性结论，非模型判断。"],
      summary: `[模式化估计] ${entries.length} 张图的主体色通道最大差值为 ${spread}，据此推断一致性。`,
      confidence: 0.3,
    };
  } else {
    const answer = await analyzeConsistency({ config, entries });
    semantic = answer.semantic;
    meta = answer.meta;
  }

  const report = evaluateConsistency({ entries, semantic, meta });
  onEvent({
    type: "consistency-facts",
    verdict: report.verdict,
    summary: report.summary,
    conflicts: report.conflicts,
  });
  return {
    ok: true,
    ...report,
    cost: meta.cost ?? null,
    markdown: renderConsistencyMarkdown(report, `SKU 组（${entries.length} 张）`),
  };
}

/** Inspect a single image end to end. */
async function inspectOne({ config, checklist, image, useMock, modelTag, cache, onEvent, index, workerId, feedback }) {
  const key = runKey(image.buffer, checklist, modelTag);
  onEvent({ type: "image-start", index, name: image.name, key, workerId });
  if (cache?.has(key)) {
    // The cache stores the raw evaluation. Reviewer overturns are applied on
    // every read, so a decision made after the cache was written still shows up.
    const raw = cache.get(key);
    const report = feedback ? annotateReport(raw, feedback) : raw;
    const view = { ...report, cached: true };
    view.markdown = renderMarkdown(view);
    onEvent({ type: "image-cached", index, name: image.name, key });
    onEvent({ type: "image-report", index, report: view, cost: null });
    onEvent({ type: "image-done", index, name: image.name, key, score: view.score, verdict: view.verdict, cached: true });
    return view;
  }

  const measurement = measure(image);
  onEvent({
    type: "image-measured",
    index,
    name: image.name,
    measurement: {
      format: measurement.format,
      width: measurement.width,
      height: measurement.height,
      fileSizeKB: Math.round(measurement.bytes / 1024),
      aspectLabel: measurement.aspectLabel,
      metrics: measurement.metrics,
    },
  });

  let facts;
  let meta;
  if (useMock) {
    facts = mockVisionFacts(measurement);
    meta = {
      provider: "mock",
      model: "deterministic-pixel-heuristics",
      ms: 0,
      usage: null,
      cost: null,
      reasoning: "",
      reason: typeof facts.summary === "string" ? facts.summary : "",
      confidence: typeof facts.confidence === "number" ? facts.confidence : null,
      mode: "mock",
    };
  } else {
    onEvent({ type: "image-thinking", index, name: image.name, model: config.model });
    const answer = await analyzeVision({ config, checklist, measurement, buffer: image.buffer });
    facts = answer.facts;
    meta = answer.meta;
  }

  onEvent({
    type: "image-facts",
    index,
    name: image.name,
    facts,
    model: meta.model,
    ms: meta.ms,
    cost: meta.cost?.total ?? null,
    reasoning: meta.reasoning,
    mode: meta.mode,
  });

  const body = evaluate({ checklist, measurement, modelFacts: facts, modelMeta: meta });
  const merged = {
    ok: true,
    key,
    cached: false,
    cachedAt: new Date().toISOString(),
    ...body,
    image: {
      name: image.name,
      format: measurement.format,
      width: measurement.width,
      height: measurement.height,
      megapixels: measurement.megapixels,
      aspectLabel: measurement.aspectLabel,
      bytes: measurement.bytes,
      fileSizeKB: Math.round(measurement.bytes / 1024),
      metrics: measurement.metrics,
      metricsNote: measurement.metricsNote,
    },
    facts,
    cost: meta.cost ?? null,
    prompt: {
      model: meta.model,
      mode: meta.mode,
      ms: meta.ms,
      usage: meta.usage,
      repaired: Boolean(meta.repaired),
      finishReason: meta.finishReason ?? null,
      truncated: Boolean(meta.truncated),
    },
  };
  // Reviewer overturns win over the machine, and are shown as such. The cache
  // keeps the machine verdict so the annotation can be re-applied later.
  const raw = merged;
  raw.markdown = renderMarkdown(raw);
  cache?.set(key, raw);
  const report = feedback ? annotateReport(raw, feedback) : raw;
  if (report !== raw) report.markdown = renderMarkdown(report);
  onEvent({ type: "image-report", index, report, cost: report.cost ?? null });
  onEvent({ type: "image-done", index, name: image.name, key, score: report.score, verdict: report.verdict });
  return report;
}

/**
 * Persist a batch to `reports/<stamp>/`.
 * @param {object} config - resolved configuration.
 * @param {object} batch - batch summary.
 * @param {object[]} reports - per-image reports.
 * @param {object} [consistency] - optional SKU-group consistency report.
 * @param {object[]} [suggestions] - optional threshold advice from the feedback log.
 * @returns {{dir: string, files: string[]}} where it was written.
 */
export function saveReports(config, batch, reports, consistency, suggestions = []) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(config.appRoot, "reports", stamp);
  mkdirSync(dir, { recursive: true });
  const written = [];
  const used = new Set();
  for (const report of reports) {
    if (!report?.ok) continue;
    const safe = report.image.name
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/\.(png|jpe?g|webp|gif)$/i, "") || "image";
    let fileName = safe;
    for (let suffix = 2; used.has(fileName); suffix += 1) fileName = `${safe}-${suffix}`;
    used.add(fileName);
    const target = join(dir, `${fileName}.md`);
    writeFileSync(target, report.markdown, "utf8");
    written.push(target);
  }
  if (consistency?.ok && consistency.markdown) {
    const target = join(dir, "_consistency.md");
    writeFileSync(target, consistency.markdown, "utf8");
    written.push(target);
  }
  if (suggestions.length > 0) {
    const target = join(dir, "_rule-adjustments.json");
    writeFileSync(target, JSON.stringify(suggestions, null, 2), "utf8");
    written.push(target);
  }
  const summary = join(dir, "batch.json");
  writeFileSync(summary, JSON.stringify({ batch, consistency: consistency ?? null, reports, ruleAdjustments: suggestions }, null, 2), "utf8");
  written.push(summary);
  return { dir, files: written };
}
