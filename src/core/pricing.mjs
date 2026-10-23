/**
 * Token accounting and cost estimation.
 *
 * Procurement always asks "what does one batch cost?", so the pipeline records
 * usage per image and this module turns it into money. Rates live here as data,
 * not code, and each row carries its source so a number on a slide can be traced.
 *
 * Three vendor details that are easy to get wrong and are handled explicitly:
 * - **Cache hit and cache miss are separate, disjoint buckets.** The full
 *   `prompt_tokens` must never be charged at the miss rate.
 * - **Reasoning tokens are already inside completion tokens.** They are reported
 *   for transparency but never added to the total a second time.
 * - **DeepSeek prices by time of day** (off-peak is half price), so a run that
 *   straddles the boundary needs split pricing — see {@link isOffPeak}.
 *
 * @module vision-qc-agent/core/pricing
 */

/**
 * Rate card: USD per 1,000,000 tokens.
 *
 * `input` = cache-miss (standard) input, `cachedInput` = cache-hit input,
 * `output` = completion tokens (reasoning included).
 */
export const RATE_CARD = {
  deepseek: {
    currency: "USD",
    unit: "per 1M tokens",
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    checkedAt: "2026-09-17",
    offPeak: {
      factor: 0.5,
      label: "错峰 5 折",
      window: "周一至周五 01:00–04:00 与 06:00–10:00 UTC 为高峰，其余为错峰",
    },
    models: {
      "deepseek-flash": { input: 0.3, cachedInput: 0.006, output: 1.2, label: "DeepSeek V4.1 Flash" },
      "deepseek-v4-flash": { input: 0.3, cachedInput: 0.006, output: 1.2, label: "DeepSeek V4.1 Flash（旧 id，同价）" },
      "deepseek-v4-flash-vision-exp": { input: 0.3, cachedInput: 0.006, output: 1.2, label: "DeepSeek V4.1 Flash Vision" },
      "deepseek-v4-pro": { input: 1.32, cachedInput: 0.044, output: 3.96, label: "DeepSeek V4 Pro" },
    },
  },
  anthropic: {
    currency: "USD",
    unit: "per 1M tokens",
    source: "https://claude.com/pricing#api",
    checkedAt: "2026-09-17",
    models: {
      "claude-sonnet-5": { input: 2, cachedInput: 0.2, output: 10, label: "Claude Sonnet 5" },
      "claude-opus-5": { input: 5, cachedInput: 0.5, output: 25, label: "Claude Opus 5" },
      "claude-haiku-4-5": { input: 1, cachedInput: 0.1, output: 5, label: "Claude Haiku 4.5" },
      "claude-3-5-sonnet-latest": { input: 3, cachedInput: 0.3, output: 15, label: "Claude 3.5 Sonnet（legacy）" },
    },
  },
  openai: {
    currency: "USD",
    unit: "per 1M tokens",
    // Official pricing pages were unreachable from the environment that built
    // this table, so the rows carry an explicit caveat rather than false authority.
    source: "https://openai.com/api/pricing/",
    checkedAt: "unverified",
    unverified: "官方定价页在构建环境中不可访问，以下为二手来源（OpenRouter）数字，使用前请自行核对",
    models: {
      "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6, label: "GPT-4o mini" },
      "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10, label: "GPT-4o" },
      "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6, label: "GPT-4.1 mini" },
    },
  },
  mock: {
    currency: "USD",
    unit: "per 1M tokens",
    source: "local heuristic — no model call",
    checkedAt: "2026-09-17",
    models: {
      "deterministic-pixel-heuristics": { input: 0, cachedInput: 0, output: 0, label: "本地兜底（不调用模型）" },
    },
  },
};

/**
 * DeepSeek charges half price outside peak hours.
 * Peak = Mon–Fri 01:00–04:00 and 06:00–10:00 UTC.
 * @param {Date|string|number} [at] - request time; defaults to now.
 * @returns {boolean} true when off-peak pricing applies.
 */
export function isOffPeak(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return true;
  const hour = date.getUTCHours();
  const peak = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  return !peak;
}

/** Look up a model's rates, falling back to the provider's first row. */
export function ratesFor(provider, model, { at = new Date(), applyOffPeak = true } = {}) {
  const card = RATE_CARD[provider];
  if (!card) return undefined;
  const exact = card.models[model];
  const row = exact ?? Object.values(card.models)[0];
  if (!row) return undefined;
  const offPeakFactor = applyOffPeak && card.offPeak && isOffPeak(at) ? card.offPeak.factor : 1;
  return {
    ...row,
    input: row.input * offPeakFactor,
    cachedInput: row.cachedInput * offPeakFactor,
    output: row.output * offPeakFactor,
    provider,
    model,
    source: card.source,
    checkedAt: card.checkedAt,
    currency: card.currency,
    offPeak: offPeakFactor !== 1,
    offPeakLabel: card.offPeak?.label,
    exact: Boolean(exact),
    unverified: card.unverified,
    note: exact ? undefined : `未在费率表中找到 "${model}"，按 ${Object.keys(card.models)[0]} 的费率估算`,
  };
}

/**
 * Normalise the usage shapes different vendors return into one record.
 * @param {object|undefined} usage - raw vendor usage, or a local counter.
 * @returns {{input: number, inputMiss: number, cachedInput: number, output: number, reasoning: number, total: number}}
 */
export function normalizeUsage(usage) {
  const raw = usage ?? {};
  const cachedFromDetails = raw.prompt_tokens_details?.cached_tokens;
  const cachedInput = Number(
    raw.prompt_cache_hit_tokens ?? raw.cachedInputTokens ?? cachedFromDetails ?? raw.cache_read_input_tokens ?? 0,
  );
  const input = Number(raw.prompt_tokens ?? raw.inputTokens ?? raw.input_tokens ?? 0);
  const output = Number(raw.completion_tokens ?? raw.outputTokens ?? raw.output_tokens ?? 0);
  // Reported for transparency only: these are already inside `output`.
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoningTokens ?? 0);
  return {
    input,
    inputMiss: Math.max(0, input - cachedInput),
    cachedInput,
    output,
    reasoning,
    total: Number(raw.total_tokens ?? input + output),
  };
}

/**
 * Merge several vendor usage objects into one.
 *
 * A repair retry is a second billable call. Summing the usage keeps the token
 * totals honest and makes them agree with the money, instead of showing only
 * the last call's tokens while charging for both.
 *
 * @param {...(object|undefined)} usages
 * @returns {object} a single usage object shaped like the vendors' own.
 */
export function mergeUsage(...usages) {
  const total = { input: 0, cachedInput: 0, output: 0, reasoning: 0, calls: 0 };
  for (const usage of usages) {
    const normalized = normalizeUsage(usage);
    total.input += normalized.input;
    total.cachedInput += normalized.cachedInput;
    total.output += normalized.output;
    total.reasoning += normalized.reasoning;
    total.calls += 1;
  }
  return {
    prompt_tokens: total.input,
    completion_tokens: total.output,
    total_tokens: total.input + total.output,
    prompt_cache_hit_tokens: total.cachedInput,
    prompt_cache_miss_tokens: Math.max(0, total.input - total.cachedInput),
    prompt_tokens_details: { cached_tokens: total.cachedInput },
    completion_tokens_details: { reasoning_tokens: total.reasoning },
    calls: total.calls,
  };
}

/**
 * Cost of one call.
 *
 * `(input - cached) * inputRate + cached * cachedInputRate + output * outputRate`
 *
 * @param {{provider: string, model: string, usage?: object, at?: Date|string}} params
 * @returns {{currency: string, total: number, breakdown: object, rates: object, tokens: object}|undefined}
 */
export function costOf({ provider, model, usage, at = new Date() }) {
  const rates = ratesFor(provider, model, { at });
  if (!rates) return undefined;
  const tokens = normalizeUsage(usage);
  const perToken = 1 / 1_000_000;
  const breakdown = {
    input: tokens.inputMiss * rates.input * perToken,
    cachedInput: tokens.cachedInput * rates.cachedInput * perToken,
    output: tokens.output * rates.output * perToken,
  };
  return {
    currency: rates.currency,
    total: breakdown.input + breakdown.cachedInput + breakdown.output,
    breakdown,
    tokens,
    rates: {
      input: rates.input,
      cachedInput: rates.cachedInput,
      output: rates.output,
      source: rates.source,
      checkedAt: rates.checkedAt,
      exact: rates.exact,
      offPeak: rates.offPeak,
      offPeakLabel: rates.offPeakLabel,
      unverified: rates.unverified,
      note: rates.note,
    },
  };
}

/** Add up per-image costs into a batch-level money panel. */
export function summarizeCost(entries) {
  const priced = entries.filter((entry) => entry?.cost);
  const sum = (pick) => priced.reduce((total, entry) => total + pick(entry), 0);
  const images = priced.length;
  const total = sum((entry) => entry.cost.total);
  const tokens = {
    input: sum((entry) => entry.cost.tokens.input),
    inputMiss: sum((entry) => entry.cost.tokens.inputMiss),
    cachedInput: sum((entry) => entry.cost.tokens.cachedInput),
    output: sum((entry) => entry.cost.tokens.output),
    reasoning: sum((entry) => entry.cost.tokens.reasoning),
    total: sum((entry) => entry.cost.tokens.total),
  };
  const ms = entries.reduce((acc, entry) => acc + (Number(entry?.ms) || 0), 0);
  const rateRow = priced[0]?.cost.rates;
  return {
    images,
    unpriced: entries.length - priced.length,
    currency: priced[0]?.cost.currency ?? "USD",
    total,
    perImage: images > 0 ? total / images : 0,
    tokens,
    tokensPerImage: images > 0 ? Math.round(tokens.total / images) : 0,
    /** Share of prompt tokens served from cache — the single biggest cost lever. */
    cachedRatio: tokens.input > 0 ? tokens.cachedInput / tokens.input : 0,
    /** What the same batch would have cost with no cache hits (shows its value). */
    noCacheTotal: priced.reduce((acc, entry) => {
      const rates = entry.cost.rates;
      const t = entry.cost.tokens;
      return acc + t.input * rates.input * 1e-6 + t.output * rates.output * 1e-6;
    }, 0),
    modelMs: ms,
    rates: rateRow
      ? {
          input: rateRow.input,
          cachedInput: rateRow.cachedInput,
          output: rateRow.output,
          source: rateRow.source,
          checkedAt: rateRow.checkedAt,
          offPeak: rateRow.offPeak,
          unverified: rateRow.unverified,
        }
      : null,
  };
}

/** Format money for terminals and reports at a sane precision. */
export function formatMoney(amount, currency = "USD") {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (amount === 0) return `${symbol}0`;
  if (amount < 0.0001) return `${symbol}${amount.toExponential(2)}`;
  if (amount < 0.01) return `${symbol}${amount.toFixed(6)}`;
  if (amount < 1) return `${symbol}${amount.toFixed(4)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Extrapolate a batch's unit cost to realistic monthly volumes — the number
 * that actually decides whether the tool ships.
 */
export function projection(perImageCost, currency = "USD", volumes = [1000, 10_000, 100_000]) {
  return volumes.map((volume) => ({ volume, cost: perImageCost * volume, currency }));
}

/**
 * Compare peak vs off-peak unit cost so a batch job can be scheduled.
 * @param {{provider?: string, model?: string, inputTokens?: number, outputTokens?: number}} params
 */
export function scheduleAdvice({
  provider = "deepseek",
  model = "deepseek-flash",
  inputTokens = 2874,
  outputTokens = 1022,
} = {}) {
  const usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, prompt_cache_hit_tokens: 0 };
  // 2026-09-17 是周四：02:00Z 落在高峰，12:00Z 落在错峰。
  const peak = costOf({ provider, model, usage, at: "2026-09-17T02:00:00Z" });
  const offPeak = costOf({ provider, model, usage, at: "2026-09-17T12:00:00Z" });
  if (!peak || !offPeak) return null;
  return {
    peak: peak.total,
    offPeak: offPeak.total,
    savingPerImage: peak.total - offPeak.total,
    savingRate: peak.total > 0 ? 1 - offPeak.total / peak.total : 0,
    advice: "把批量质检排到错峰时段可省约一半成本：高峰为周一至周五 01:00–04:00 与 06:00–10:00 UTC，其余时间均为错峰。",
  };
}
