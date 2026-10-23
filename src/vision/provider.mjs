/**
 * Vision providers.
 *
 * Two things live here:
 * 1. `analyzeVision` — calls a multimodal model and normalises the answer into
 *    the fact catalogue's shape. OpenAI-compatible and Anthropic protocols are
 *    both supported so the demo is not welded to one vendor.
 * 2. `mockVisionFacts` — a deterministic, offline fallback derived from local
 *    pixel metrics. It keeps the demo demonstrable without a key, and is always
 *    labelled as mock in the report so it can never be mistaken for a real
 *    model judgement.
 *
 * @module vision-qc-agent/vision/provider
 */
import { costOf, mergeUsage } from "../core/pricing.mjs";
import { normalizeModelFacts } from "../core/facts.mjs";
import { mediaType } from "../image/inspect.mjs";
import { buildConsistencyPrompt } from "../core/consistency.mjs";
import { buildRepairPrompt, buildVisionPrompt } from "./prompt.mjs";

class VisionError extends Error {
  constructor(message, code = "VISION_ERROR") {
    super(message);
    this.name = "VisionError";
    this.code = code;
  }
}

/** Extract the first balanced JSON object from a model answer. */
export function extractJson(text) {
  const source = String(text ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  const body = fenced ? fenced[1] : source;
  const start = body.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const char = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function dataUri(buffer, format) {
  return `data:${mediaType(format)};base64,${buffer.toString("base64")}`;
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new VisionError(
        `视觉模型返回 ${response.status}：${text.slice(0, 400)}`,
        response.status === 401 || response.status === 403 ? "BAD_CREDENTIAL" : "UPSTREAM_ERROR",
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VisionError(`视觉模型返回了非 JSON 响应：${text.slice(0, 200)}`, "BAD_RESPONSE");
    }
  } catch (error) {
    if (error instanceof VisionError) throw error;
    if (error.name === "AbortError") {
      throw new VisionError(`视觉模型请求超时（${timeoutMs}ms）`, "TIMEOUT");
    }
    throw new VisionError(`无法连接视觉模型：${error.message}`, "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One image is the common case; the consistency check sends several in a single
 * request, so every builder takes a list.
 * @param {{buffer: Buffer, format: string}[]} images
 */
function openAiBody({ config, system, user, images }) {
  return {
    model: config.model,
    max_tokens: 4000,
    temperature: 0.1,
    // JSON mode is supported by DeepSeek and OpenAI and removes most repair
    // retries; the prompt already names JSON, which both require.
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          ...images.map((image) => ({ type: "image_url", image_url: { url: dataUri(image.buffer, image.format) } })),
        ],
      },
    ],
  };
}

function anthropicBody({ config, system, user, images }) {
  return {
    model: config.model,
    max_tokens: 4000,
    temperature: 0.1,
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: user },
          ...images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: mediaType(image.format), data: image.buffer.toString("base64") },
          })),
        ],
      },
    ],
  };
}

function readOpenAiAnswer(payload) {
  const message = payload?.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => part?.text ?? "").join("")
      : "";
  return {
    text: content,
    reasoning: message.reasoning_content ?? message.reasoning ?? "",
    // Keep the vendor's raw usage so pricing can see cache-hit tokens too.
    usage: payload?.usage ?? null,
    model: payload?.model,
    finishReason: payload?.choices?.[0]?.finish_reason ?? null,
  };
}

function readAnthropicAnswer(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  return {
    text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""),
    reasoning: blocks.filter((block) => block.type === "thinking").map((block) => block.thinking).join(""),
    usage: payload?.usage ?? null,
    model: payload?.model,
    finishReason: payload?.stop_reason ?? null,
  };
}

async function callOnce({ config, messages, images }) {
  const isAnthropic = config.api === "anthropic-messages";
  const body = isAnthropic
    ? anthropicBody({ config, ...messages, images })
    : openAiBody({ config, ...messages, images });
  const url = `${config.baseURL.replace(/\/+$/, "")}/${isAnthropic ? "messages" : "chat/completions"}`;
  const headers = isAnthropic
    ? { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
  const payload = await fetchJson(url, { method: "POST", headers, body: JSON.stringify(body) }, config.requestTimeoutMs);
  return isAnthropic ? readAnthropicAnswer(payload) : readOpenAiAnswer(payload);
}

/**
 * Deterministic offline facts from local pixel metrics.
 * Used when `QC_MOCK=1` / the UI's demo mode is on, or when no key is configured.
 * @param {object} measurement - measurement bundle.
 * @returns {object} fact-shaped object.
 */
export function mockVisionFacts(measurement) {
  const m = measurement.metrics;
  if (!m) {
    return {
      backgroundWhitenessJudged: 82,
      hasText: false,
      textCoverage: 0,
      textInImage: "none",
      hasWatermark: false,
      hasContactInfo: false,
      productCoverage: 65,
      subjectClipped: false,
      hasExtraObjects: false,
      productIdentifiable: true,
      detailsVisible: true,
      colorAccuracyRisk: "low",
      lightingQuality: "good",
      blurRisk: "none",
      noiseLevel: "low",
      jpegArtifacts: false,
      shadowQuality: "clean",
      compositionBalance: 78,
      mainSubjectPromise: "flat-lay",
      poseIssues: false,
      garmentFitIssues: "none",
      detailFlaws: false,
      artifactIssues: false,
      summary: "本地无法解码像素，以下为模式化估计值。",
      confidence: 0.2,
    };
  }
  const whiteness = Math.round(m.borderWhiteness * 100);
  const textLevel = m.highContrastRowRatio;
  const colorful = m.saturationRatio * 100;
  const spread = m.lumaSd;
  const coverageModel = Math.round(Math.max(35, Math.min(88, m.centerInkRatio * 130 + 45)));
  const textInImage = textLevel < 0.06 ? "none" : textLevel < 0.12 ? "minimal" : textLevel < 0.22 ? "moderate" : "heavy";
  const noisy = m.lumaSd > 46 || m.darkRatio > 0.3;
  const dark = m.lumaMean < 96;
  const flat = m.lumaSd < 14;
  return {
    backgroundWhitenessJudged: Math.max(30, Math.min(99, Math.round(whiteness * 0.96 + 4))),
    hasText: textLevel > 0.05,
    textCoverage: Math.round(Math.min(100, textLevel * 420)),
    textInImage,
    hasWatermark: textLevel > 0.2 && m.centerInkRatio < 0.3,
    hasContactInfo: false,
    productCoverage: coverageModel,
    subjectClipped: m.centerInkRatio < 0.3,
    hasExtraObjects: colorful > 62 || m.borderSd > 46,
    productIdentifiable: coverageModel > 45,
    detailsVisible: spread > 16 && coverageModel > 55,
    colorAccuracyRisk: dark || colorful > 70 ? "high" : noisy ? "medium" : "low",
    lightingQuality: dark ? "dim" : flat ? "flat" : noisy ? "harsh" : "good",
    blurRisk: m.borderSd < 8 && spread < 20 ? "slight" : "none",
    noiseLevel: m.lumaSd > 56 ? "high" : noisy ? "medium" : "low",
    jpegArtifacts: measurement.format === "jpeg" && m.lumaSd > 50,
    shadowQuality: whiteness > 88 ? "clean" : whiteness > 60 ? "harsh" : "messy",
    compositionBalance: Math.round(Math.max(30, Math.min(96, m.centerInkRatio * 120 + 40))),
    mainSubjectPromise: coverageModel > 78 ? "closeup" : colorful > 40 ? "model-wearing" : "flat-lay",
    poseIssues: false,
    garmentFitIssues: "none",
    detailFlaws: m.darkRatio > 0.42,
    artifactIssues: m.lumaSd > 60,
    summary: `[模式化估计] 背景实测白度 ${whiteness}%，主体占比约 ${coverageModel}%，画面明暗离散度 ${spread}，据此推断的质检事实。`,
    confidence: 0.35,
  };
}

/**
 * Ask a multimodal model for the fact object.
 * @param {object} params
 * @param {object} params.config - resolved configuration.
 * @param {object} params.checklist - validated checklist.
 * @param {object} params.measurement - measurement bundle.
 * @param {Buffer} params.buffer - raw image bytes.
 * @returns {Promise<{facts: object, meta: object}>} facts plus provenance.
 */
export async function analyzeVision({ config, checklist, measurement, buffer }) {
  const started = Date.now();
  const prompt = buildVisionPrompt({ checklist, measurement });
  const images = [{ buffer, format: measurement.format }];
  const first = await callOnce({
    config,
    messages: { system: prompt.system, user: prompt.user },
    images,
  });
  let facts = extractJson(first.text);
  let repaired = false;
  let answered = first;
  if (!facts) {
    repaired = true;
    answered = await callOnce({
      config,
      messages: { system: prompt.system, user: buildRepairPrompt(first.text) },
      images,
    });
    facts = extractJson(answered.text);
  }
  if (!facts) {
    throw new VisionError("视觉模型两次都未返回可解析的 JSON 事实对象", "UNPARSEABLE");
  }
  const { summary, confidence, ...fields } = facts;
  // Coerce/drop values that do not match the fact catalogue before the rules see
  // them; an out-of-vocabulary answer must not turn into a "product defect".
  const normalized = normalizeModelFacts(fields);
  // A repair retry is a second billable call: merge both so tokens and money agree.
  const usage = repaired ? mergeUsage(first.usage, answered.usage) : (answered.usage ?? first.usage ?? null);
  const cost = costOf({ provider: config.provider, model: answered.model ?? config.model, usage });
  return {
    facts: normalized.facts,
    meta: {
      provider: config.provider,
      model: answered.model ?? config.model,
      ms: Date.now() - started,
      usage,
      cost: cost ? { ...cost, calls: repaired ? 2 : 1 } : undefined,
      repaired,
      truncated: first.finishReason === "length" || first.finishReason === "max_tokens",
      finishReason: answered.finishReason ?? first.finishReason ?? null,
      reasoning: answered.reasoning ?? "",
      reason: typeof summary === "string" ? summary : "",
      confidence: typeof confidence === "number" ? confidence : null,
      normalized: { dropped: normalized.dropped, coerced: normalized.coerced },
      mode: "live",
    },
  };
}

/**
 * One multi-image call comparing every image in a SKU group.
 * @param {object} params
 * @param {object} params.config - resolved configuration.
 * @param {Array<{name: string, measurement: object, report?: object, buffer: Buffer}>} params.entries
 * @returns {Promise<{semantic: object, meta: object}>} the comparison answer plus provenance.
 */
export async function analyzeConsistency({ config, entries }) {
  const started = Date.now();
  const prompt = buildConsistencyPrompt({ entries });
  const images = entries.map((entry) => ({ buffer: entry.buffer, format: entry.measurement.format }));
  const first = await callOnce({
    config,
    messages: { system: prompt.system, user: prompt.user },
    images,
  });
  let answer = extractJson(first.text);
  let repaired = false;
  let answered = first;
  if (!answer) {
    repaired = true;
    answered = await callOnce({
      config,
      messages: { system: prompt.system, user: buildRepairPrompt(first.text) },
      images,
    });
    answer = extractJson(answered.text);
  }
  if (!answer) throw new VisionError("多图比对未返回可解析的 JSON", "UNPARSEABLE");
  const usage = repaired ? mergeUsage(first.usage, answered.usage) : (answered.usage ?? first.usage ?? null);
  const cost = costOf({ provider: config.provider, model: answered.model ?? config.model, usage });
  return {
    semantic: answer,
    meta: {
      provider: config.provider,
      model: answered.model ?? config.model,
      ms: Date.now() - started,
      usage,
      cost: cost ? { ...cost, calls: repaired ? 2 : 1 } : undefined,
      repaired,
      mode: "live",
    },
  };
}

export { VisionError };
