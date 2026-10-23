#!/usr/bin/env node
/**
 * Wire this MCP server into a DSH profile.
 *
 * The `insert:` wrapper is mandatory: DSH treats a bare `{id, name, config}` row
 * in a patch file as an *override of an existing row*, warns "entry not found"
 * and silently skips it. New rows must be inserted.
 *
 *   node scripts/install-dsh-integration.mjs                 # print the patch
 *   node scripts/install-dsh-integration.mjs --write         # write it into the profile
 *   node scripts/install-dsh-integration.mjs --write --profile web --server-name qc
 *
 * @module vision-qc-agent/scripts/install-dsh-integration
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

function parseArgs(argv) {
  const options = { write: false, profile: "web", serverName: "qc", node: process.execPath, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--profile") options.profile = argv[++i];
    else if (arg === "--server-name") options.serverName = argv[++i];
    else if (arg === "--node") options.node = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

/** The patch document DSH must contain; kept minimal so it is easy to audit. */
export function buildPatch({ serverName = "qc", node = process.execPath, appRoot = APP_ROOT, env = {} } = {}) {
  return {
    insert: [
      {
        id: `mcp-${serverName}`,
        name: "@deepseek-ai/dsh-mcp-client",
        config: {
          transport: "stdio",
          serverName,
          command: node,
          args: [join(appRoot, "src", "mcp", "server.mjs")],
          env: { QC_APP_ROOT: appRoot, ...env },
          toolCallTimeoutMs: 120000,
          failOnStartupError: false,
          reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
        },
      },
    ],
  };
}

/** Serialise the patch as the YAML DSH expects (block style, 2-space indent). */
export function renderPatchYaml(patch) {
  const lines = ["# Added by vision-qc-agent · 让 DSH 的 Agent 能调用视觉质检工具"];
  for (const entry of patch.insert) {
    lines.push("- insert:");
    lines.push(`    - id: ${entry.id}`);
    lines.push(`      name: '${entry.name}'`);
    lines.push("      config:");
    lines.push(`        transport: ${entry.config.transport}`);
    lines.push(`        serverName: ${entry.config.serverName}`);
    lines.push(`        command: ${entry.config.command}`);
    lines.push("        args:");
    for (const arg of entry.config.args) lines.push(`          - ${arg}`);
    const envKeys = Object.keys(entry.config.env ?? {});
    if (envKeys.length > 0) {
      lines.push("        env:");
      for (const key of envKeys) lines.push(`          ${key}: ${entry.config.env[key]}`);
    }
    lines.push(`        toolCallTimeoutMs: ${entry.config.toolCallTimeoutMs}`);
    lines.push(`        failOnStartupError: ${entry.config.failOnStartupError}`);
    lines.push("        reconnect:");
    for (const [key, value] of Object.entries(entry.config.reconnect)) {
      lines.push(`          ${key}: ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const patch = buildPatch({ serverName: options.serverName, node: options.node });
  const yaml = renderPatchYaml(patch);
  const target = join(DSH_HOME, "profiles", options.profile, "cordis.patch.yml");

  if (options.help || !options.write) {
    process.stdout.write(`目标文件：${target}\n\n${yaml}\n`);
    process.stdout.write("加 --write 才会真正写入（DSH 会热加载该文件，无需重启）。\n");
    return;
  }

  if (!existsSync(dirname(target))) {
    process.stderr.write(`找不到 profile 目录：${dirname(target)}\n`);
    process.exit(1);
  }
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const already = existing.includes("vision-qc-agent");
  if (already && !options.force) {
    process.stdout.write(`已包含 vision-qc-agent 的配置，未改动。加 --force 可覆盖。\n`);
    return;
  }
  writeFileSync(target, yaml, "utf8");
  process.stdout.write(`已写入 ${target}\n`);
  process.stdout.write("DSH 的 web profile 会热加载该补丁；工具将以 mcp__" + options.serverName + "__<tool> 出现在 Agent 的工具列表里。\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
