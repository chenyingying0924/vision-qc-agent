/**
 * Vision prompt construction.
 *
 * The prompt is generated from the fact catalogue, so adding a rule field in
 * `facts.mjs` immediately changes what the model is asked for — no prompt drift.
 *
 * @module vision-qc-agent/vision/prompt
 */
import { MODEL_FACTS } from "../core/facts.mjs";

const KIND_HINT = {
  percent: "0-100 的整数（越高越“好”）",
  bool: "true 或 false",
  enum: "枚举字符串",
  number: "数字",
};

function describeFact(fact) {
  const parts = [`- "${fact.key}": ${fact.label}；${KIND_HINT[fact.kind]}`];
  if (fact.values) parts.push(`；可选值：${fact.values.map((value) => `"${value}"`).join(" | ")}`);
  return parts.join("");
}

/** Compact JSON of locally measured pixels, injected as ground truth. */
function measuredBlock(measurement) {
  if (!measurement.metrics) return null;
  const m = measurement.metrics;
  return {
    width: measurement.width,
    height: measurement.height,
    format: measurement.format,
    bytes: measurement.bytes,
    borderWhitenessPercent: Math.round(m.borderWhiteness * 1000) / 10,
    borderStdDev: m.borderSd,
    nearWhiteRatioPercent: Math.round(m.nearWhiteRatio * 1000) / 10,
    saturationRatioPercent: Math.round(m.saturationRatio * 1000) / 10,
    lumaMean: m.lumaMean,
    lumaStdDev: m.lumaSd,
    darkRatioPercent: Math.round(m.darkRatio * 1000) / 10,
    centerInkRatioPercent: Math.round(m.centerInkRatio * 1000) / 10,
    highContrastRowRatioPercent: Math.round(m.highContrastRowRatio * 1000) / 10,
  };
}

/**
 * Build the chat messages for one image.
 * @param {object} params
 * @param {object} params.checklist - validated checklist (its rules are listed so the model knows what it is feeding).
 * @param {object} params.measurement - measurement bundle for the image.
 * @returns {{system: string, user: string}} prompt halves.
 */
export function buildVisionPrompt({ checklist, measurement }) {
  const measured = measuredBlock(measurement);
  const system = [
    "你是一名严谨的电商图片质检视觉分析师。你的唯一职责是观察图片并输出结构化事实，不做最终判决——判决由本地规则引擎完成。",
    "",
    "输出要求：",
    "1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释性前后缀。",
    "2. 所有布尔字段必须给出 true/false，不要用字符串表示。",
    "3. 不确定时给出最保守（对商家更不利）的判断，并在 summary 中说明不确定性。",
    "4. 只描述你在图中确实看到的内容，不要臆测看不到的信息。",
    "5. 附带 \"summary\"（一句话中文概述，60 字以内）与 \"confidence\"（0-1 的整体置信度）。",
    "",
    "事实字典（必须全部返回）：",
    ...MODEL_FACTS.map(describeFact),
  ].join("\n");

  const user = [
    `请分析这张商品图片，按事实字典返回 JSON。本次质检清单为《${checklist.name}》，包含以下检查点（用于提示你重点关注哪些视觉特征）：`,
    "",
    ...checklist.rules.map((rule) => `- [${rule.id}] ${rule.title}`),
    "",
    measured
      ? [
          "以下指标已由本地程序对像素精确测量，请直接采信，不要与之矛盾：",
          JSON.stringify(measured, null, 2),
          "",
          "特别地，backgroundWhiteness 已由实测得出，请不要重新估计该数值；你的职责是判断语义层面的内容。",
        ].join("\n")
      : "本地未能解码该图片的像素（可能为 JPEG/WebP），请尽力给出全部字段的估计值。",
  ].join("\n");

  return { system, user };
}

/** Retry prompt used when the first answer was not parseable JSON. */
export function buildRepairPrompt(rawAnswer) {
  return [
    "你上一次的输出不是合法 JSON。请把它改写为**仅包含一个 JSON 对象**的回复，不要代码块标记，不要额外文字。",
    "",
    "上一次的输出：",
    "```",
    String(rawAnswer).slice(0, 4000),
    "```",
  ].join("\n");
}
