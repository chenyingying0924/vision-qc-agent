#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server.
 *
 * This is what makes the tool usable from a *host agent*: DSH (or any MCP client)
 * spawns this process, discovers the tools below, and can then decide on its own
 * to "check the images first, then write the copy" — the engine stops being a
 * page a human opens and becomes a capability an agent calls.
 *
 * Protocol notes (verified against `@modelcontextprotocol/sdk` 2025-11-25 and the
 * DSH client in `dsh-mcp-client`):
 * - newline-delimited JSON-RPC 2.0 on stdin/stdout, one object per line
 * - `initialize` → `notifications/initialized` → `tools/list` → `tools/call`
 * - responses may omit `structuredContent`; `content[].text` is what the host reads
 *
 * Run:  node src/mcp/server.mjs        (or `node src/cli.mjs mcp`)
 *
 * @module vision-qc-agent/mcp/server
 */
import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.mjs";
import { FeedbackStore, suggestAdjustments } from "../core/feedback.mjs";
import { costOf, formatMoney, projection, scheduleAdvice } from "../core/pricing.mjs";
import { inspectBatch, saveReports } from "../core/pipeline.mjs";
import { loadChecklists } from "../core/rules.mjs";

const SERVER_INFO = { name: "vision-qc-agent", version: "0.2.0" };
/** Echo the client's version when we know it; this is the version we prefer. */
const PREFERRED_PROTOCOL = "2025-06-18";
const KNOWN_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const TOOLS = [
  {
    name: "qc_list_checklists",
    description:
      "列出所有可用的视觉质检清单（主图 / 详情页 / 直播封面 / 设计稿走查），包含每份清单的规则编号、标题、严重度与阈值。在调用 qc_inspect_images 之前用它选择 checklistId。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "qc_inspect_images",
    description:
      "对一批本地图片路径执行视觉质检，返回每张图的分数、结论（合格/需优化/不合格）、逐条判定与整改建议，并在图片≥2张时给出 SKU 组一致性结论（色差、是否同一件商品）。会真实调用多模态模型并产生费用。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "图片文件的绝对或相对路径，2-12 个",
        },
        checklistId: {
          type: "string",
          description: "质检清单 id，例如 ecom-main-image / detail-page / live-cover / design-review。省略则用第一份。",
        },
        consistency: {
          type: "boolean",
          description: "是否做多图一致性检查（默认 true，仅当图片≥2张时生效）",
        },
        mock: {
          type: "boolean",
          description: "true 表示不调用模型、仅用本地像素兜底（离线可用，结论标为估计值）",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "qc_recent_reports",
    description:
      "列出本次进程内已缓存的历史质检结果（图片名、分数、结论、清单）。缓存键为「图片内容 + 清单 + 模型」，重复质检同一张图不会再次产生模型费用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "qc_threshold_advice",
    description:
      "读取质检员的人工推翻记录，给出规则阈值调整建议（例如某条主体占比规则被反复推翻，建议把阈值从 60% 下调到 54%）。用于回答「规则是不是定得太严」这类问题。",
    inputSchema: {
      type: "object",
      properties: {
        checklistId: { type: "string", description: "清单 id，省略则用第一份" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "qc_cost_estimate",
    description:
      "估算质检成本：按当前模型费率给出每张图成本、以及 1000/10000/100000 张的月度外推。回答「跑一批要花多少钱」时使用。",
    inputSchema: {
      type: "object",
      properties: {
        images: { type: "number", description: "本批图片数量，用于估算一批总成本" },
        avgImageBytes: { type: "number", description: "可选：单张图片平均字节数，用于粗略估算输入 token" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "qc_write_reports",
    description:
      "对一批图片执行质检并把 Markdown 报告落盘到 reports/<时间戳>/，返回目录路径。用于需要交付文件（而不是只在对话里看结论）的场景。",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "图片路径" },
        checklistId: { type: "string", description: "清单 id" },
        mock: { type: "boolean", description: "是否离线兜底" },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
];

/** Measured per-image token profile (see docs/api-pricing-reference): ~2,874 total. */
const TOKENS_PER_IMAGE = 1850;
const TOKENS_OUTPUT_PER_IMAGE = 1024;
/** Share of prompt tokens a warm cache can absorb on the 2nd+ image of a batch. */
const CACHE_HIT_RATIO = 0.85;

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: `错误：${message}` }], isError: true };
}

/** Resolve and validate image paths from a tool argument. */
async function loadImages(paths, limit = 12) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("paths 必须是非空字符串数组");
  const images = [];
  // The cap is enforced but never silent: the caller is told how many paths were
  // skipped, otherwise a host agent believes all 20 images were inspected.
  const accepted = paths.slice(0, limit);
  for (const path of accepted) {
    const target = resolve(String(path));
    if (!IMAGE_EXT.has(extname(target).toLowerCase())) throw new Error(`不是支持的图片格式：${path}`);
    try {
      images.push({ name: basename(target), buffer: await readFile(target) });
    } catch (cause) {
      throw new Error(`无法读取图片 ${path}：${cause.message}`);
    }
  }
  return { images, dropped: paths.length - accepted.length };
}

/** Summarise a batch as compact text the host model can reason over. */
function renderBatchText(batch, reports, consistency) {
  const lines = [];
  lines.push(`清单：${batch.checklist.name} v${batch.checklist.version}${batch.mock ? "（本地兜底）" : ""}`);
  lines.push(`结论：${batch.ok} 张完成 · 平均 ${batch.averageScore}/100 · 合格 ${batch.verdicts.pass ?? 0} / 需优化 ${batch.verdicts.warn ?? 0} / 不合格 ${batch.verdicts.fail ?? 0}`);
  if (batch.dropped > 0) lines.push(`注意：单批上限 ${batch.total} 张，另有 ${batch.dropped} 个路径未被处理（请分批调用）`);
  lines.push("");
  for (const report of reports) {
    if (!report?.ok) {
      lines.push(`✖ ${report?.image?.name ?? "未知图片"}：失败 - ${report?.error?.message ?? "未知错误"}（${report?.error?.code ?? "ERROR"}）`);
      continue;
    }
    const mark = { pass: "合格", warn: "需优化", fail: "不合格", unknown: "无法判定" }[report.verdict];
    lines.push(`${report.image.name} → ${report.score}/100 ${mark}${report.counts.overturned ? `（含 ${report.counts.overturned} 项人工推翻）` : ""}`);
    for (const item of report.recommendations.slice(0, 3)) {
      lines.push(`  · [${item.severity}] ${item.title}（实测 ${item.observed}，要求 ${item.assertion}）→ ${item.suggestion}`);
    }
  }
  if (consistency?.ok) {
    lines.push("");
    lines.push(`多图一致性：${consistency.verdictLabel}${consistency.conflicts?.length ? `（${consistency.conflicts.length} 处模型与实测冲突）` : ""}`);
    for (const rule of consistency.rules.filter((entry) => entry.status === "fail")) {
      lines.push(`  · [${rule.severity}] ${rule.title}（实测 ${rule.observed}）`);
    }
    for (const conflict of consistency.conflicts ?? []) lines.push(`  ⚠ ${conflict}`);
  }
  if (batch.cost?.images > 0) {
    lines.push("");
    lines.push(`成本：${formatMoney(batch.cost.grandTotal, batch.cost.currency)} · ${batch.cost.tokens.total.toLocaleString()} tokens · 平均每张 ${formatMoney(batch.cost.perImage, batch.cost.currency)}`);
  }
  return lines.join("\n");
}

/**
 * Execute one tool call.
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @param {{config: object, reportCache: Map<string, object>, feedback: FeedbackStore}} ctx
 */
async function callTool(name, args, ctx) {
  const { config, reportCache, consistencyCache, feedback } = ctx;

  if (name === "qc_list_checklists") {
    const checklists = loadChecklists(`${config.appRoot}/checklists`);
    const lines = checklists.map((checklist) => {
      const groups = [...new Set(checklist.rules.map((rule) => rule.group))].join(" / ");
      const rules = checklist.rules
        .map((rule) => `  ${rule.id} [${rule.severity}] ${rule.title}（${rule.fact} ${rule.op} ${JSON.stringify(rule.value)}）`)
        .join("\n");
      return `## ${checklist.id} — ${checklist.name} v${checklist.version}\n${checklist.description}\n分组：${groups}\n${rules}`;
    });
    return text(`${checklists.length} 份清单可用：\n\n${lines.join("\n\n")}`);
  }

  if (name === "qc_inspect_images") {
    const { images, dropped } = await loadImages(args.paths, config.maxImages ?? 12);
    const { batch, reports, consistency } = await inspectBatch({
      config,
      images,
      checklistId: args.checklistId,
      forceMock: args.mock === true,
      consistency: args.consistency !== false,
      cache: reportCache,
      consistencyCache,
      feedback,
      dropped,
    });
    return {
      content: [{ type: "text", text: renderBatchText(batch, reports, consistency) }],
      structuredContent: {
        batch,
        consistency: consistency?.ok ? { verdict: consistency.verdict, verdictLabel: consistency.verdictLabel, rules: consistency.rules, color: consistency.color, conflicts: consistency.conflicts } : null,
        reports: reports.map((report) =>
          report?.ok
            ? {
                name: report.image.name,
                score: report.score,
                verdict: report.verdict,
                verdictLabel: report.verdictLabel,
                counts: report.counts,
                recommendations: report.recommendations,
                markdown: report.markdown,
              }
            : { name: report?.image?.name, error: report?.error },
        ),
      },
    };
  }

  if (name === "qc_recent_reports") {
    if (reportCache.size === 0) return text("本次进程内还没有质检记录。");
    const lines = [...reportCache.values()]
      .sort((a, b) => (a.cachedAt < b.cachedAt ? 1 : -1))
      .map((report) => `${report.image.name} · ${report.score}/100 ${report.verdictLabel} · ${report.checklist.name} · ${report.cachedAt}`);
    return text(`${reportCache.size} 条缓存结果：\n${lines.join("\n")}`);
  }

  if (name === "qc_threshold_advice") {
    const checklists = loadChecklists(`${config.appRoot}/checklists`);
    const checklist = args.checklistId === undefined
      ? checklists[0]
      : checklists.find((entry) => entry.id === args.checklistId);
    if (!checklist) {
      return errorResult(`清单 "${args.checklistId}" 不存在，可用：${checklists.map((entry) => entry.id).join(" / ")}`);
    }
    if (feedback.size === 0) return text("还没有人工推翻记录，暂时无法给出阈值建议。");
    const suggestions = suggestAdjustments({ checklist, store: feedback });
    if (suggestions.length === 0) {
      return text(`共 ${feedback.size} 条推翻记录，但尚未达到形成建议的证据门槛（同一规则至少 2 次，或推翻率超过 30%）。`);
    }
    const lines = suggestions.map(
      (suggestion) =>
        `${suggestion.ruleId} ${suggestion.title}\n  推翻 ${suggestion.overturns} 次 · 置信度 ${suggestion.confidence}\n  ${suggestion.advice}`,
    );
    return {
      content: [{ type: "text", text: `《${checklist.name}》阈值建议（依据 ${feedback.size} 条推翻记录）：\n\n${lines.join("\n\n")}` }],
      structuredContent: { checklistId: checklist.id, overturns: feedback.size, suggestions },
    };
  }

  if (name === "qc_cost_estimate") {
    const count = Number(args.images) > 0 ? Number(args.images) : 1;
    // Measured on real 1000x1000 PNGs: ~2,874 tokens per image, of which ~89%
    // can be served from the prompt cache on the second and later images.
    const tokensIn = TOKENS_PER_IMAGE + (Number(args.avgImageBytes) > 0 ? Math.round(Number(args.avgImageBytes) / 4096) : 0);
    const sample = costOf({
      provider: config.provider,
      model: config.model,
      usage: { prompt_tokens: tokensIn, completion_tokens: TOKENS_OUTPUT_PER_IMAGE, prompt_cache_hit_tokens: Math.round(tokensIn * CACHE_HIT_RATIO) },
    });
    const perImage = sample?.total ?? 0;
    const advice = scheduleAdvice({ provider: config.provider, model: config.model, inputTokens: tokensIn, outputTokens: TOKENS_OUTPUT_PER_IMAGE });
    const lines = [
      `按当前线路 ${config.provider}/${config.model} 估算${sample?.rates?.offPeak ? "（当前为错峰时段，已按 5 折计算）" : "（当前按高峰价）"}：`,
      `  单张图约 ${tokensIn} 输入 tokens（其中约 ${Math.round(CACHE_HIT_RATIO * 100)}% 命中缓存）+ ${TOKENS_OUTPUT_PER_IMAGE} 输出 tokens ≈ ${formatMoney(perImage)}`,
      `  本批 ${count} 张 ≈ ${formatMoney(perImage * count)}`,
      "  月度外推：",
      ...projection(perImage).map((row) => `    ${row.volume.toLocaleString().padStart(7)} 张 → ${formatMoney(row.cost)}`),
    ];
    if (advice) {
      lines.push("", `排期建议：高峰 ${formatMoney(advice.peak)}/张 vs 错峰 ${formatMoney(advice.offPeak)}/张。${advice.advice}`);
    }
    if (sample?.rates?.unverified) lines.push("", `注意：${sample.rates.unverified}`);
    return text(lines.join("\n"));
  }

  if (name === "qc_write_reports") {
    const { images, dropped } = await loadImages(args.paths, config.maxImages ?? 12);
    const { batch, reports, consistency } = await inspectBatch({
      config,
      images,
      checklistId: args.checklistId,
      forceMock: args.mock === true,
      cache: reportCache,
      consistencyCache,
      feedback,
      dropped,
    });
    const saved = saveReports(config, batch, reports, consistency);
    return text(`${renderBatchText(batch, reports, consistency)}\n\n报告已写入：${saved.dir}（${saved.files.length} 个文件）`);
  }

  return errorResult(`未知工具 ${name}`);
}

/**
 * Start the stdio server. Returns a promise that resolves when stdin closes.
 * @param {{config?: object}} [options]
 */
export async function startMcpServer(options = {}) {
  const config = options.config ?? loadConfig();
  const reportCache = new Map();
  const consistencyCache = new Map();
  const feedback = new FeedbackStore(join(config.dataDir ?? join(config.appRoot, "data"), "feedback.jsonl"));
  const ctx = { config, reportCache, consistencyCache, feedback };

  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(null, -32700, "Parse error");
        continue;
      }
      handle(message).catch((error) => {
        if (message.id !== undefined) fail(message.id, -32603, `Internal error: ${error.message}`);
      });
    }
  });

  async function handle(message) {
    const { id, method, params } = message;
    // Notifications carry no id and must not be answered.
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      const protocolVersion = KNOWN_PROTOCOLS.includes(requested) ? requested : PREFERRED_PROTOCOL;
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "电商图片视觉质检引擎。先用 qc_list_checklists 选清单，再用 qc_inspect_images 质检本地图片；需要交付文件时用 qc_write_reports。可用 qc_cost_estimate 先估算成本，用 qc_threshold_advice 查询规则是否过严。",
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: TOOLS });
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((entry) => entry.name === name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(name, args, ctx);
        return reply(id, result);
      } catch (error) {
        // Tool failures are results, not protocol errors, so the host model can react.
        return reply(id, errorResult(error.message));
      }
    }
    if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }

  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`vision-qc-agent MCP server 已就绪（stdio）· 视觉线路 ${config.provider}/${config.model}\n`);
  return new Promise(() => {});
}

// Compare file URLs, not raw paths: a workspace path containing non-ASCII
// characters makes `import.meta.url` percent-encoded.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch((error) => {
    process.stderr.write(`MCP server 启动失败：${error.message}\n`);
    process.exit(1);
  });
}
