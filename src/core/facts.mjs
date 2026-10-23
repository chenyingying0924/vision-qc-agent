/**
 * Fact catalogue — the shared vocabulary between the checklist, the vision
 * prompt and the rule engine.
 *
 * Every rule asserts against a *fact*: something the vision model reports as
 * a normalised field (`hasText`), or something the pipeline measures itself
 * (`width`, `fileSizeKB`). Keeping both in one catalogue is what lets the
 * prompt tell the model exactly which fields to emit, and lets the UI offer a
 * dropdown instead of free text.
 *
 * Kinds and scoring conventions:
 * - `percent`  0-100, higher = more of the thing ("how white is the backdrop")
 * - `bool`     true/false
 * - `enum`     one of `values`
 * - `number`   raw number, scored against an explicit range in the rule
 *
 * @module vision-qc-agent/core/facts
 */

export const FACT_CATALOG = {
  /* ---- measured by the pipeline (ground truth, never asked of the model) ---- */
  "format": { kind: "enum", values: ["png", "jpeg", "webp", "gif"], label: "文件格式", source: "pipeline" },
  "width": { kind: "number", label: "像素宽", source: "pipeline" },
  "height": { kind: "number", label: "像素高", source: "pipeline" },
  "minSide": { kind: "number", label: "最短边像素", source: "pipeline" },
  "megapixels": { kind: "number", label: "总像素（百万）", source: "pipeline" },
  "fileSizeKB": { kind: "number", label: "文件大小（KB）", source: "pipeline" },
  "aspectLabel": {
    kind: "enum",
    values: ["square-1x1", "portrait-3x4", "portrait-4x5", "portrait", "landscape", "landscape-4x3", "landscape-16x9", "unknown"],
    label: "画幅比例",
    source: "pipeline",
  },
  "backgroundWhiteness": { kind: "percent", label: "背景白度（实测）", source: "pipeline" },
  "backgroundUniformity": { kind: "percent", label: "背景均匀度（实测）", source: "pipeline" },
  "centerCoverage": { kind: "percent", label: "主体居中占比（实测）", source: "pipeline" },
  "saturationRatio": { kind: "percent", label: "画面色彩占比（实测）", source: "pipeline" },
  "brightnessSd": { kind: "percent", label: "明暗离散度（实测）", source: "pipeline" },

  /* ---- judged by the vision model ---- */
  "backgroundWhitenessJudged": { kind: "percent", label: "背景是否纯白" },
  "hasText": { kind: "bool", label: "画面含文字" },
  "textCoverage": { kind: "percent", label: "文字覆盖面积占比" },
  "textIsPromotional": { kind: "bool", label: "文字为促销/营销文案" },
  "hasWatermark": { kind: "bool", label: "含水印或第三方 Logo" },
  "hasContactInfo": { kind: "bool", label: "含联系方式" },
  "productCoverage": { kind: "percent", label: "主体占画面比例" },
  "subjectClipped": { kind: "bool", label: "主体被裁切" },
  "hasExtraObjects": { kind: "bool", label: "存在无关物体或杂乱背景" },
  "textInImage": { kind: "enum", values: ["none", "minimal", "moderate", "heavy"], label: "画面文字量等级" },
  "productIdentifiable": { kind: "bool", label: "商品品类可识别" },
  "detailsVisible": { kind: "bool", label: "关键细节（材质/工艺）可见" },
  "colorAccuracyRisk": { kind: "enum", values: ["low", "medium", "high"], label: "色差风险" },
  "lightingQuality": { kind: "enum", values: ["good", "flat", "harsh", "dim"], label: "布光质量" },
  "blurRisk": { kind: "enum", values: ["none", "slight", "obvious"], label: "模糊程度" },
  "noiseLevel": { kind: "enum", values: ["low", "medium", "high"], label: "噪点/压缩痕迹" },
  "jpegArtifacts": { kind: "bool", label: "可见压缩伪影" },
  "shadowQuality": { kind: "enum", values: ["clean", "harsh", "absent", "messy"], label: "投影表现" },
  "compositionBalance": { kind: "percent", label: "构图平衡度" },
  "mainSubjectPromise": { kind: "enum", values: ["model-wearing", "flat-lay", "hanging", "closeup", "other"], label: "主图呈现方式" },
  "poseIssues": { kind: "bool", label: "模特姿态/穿搭存在问题" },
  "garmentFitIssues": { kind: "enum", values: ["none", "minor", "obvious"], label: "版型或穿着问题" },
  "detailFlaws": { kind: "bool", label: "可见细节瑕疵（线头/污渍/褶皱）" },
  "artifactIssues": { kind: "bool", label: "存在生成类伪影/畸变" },

  /* ---- information architecture: detail pages, live covers, design reviews ---- */
  "imageRole": {
    kind: "enum",
    values: ["hero", "scene", "detail", "parameter", "size-chart", "packaging", "banner", "other"],
    label: "图片用途",
  },
  "imageRoleConfidence": { kind: "percent", label: "图片用途可辨识度" },
  "textReadability": { kind: "enum", values: ["clear", "acceptable", "blurry", "unreadable"], label: "文字可读性" },
  "textDensity": { kind: "percent", label: "文字占画面比例" },
  "textOccludesSubject": { kind: "bool", label: "文字遮挡主体" },
  "visualHierarchy": { kind: "percent", label: "视觉层级清晰度" },
  "whiteSpaceBalance": { kind: "percent", label: "留白均衡度" },
  "thumbnailLegibility": { kind: "percent", label: "缩略图可辨识度" },
  "impact": { kind: "enum", values: ["strong", "average", "weak"], label: "画面冲击力" },
  "hasQrCode": { kind: "bool", label: "含二维码" },
  "isPricePromo": { kind: "bool", label: "含价格或促销信息" },
  "brandColorConsistent": { kind: "bool", label: "品牌色一致" },
  "typographyConsistent": { kind: "bool", label: "字体层级一致" },
  "marginsEven": { kind: "bool", label: "边距对齐规整" },
  "edgeQuality": { kind: "enum", values: ["clean", "slightly-jagged", "jagged"], label: "元素边缘质量" },
  "hasPlaceholder": { kind: "bool", label: "含未替换占位元素" },
  "assetMissing": { kind: "bool", label: "存在缺失或空图元素" },
  "elementOverflow": { kind: "bool", label: "元素溢出画布" },
  "shadowCredibility": { kind: "percent", label: "投影可信度" },
};

/** Human-facing suggestion for each enum value, used in report recommendations. */
export const ENUM_HINTS = {
  "textInImage": { none: "画面无文字", minimal: "仅少量必要标识", moderate: "文字偏多，建议压缩到 10% 以内", heavy: "文字过多，会遮挡商品主体" },
  "colorAccuracyRisk": { low: "色彩还原可信", medium: "建议核对色卡或补拍", high: "色差风险高，需重拍或换光源" },
  "lightingQuality": { good: "布光均匀专业", flat: "光线偏平，缺乏体积感", harsh: "光比过硬，出现死黑或过曝", dim: "整体偏暗" },
  "blurRisk": { none: "清晰", slight: "轻微发虚", obvious: "明显模糊，不可用" },
  "noiseLevel": { low: "画面干净", medium: "有可见噪点", high: "噪点明显，建议降噪或重拍" },
  "shadowQuality": { clean: "投影自然", harsh: "投影生硬", absent: "缺少投影，主体发飘", messy: "投影杂乱" },
  "garmentFitIssues": { none: "版型正常", minor: "轻微不平整", obvious: "版型异常，易引发退货" },
  "mainSubjectPromise": { "model-wearing": "模特上身图", "flat-lay": "平铺图", hanging: "挂拍图", closeup: "细节特写", other: "其他呈现方式" },
  "imageRole": {
    hero: "首图/主图",
    scene: "场景图",
    detail: "细节图",
    parameter: "参数图",
    "size-chart": "尺码表",
    packaging: "包装图",
    banner: "横幅/海报",
    other: "用途不明",
  },
  "textReadability": { clear: "文字清晰可读", acceptable: "可读但偏小", blurry: "文字发虚", unreadable: "文字不可读" },
  "impact": { strong: "冲击力强", average: "冲击力一般", weak: "平淡无吸引力" },
  "edgeQuality": { clean: "边缘干净", "slightly-jagged": "边缘轻微毛糙", jagged: "边缘明显锯齿/毛边" },
};

/** Facts the model must return, in prompt order. */
export const MODEL_FACTS = Object.entries(FACT_CATALOG)
  .filter(([, descriptor]) => descriptor.source !== "pipeline")
  .map(([key, descriptor]) => ({ key, ...descriptor }));

/* ------------------------------------------------------------------ */
/* Model output normalisation                                          */
/* ------------------------------------------------------------------ */

const BOOL_TRUE = new Set(["true", "1", "yes", "y", "是", "有"]);
const BOOL_FALSE = new Set(["false", "0", "no", "n", "否", "无"]);

function coerceBool(value) {
  if (typeof value === "boolean") return { value };
  if (typeof value === "number" && (value === 0 || value === 1)) return { value: value === 1, coerced: true };
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (BOOL_TRUE.has(token)) return { value: true, coerced: true };
    if (BOOL_FALSE.has(token)) return { value: false, coerced: true };
  }
  return { dropped: true };
}

function coerceNumber(value, { min, max } = {}) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.replace(/[%％]$/, "").trim())
      : Number.NaN;
  if (!Number.isFinite(parsed)) return { dropped: true };
  let next = parsed;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return { value: next, coerced: next !== parsed };
}

function coerceEnum(value, allowed) {
  if (typeof value !== "string") return { dropped: true };
  const trimmed = value.trim();
  if (allowed.includes(trimmed)) return { value: trimmed, coerced: trimmed !== value };
  const squash = (text) => text.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const needle = squash(trimmed);
  const hit = allowed.find((candidate) => squash(candidate) === needle);
  return hit ? { value: hit, coerced: true } : { dropped: true };
}

/**
 * Validate model output against the fact catalogue before it reaches the rules.
 *
 * The rules compare strictly (`raw === "none"`, `raw === false`), so a model that
 * answers `"None"`, `"none "` or `"false"` used to be reported as a *product
 * defect* — "实测 false / 要求 == false / 不通过" — which is both wrong and
 * unfalsifiable by the reader. Values are coerced when the intent is
 * unambiguous; anything else is **dropped**, so the rule degrades to `unknown`
 * ("拿不到数据，请人工复核") instead of inventing a failure.
 *
 * @param {object} raw - parsed JSON fields from the model.
 * @returns {{facts: object, dropped: string[], coerced: Array<{key: string, from: *, to: *}>}}
 */
export function normalizeModelFacts(raw = {}) {
  const facts = {};
  const dropped = [];
  const coerced = [];
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === null || value === undefined) {
      dropped.push(key);
      continue;
    }
    const spec = FACT_CATALOG[key];
    // Unknown keys and pipeline-owned facts are not the model's to answer.
    if (!spec || spec.source === "pipeline") {
      // `judge` rules read `<fact>Reason` for the model's justification
      // (`rules.mjs` builds the key dynamically), so those siblings must survive.
      const base = String(key).endsWith("Reason") ? String(key).slice(0, -"Reason".length) : "";
      if (base && FACT_CATALOG[base] && (typeof value === "string" || typeof value === "number")) {
        facts[key] = String(value).slice(0, 500);
        continue;
      }
      dropped.push(key);
      continue;
    }
    const result = spec.kind === "bool"
      ? coerceBool(value)
      : spec.kind === "percent"
        ? coerceNumber(value, { min: 0, max: 100 })
        : spec.kind === "enum"
          ? coerceEnum(value, spec.values ?? [])
          : coerceNumber(value);
    if (result.dropped) {
      dropped.push(key);
      continue;
    }
    facts[key] = result.value;
    if (result.coerced) coerced.push({ key, from: value, to: result.value });
  }
  return { facts, dropped, coerced };
}

