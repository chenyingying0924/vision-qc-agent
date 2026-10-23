# LLM API price reference for a batch cost panel

> 研究留档：成本面板的费率依据与核对日期。费率表在 `src/core/pricing.mjs`。


**Verification date: 2026-09-17 (UTC).** All figures below are **USD per 1,000,000 tokens (per 1M)** unless a row says otherwise.
Every official figure was read from the vendor's own pricing/docs page on 2026-09-17; the OpenAI section could **not** be verified (see §3).

---

## 1. DeepSeek — OFFICIAL, verified

Source: [Models & Pricing (EN)](https://api-docs.deepseek.com/quick_start/pricing) · [模型 & 价格 (ZH)](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
Page states verbatim: *"The prices listed below are in units of per 1M tokens."* The page shows no "last updated" timestamp; the change log dates the current price table to **2026-09-10 04:00 UTC** ([Change Log](https://api-docs.deepseek.com/updates), [news 2026-09-10](https://api-docs.deepseek.com/news/news260910)).

| Model (`model=` string) | Input: cache **hit** | Input: cache **miss** (standard) | Output |
|---|---|---|---|
| `deepseek-flash` (DeepSeek-V4.1-Flash) — **off-peak** | **$0.003** | **$0.15** | **$0.60** |
| `deepseek-flash` — **peak** | **$0.006** | **$0.30** | **$1.20** |
| `deepseek-v4-pro` — **off-peak** | **$0.022** | **$0.66** | **$1.98** |
| `deepseek-v4-pro` — **peak** | **$0.044** | **$1.32** | **$3.96** |

- **Off-peak discount: YES — off-peak = 50% of peak.** Peak hours are **01:00–04:00 and 06:00–10:00 UTC, Monday–Friday**; all other hours are off-peak ([pricing page](https://api-docs.deepseek.com/quick_start/pricing) footnote 3; Chinese page phrases it as Beijing time Mon–Fri 09:00–12:00 and 14:00–18:00).
- **`deepseek-chat` / `deepseek-reasoner` are NOT on the current price list.** They were scheduled for discontinuation on **2026-07-24** ([Change Log, 2026-04-24](https://api-docs.deepseek.com/updates)). Build the panel on `deepseek-flash` / `deepseek-v4-pro`, not on the old names.
- Legacy model names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted but are **routed to V4.1-Flash and billed at Flash prices** ([pricing page](https://api-docs.deepseek.com/quick_start/pricing) footnote 1).
- `deepseek-v4-pro` footnote 2: DeepSeek decided to **keep serving V4 Pro after 2026-09-14 with unchanged billing** — the price rows above are still live. (The 2026-09-10 news post says V4-Pro was being phased out; the pricing page + change log, both read 2026-09-17, supersede that.)
- **Vision:** only `deepseek-flash` accepts images; `deepseek-v4-pro` does not ([pricing page](https://api-docs.deepseek.com/quick_start/pricing), [Vision guide](https://api-docs.deepseek.com/guides/vision)).
- **Usage fields** (what your tool records) are documented in [Context Caching](https://api-docs.deepseek.com/guides/kv_cache): `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`, and `prompt_tokens = hit + miss`.

**Cost formula (DeepSeek):** `cost = hit_tokens×hit_price + miss_tokens×miss_price + completion_tokens×output_price`, all divided by 1e6.
If the response only has `prompt_tokens_details.cached_tokens`, derive: `hit = cached_tokens`, `miss = prompt_tokens − cached_tokens`.

---

## 2. Anthropic — OFFICIAL, verified

Source: [claude.com/pricing → API](https://claude.com/pricing#api) (read 2026-09-17). Page prices are labelled **"/ MTok"** = per 1M tokens, and state: *"Save 50% with batch processing."*

| Model | Input | Output | Cache **read** | Cache **write** |
|---|---|---|---|---|
| **Sonnet 5** (current Sonnet) | $2.00 | $10.00 | $0.20 | $2.50 |
| Opus 5 | $5.00 | $25.00 | $0.50 | $6.25 |
| Haiku 4.5 | $1.00 | $5.00 | $0.10 | $1.25 |
| Fable 5.1 | $10.00 | $50.00 | $0.25 | $12.50 |
| *Legacy:* Sonnet 4.6 / Sonnet 4.5 | $3.00 | $15.00 | $0.30 | $3.75 |
| *Legacy:* Opus 4.8 / 4.7 / 4.6 / 4.5 | $5.00 | $25.00 | $0.50 | $6.25 |
| *Legacy:* Fable 5 | $10.00 | $50.00 | $1.00 | $12.50 |

- **`claude-3-5-sonnet` / `claude-3-7-sonnet` are not listed anymore** on the official pricing page. Their current equivalents are **Sonnet 5** ($2/$10) and, for older pinned deployments, **Sonnet 4.6 / 4.5** ($3/$15). I could not verify an official retirement date because `platform.claude.com` docs are geo-blocked from this environment ("app-unavailable-in-region").
- Cache economics on this page: **read ≈ 0.1× input** (Sonnet 5 $0.20 vs $2; Sonnet 4.6 $0.30 vs $3; Haiku 4.5 $0.10 vs $1), and **write ≈ 1.25× input** ($2.50 vs $2.00 etc.). Exception on the page: Fable 5.1 cache read is $0.25 = 0.025× its $10 input.
- **Prompt caching price shown reflects 5-minute TTL**; a 1-hour cache TTL exists and is documented separately (link on the page: `...#1-hour-cache-duration`), but the doc body is blocked here — treat extended-TTL pricing as **unverified**.
- Other page-level charges: **US-only inference = 1.1× input and output**; **Opus 5 "fast mode" = 2× standard**; Web search $10 / 1K searches; Managed Agents $0.08/session-hour; code execution $0.05/container-hour after 50 free hours/day.

---

## 3. OpenAI — **NOT VERIFIED** (official pages unreachable from this environment)

`openai.com`, `platform.openai.com`, `developers.openai.com` and `help.openai.com` are **inaccessible here**:
`https://platform.openai.com/docs/pricing`, `/docs/models/gpt-4.1-mini`, and `https://developers.openai.com/api/docs/pricing` all return **HTTP 403 (Cloudflare "Sorry, you have been blocked")**, and `openai.com` does not even resolve from the shell (DNS blocked). **I therefore cannot confirm any OpenAI number from an official source, and I am not asserting the figures below as official.**

Secondary, **non-official** cross-check — [OpenRouter model list API](https://openrouter.ai/api/v1/models) (fetched 2026-09-17; OpenRouter is a reseller/aggregator, not OpenAI). Values are **per token**, converted here to per 1M:

| Model | Input /1M | Output /1M | Cached input /1M | OpenRouter raw (per token) |
|---|---|---|---|---|
| gpt-4o-mini | $0.15 | $0.60 | $0.075 | 0.00000015 / 0.0000006 / 0.000000075 |
| gpt-4o | $2.50 | $10.00 | $1.25 | 0.0000025 / 0.00001 / 0.00000125 |
| gpt-4o-2024-05-13 | $5.00 | $15.00 | — | 0.000005 / 0.000015 |
| gpt-4.1-mini | $0.40 | $1.60 | $0.10 | 0.0000004 / 0.0000016 / 0.0000001 |

**Action for the panel:** hard-code these only with a "verify against openai.com" flag; re-check `https://platform.openai.com/docs/pricing` from an IP that is not Cloudflare-blocked.

---

## 4. Per-1M vs per-1K — explicit check (the 1000× trap)

| Source | Unit as published | Multiply by |
|---|---|---|
| DeepSeek pricing page | "in units of per 1M tokens" (verbatim) | 1e6 tokens = 1 unit |
| Anthropic pricing page | "$X / MTok" | 1e6 tokens = 1 unit |
| OpenRouter API (OpenAI rows above) | **per single token** (e.g. `0.00000015`) | ×1e6 to get per-1M |

Implementation guard: store every rate as **USD per 1M tokens**, then `cost = tokens / 1_000_000 * rate`. Never mix a per-token rate into that expression.

---

## 5. Caveats for the cost panel

1. **Cache buckets are disjoint, and cached input is billed separately.** DeepSeek: `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`; hit and miss are charged at different rates. Do not charge `prompt_tokens` at the miss rate when hit tokens exist ([Context Caching](https://api-docs.deepseek.com/guides/kv_cache)).
2. **Reasoning tokens are not extra.** In the sample usage, `completion_tokens = 79` *includes* `completion_tokens_details.reasoning_tokens = 70`. Billing = `completion_tokens × output_rate`. Adding `reasoning_tokens` again would double-charge the largest part of the output.
3. **Off-peak depends on request timestamp, not batch completion time.** DeepSeek peak = Mon–Fri 01:00–04:00 & 06:00–10:00 UTC. A panel that stores one rate per run will mis-price runs that straddle the boundary.
4. **Batch discounts (as published).** Anthropic: *"Save 50% with batch processing"* ([claude.com/pricing](https://claude.com/pricing#api)). DeepSeek: **no batch/off-peak-batch discount is documented**; the only discount is peak/off-peak. OpenAI's Batch API 50% discount is widely documented but **could not be verified here** — treat as unverified.
5. **Minimum billing / rounding:** neither the DeepSeek pricing page nor the Anthropic pricing page states a minimum charge or per-request rounding; DeepSeek says only "expense = number of tokens × price". Assume pure linear billing, but treat any minimum as unconfirmed.
6. **Cache write cost differs by vendor.** DeepSeek has no separate write price on the page — an uncached prefix is simply billed at the **miss** rate (implied by the two published buckets). Anthropic *does* publish a separate **cache write** price ≈ 1.25× input plus a cache **read** price ≈ 0.1× input; charging only "input/output" understates Anthropic caching costs.
7. **Anthropic token fields differ from OpenAI/DeepSeek.** Anthropic returns `cache_read_input_tokens` / `cache_creation_input_tokens` alongside `input_tokens`; the cached portions are conventionally excluded from `input_tokens`, so total billed input = `input_tokens + cache_read + cache_creation`. This is standard practice, but I could not confirm it from official docs here (docs geo-blocked) — **verify before relying on it**.
8. **Image input accounting differs by vendor (biggest per-image risk).**
   - **DeepSeek (verified):** images are converted to tokens by dimensions and billed with text tokens at input rates. Every image is auto-resized: small images (<~544×544) are scaled up; large images are scaled down to roughly a **1300×1300** pixel budget. **Hard cap 1024 tokens per image**; multiple images are counted independently. `detail: "low"` downscales to **512×512**; `high`/`original`/`auto` keep the original ([Vision guide](https://api-docs.deepseek.com/guides/vision)). Practical consequence: image tokens land in the **cache-miss** bucket unless the exact prefix was cached.
   - **Anthropic / OpenAI:** both bill images as input tokens using their own tiling/patch formulas, but the docs are unreachable here (Anthropic docs geo-blocked, OpenAI 403). **Not verified — do not hard-code an image token formula for them from this report.** Anthropic reference URL (blocked here): [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing); OpenAI: [platform.openai.com/docs/pricing](https://platform.openai.com/docs/pricing).
9. **Cache hit rates are best-effort, never guaranteed** ("The cache system works on a 'best-effort' basis and does not guarantee a 100% cache hit rate", [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)). Do not project 100% cache-hit savings.
10. **Prices move.** DeepSeek repriced on 2026-09-10; the OpenAI and Anthropic pages carry no visible "last updated" stamp. Log the rate table's version/date alongside each computed batch total.

---

## 6. Worked example — the reported usage object on DeepSeek

Usage object:

```json
{"prompt_tokens":249,"completion_tokens":79,"total_tokens":328,
 "prompt_tokens_details":{"cached_tokens":0},
 "completion_tokens_details":{"reasoning_tokens":70},
 "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":249}
```

Inputs: `hit = 0`, `miss = 249`, `output = 79` (reasoning 70 is already inside output 79, so it is **not** added).

`deepseek-flash`, **peak** ($0.006 hit / $0.30 miss / $1.20 output per 1M):

```
hit    : 0   / 1e6 × $0.006 = $0.000000000
miss   : 249 / 1e6 × $0.30  = 249 × 0.0000003 = $0.000074700
output : 79  / 1e6 × $1.20  = 79  × 0.0000012 = $0.000094800
total  = $0.000169500   ≈ $1.695e-4 per image  ≈ 0.0170 US cents/image
```

`deepseek-flash`, **off-peak** (half rates):

```
miss   : 249 / 1e6 × $0.15 = $0.000037350
output : 79  / 1e6 × $0.60 = $0.000047400
total  = $0.000084750   ≈ $8.475e-5 per image ≈ 0.0085 US cents/image
```

`deepseek-v4-pro` (if this run used V4 Pro), **peak**: `249/1e6×$1.32 = $0.000328680` + `79/1e6×$3.96 = $0.000312840` = **$0.000641520/image**; **off-peak** = **$0.000320760/image**.

Reference batch sizes (flash, peak): 1,000 images = **$0.1695**; 100,000 images = **$16.95**.
Sanity check on the "0 tokens cached" case: had all 249 input tokens been cache hits instead, total would be `249/1e6×$0.006 + 79/1e6×$1.20 = $0.000096294` — the panel should show that cache hits barely matter at this prompt size, whereas they dominate large repeated prompts.

---

## 7. Sources (all read 2026-09-17 UTC)

- DeepSeek pricing: [https://api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing) · [中文](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
- DeepSeek change log (dates of price changes / model-name retirement): [https://api-docs.deepseek.com/updates](https://api-docs.deepseek.com/updates)
- DeepSeek V4.1-Flash release & price-cut date: [https://api-docs.deepseek.com/news/news260910](https://api-docs.deepseek.com/news/news260910)
- DeepSeek cache-hit/miss fields: [https://api-docs.deepseek.com/guides/kv_cache](https://api-docs.deepseek.com/guides/kv_cache)
- DeepSeek image tokens & limits: [https://api-docs.deepseek.com/guides/vision](https://api-docs.deepseek.com/guides/vision) · token calculator: [https://api-docs.deepseek.com/quick_start/token_usage](https://api-docs.deepseek.com/quick_start/token_usage)
- Anthropic pricing: [https://claude.com/pricing#api](https://claude.com/pricing#api) (canonical docs page [https://platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) is geo-blocked from here)
- Anthropic batch processing / prompt caching (linked from pricing page, bodies not fetchable here): [https://docs.claude.com/en/docs/build-with-claude/batch-processing](https://docs.claude.com/en/docs/build-with-claude/batch-processing) · [https://docs.claude.com/en/docs/build-with-claude/prompt-caching#pricing](https://docs.claude.com/en/docs/build-with-claude/prompt-caching#pricing)
- OpenAI pricing (**403 Cloudflare from this environment, unverified**): [https://platform.openai.com/docs/pricing](https://platform.openai.com/docs/pricing)
- Secondary (non-official) OpenAI cross-check: [https://openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models)
