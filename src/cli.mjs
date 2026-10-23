#!/usr/bin/env node
/**
 * Command-line entry: batch inspection, human-in-the-loop review, and the MCP
 * server used to expose the same engine to a host agent.
 *
 *   node src/cli.mjs samples/*.png
 *   node src/cli.mjs photos/ --checklist detail-page --cost --save
 *   node src/cli.mjs photos/ --mock              # offline, deterministic fallback
 *   node src/cli.mjs review suggest --checklist ecom-main-image
 *   node src/cli.mjs review overturn --image a.png --rule R05 --reason business-exception
 *   node src/cli.mjs mcp                         # stdio MCP server
 *
 * @module vision-qc-agent/cli
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { loadConfig, publicConfig } from "./config.mjs";
import { FeedbackStore, OVERTURN_REASONS, suggestAdjustments } from "./core/feedback.mjs";
import { formatMoney, projection, scheduleAdvice } from "./core/pricing.mjs";
import { inspectBatch, saveReports } from "./core/pipeline.mjs";
import { loadChecklists } from "./core/rules.mjs";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function usage() {
  return `视觉质检 Agent · 命令行

用法:
  node src/cli.mjs <文件或目录...> [选项]     批量质检
  node src/cli.mjs review <list|suggest|overturn> [选项]
  node src/cli.mjs mcp                        以 MCP stdio 服务器运行

批量质检选项:
  --checklist <id>   指定质检清单（默认第一份）
  --mock             不调用视觉模型，使用本地像素兜底
  --provider <id>    deepseek | openai | anthropic
  --model <id>       覆盖模型名
  --no-consistency   跳过 SKU 组多图一致性检查
  --cost             打印成本面板（tokens / 每张成本 / 月度外推）
  --json <path>      额外写出机读 JSON
  --save             把 Markdown 报告写入 reports/<时间戳>/
  --concurrency <n>  并发数（默认 3）
  --help             显示帮助

人机回环选项:
  review list                                  查看所有推翻记录
  review overturn --image <名> --rule <R05>    记录一次推翻
      [--reason <key>] [--note <文本>] [--reviewer <人>]
      原因可选: ${Object.keys(OVERTURN_REASONS).join(" | ")}
  review suggest [--checklist <id>]            依据推翻记录给出阈值调整建议
`;
}

function parseArgs(argv) {
  const options = { inputs: [], checklist: undefined, mock: false, provider: undefined, model: undefined, json: undefined, save: false, concurrency: undefined, consistency: true, cost: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--mock") options.mock = true;
    else if (arg === "--save") options.save = true;
    else if (arg === "--cost") options.cost = true;
    else if (arg === "--no-consistency") options.consistency = false;
    else if (arg === "--checklist") options.checklist = argv[++i];
    else if (arg === "--provider") options.provider = argv[++i];
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (arg.startsWith("--")) throw new Error(`未知选项 ${arg}`);
    else options.inputs.push(arg);
  }
  return options;
}

/** Parse `review` subcommand flags (all `--key value`). */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function collectImages(inputs) {
  const files = [];
  for (const input of inputs) {
    const target = resolve(input);
    const info = statSync(target);
    if (info.isDirectory()) {
      for (const name of readdirSync(target).sort()) {
        if (IMAGE_EXT.has(extname(name).toLowerCase())) files.push(join(target, name));
      }
    } else {
      files.push(target);
    }
  }
  return files;
}

function bar(score) {
  const filled = Math.round(score / 5);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

async function runBatch(options) {
  if (options.help || options.inputs.length === 0) {
    process.stdout.write(usage());
    process.exit(options.help ? 0 : 1);
  }

  if (options.provider) process.env.QC_PROVIDER = options.provider;
  if (options.model) process.env.QC_MODEL = options.model;
  if (options.concurrency) process.env.QC_CONCURRENCY = String(options.concurrency);
  if (options.mock) process.env.QC_MOCK = "1";

  const config = loadConfig();
  const paths = collectImages(options.inputs);
  if (paths.length === 0) throw new Error("没有找到可处理的图片");
  const images = paths.map((path) => ({ name: basename(path), buffer: readFileSync(path) }));
  const feedback = new FeedbackStore(join(config.dataDir ?? join(config.appRoot, "data"), "feedback.jsonl"));

  const summary = publicConfig(config);
  process.stdout.write(
    [
      `视觉线路：${summary.providerLabel} · ${summary.model}${summary.mock ? " (mock)" : ""}`,
      `凭据：${summary.apiKeyEnv} ← ${summary.credentialSource}${summary.apiKeyConfigured ? "" : "（未配置，自动兜底）"}`,
      `待检图片：${images.length} 张，并发 ${config.concurrency}${options.consistency ? "，含多图一致性" : ""}`,
      feedback.size > 0 ? `人工推翻记录：${feedback.size} 条（已并入判定）` : "",
      "",
    ].filter(Boolean).join("\n"),
  );

  const started = Date.now();
  const { batch, reports, consistency } = await inspectBatch({
    config,
    images,
    checklistId: options.checklist,
    forceMock: options.mock,
    consistency: options.consistency,
    feedback,
    onEvent: (event) => {
      if (event.type === "image-thinking") process.stdout.write(`  … ${event.name} 分析中\n`);
      if (event.type === "image-cached") process.stdout.write(`  ↺ ${event.name} 缓存命中\n`);
      if (event.type === "image-error") process.stdout.write(`  ! ${event.name} 失败：${event.message}（${event.code}）\n`);
      if (event.type === "batch-warning") process.stdout.write(`  ! ${event.message}\n`);
      if (event.type === "consistency-start") process.stdout.write(`  ⇄ 多图一致性比对（${event.images} 张）\n`);
      if (event.type === "consistency-error") process.stdout.write(`  ! 一致性检查跳过：${event.message}\n`);
    },
  });

  process.stdout.write(`\n清单：${batch.checklist.name} v${batch.checklist.version}\n\n`);
  for (const report of reports) {
    if (!report?.ok) {
      process.stdout.write(`✖ ${report?.image?.name ?? "未知图片"}  失败：${report?.error?.message ?? "未知错误"}\n`);
      continue;
    }
    const icon = { pass: "✔", warn: "▲", fail: "✖", unknown: "?" }[report.verdict] ?? "?";
    const overturned = report.counts.overturned ? `  (人工推翻 ${report.counts.overturned} 项)` : "";
    process.stdout.write(`${icon} ${report.image.name}  ${String(report.score).padStart(3)}/100  ${bar(report.score)}  ${report.verdictLabel}${overturned}\n`);
    for (const item of report.recommendations.slice(0, 3)) {
      process.stdout.write(`    · [${item.severity}] ${item.title}（实测 ${item.observed}，要求 ${item.assertion}）\n`);
    }
  }

  if (consistency?.ok) {
    const icon = { pass: "✔", warn: "▲", fail: "✖", unknown: "?" }[consistency.verdict] ?? "?";
    process.stdout.write(`\n多图一致性：${icon} ${consistency.verdictLabel}（${consistency.counts.fail} 项不通过）\n`);
    for (const rule of consistency.rules.filter((entry) => entry.status === "fail")) {
      process.stdout.write(`    · [${rule.severity}] ${rule.title}（实测 ${rule.observed}）\n`);
    }
    for (const conflict of consistency.conflicts ?? []) {
      process.stdout.write(`    ⚠ ${conflict}\n`);
    }
  }

  process.stdout.write(
    `\n汇总：平均 ${batch.averageScore}/100 · 合格 ${batch.verdicts.pass ?? 0} · 需优化 ${batch.verdicts.warn ?? 0} · 不合格 ${batch.verdicts.fail ?? 0} · 失败 ${batch.failed} · 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );

  if (options.cost || options.save) printCostPanel(batch);

  if (options.json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resolve(options.json), JSON.stringify({ batch, consistency: consistency ?? null, reports }, null, 2), "utf8");
    process.stdout.write(`机读结果已写入 ${resolve(options.json)}\n`);
  }
  if (options.save) {
    const failuresByRule = new Map();
    for (const report of reports) {
      for (const result of report?.results ?? []) {
        if (result.status !== "fail") continue;
        failuresByRule.set(result.id, (failuresByRule.get(result.id) ?? 0) + 1);
      }
    }
    const checklists = loadChecklists(join(config.appRoot, "checklists"));
    const checklist = checklists.find((entry) => entry.id === batch.checklist.id) ?? checklists[0];
    const suggestions = suggestAdjustments({ checklist, store: feedback, options: { failuresByRule } });
    const saved = saveReports(config, batch, reports, consistency, suggestions);
    process.stdout.write(`Markdown 报告已写入 ${saved.dir}（${saved.files.length} 个文件）\n`);
    if (suggestions.length > 0) {
      process.stdout.write(`依据 ${feedback.size} 条人工推翻记录，给出 ${suggestions.length} 条阈值调整建议（见 _rule-adjustments.json）\n`);
    }
  }
}

/** Cost panel: tokens, money, cache value, and the number procurement will ask for. */
function printCostPanel(batch) {
  const cost = batch.cost;
  if (!cost || cost.images === 0) {
    process.stdout.write(
      cost?.cached > 0
        ? `\n成本面板：本次 ${cost.cached} 张全部命中缓存，实际花费 $0\n`
        : "\n成本面板：本次未调用模型（本地兜底），成本 $0\n",
    );
    return;
  }
  const lines = [];
  lines.push("");
  lines.push("成本面板");
  lines.push(`  tokens：输入 ${cost.tokens.input.toLocaleString()}（缓存命中 ${cost.tokens.cachedInput.toLocaleString()}，占 ${(cost.cachedRatio * 100).toFixed(0)}%）· 输出 ${cost.tokens.output.toLocaleString()}（含推理 ${cost.tokens.reasoning.toLocaleString()}）`);
  lines.push(`  平均每张：${cost.tokensPerImage.toLocaleString()} tokens · ${formatMoney(cost.perImage, cost.currency)}`);
  lines.push(`  本批合计：${formatMoney(cost.total, cost.currency)}（${cost.images} 张图）`);
  if (cost.noCacheTotal > cost.total) {
    lines.push(`  缓存省下：${formatMoney(cost.noCacheTotal - cost.total, cost.currency)}（无缓存则需 ${formatMoney(cost.noCacheTotal, cost.currency)}）`);
  }
  if (cost.consistency) {
    lines.push(`  一致性那次多图调用：${formatMoney(cost.consistency.total, cost.currency)} · ${cost.consistency.tokens.total.toLocaleString()} tokens`);
    lines.push(`  含一致性总计：${formatMoney(cost.grandTotal, cost.currency)}`);
  }
  if (cost.rates?.source) {
    const offPeak = cost.rates.offPeak ? "（错峰 5 折已生效）" : "";
    lines.push(`  费率${offPeak}：输入 $${cost.rates.input}/M · 缓存 $${cost.rates.cachedInput}/M · 输出 $${cost.rates.output}/M`);
    lines.push(`  来源：${cost.rates.source}（核对于 ${cost.rates.checkedAt}）`);
    if (cost.rates.unverified) lines.push(`  ⚠ ${cost.rates.unverified}`);
  }
  lines.push("  月度外推：");
  for (const row of projection(cost.perImage, cost.currency)) {
    lines.push(`    ${row.volume.toLocaleString().padStart(7)} 张/月 → ${formatMoney(row.cost, row.currency)}`);
  }
  const advice = scheduleAdvice({ inputTokens: cost.tokensPerImage });
  if (advice) {
    lines.push(`  排期建议：高峰 ${formatMoney(advice.peak)}/张 vs 错峰 ${formatMoney(advice.offPeak)}/张，省 ${(advice.savingRate * 100).toFixed(0)}%`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** `review` subcommand: inspect and extend the overturn log. */
async function runReview(argv) {
  const action = argv[0] ?? "list";
  const flags = parseFlags(argv.slice(1));
  const config = loadConfig();
  const store = new FeedbackStore(join(config.dataDir ?? join(config.appRoot, "data"), "feedback.jsonl"));

  if (action === "list") {
    if (store.size === 0) {
      process.stdout.write("暂无人工推翻记录。用 review overturn 记录第一条。\n");
      return;
    }
    process.stdout.write(`共 ${store.size} 条推翻记录：\n\n`);
    for (const group of store.byRule()) {
      process.stdout.write(`  ${group.ruleId}：${group.count} 次 · 最近 ${group.latest.slice(0, 16).replace("T", " ")}\n`);
      const reasons = Object.entries(group.reasons).map(([key, count]) => `${OVERTURN_REASONS[key] ?? key}×${count}`).join("，");
      process.stdout.write(`      原因：${reasons}\n`);
      for (const sample of group.samples) {
        process.stdout.write(`      · ${sample.imageName}（实测 ${sample.observed}）${sample.note ? ` —— ${sample.note}` : ""}\n`);
      }
    }
    return;
  }

  if (action === "overturn") {
    if (!flags.image || !flags.rule) throw new Error("review overturn 需要 --image 与 --rule");
    const entry = store.record({
      imageName: flags.image,
      ruleId: flags.rule,
      reason: typeof flags.reason === "string" ? flags.reason : "business-exception",
      note: typeof flags.note === "string" ? flags.note : "",
      reviewer: typeof flags.reviewer === "string" ? flags.reviewer : "cli",
      observed: typeof flags.observed === "string" ? flags.observed : null,
      context: { checklistId: flags.checklist ?? null },
    });
    process.stdout.write(`已记录推翻：${entry.imageName} · ${entry.ruleId} · ${OVERTURN_REASONS[entry.reason]}\n`);
    process.stdout.write(`日志：${store.path}（累计 ${store.size} 条）\n`);
    return;
  }

  if (action === "suggest") {
    const checklists = loadChecklists(join(config.appRoot, "checklists"));
    const checklist = checklists.find((entry) => entry.id === flags.checklist) ?? checklists[0];
    const suggestions = suggestAdjustments({ checklist, store });
    if (suggestions.length === 0) {
      process.stdout.write(`${checklist.name}：暂无足够推翻记录形成建议（至少同一规则被推翻 2 次）。\n`);
      return;
    }
    process.stdout.write(`清单《${checklist.name}》阈值调整建议（依据 ${store.size} 条推翻记录）：\n\n`);
    for (const suggestion of suggestions) {
      process.stdout.write(`  ${suggestion.ruleId} ${suggestion.title}\n`);
      process.stdout.write(`    推翻 ${suggestion.overturns} 次${suggestion.overturnRate !== null ? ` · 推翻率 ${(suggestion.overturnRate * 100).toFixed(0)}%` : ""} · 置信度 ${suggestion.confidence}\n`);
      process.stdout.write(`    ${suggestion.advice}\n\n`);
    }
    return;
  }

  throw new Error(`未知的 review 子命令 "${action}"，可用：list | overturn | suggest`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "review") return runReview(argv.slice(1));
  if (command === "mcp") {
    const { startMcpServer } = await import("./mcp/server.mjs");
    return startMcpServer({ config: loadConfig() });
  }
  return runBatch(parseArgs(argv));
}

main().catch((error) => {
  process.stderr.write(`\n运行失败：${error.message}\n`);
  process.exit(1);
});
