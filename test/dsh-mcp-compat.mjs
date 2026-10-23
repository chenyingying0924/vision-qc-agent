/**
 * Verifies that the DSH MCP client can drive this server.
 *
 * Instead of guessing at the wire protocol, this probe imports the *same*
 * `@modelcontextprotocol/sdk` that `@deepseek-ai/dsh-mcp-client` builds on, runs
 * the exact handshake the plugin runs, and asserts on the tools the host model
 * would see. It is the closest thing to "DSH can use this" that can be checked
 * without restarting the running GUI.
 *
 * Usage: node test/dsh-mcp-compat.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_PACKAGE = "@modelcontextprotocol/sdk";

/**
 * Locate the node_modules tree that can resolve the MCP SDK.
 *
 * This project intentionally has zero dependencies, so the SDK must come from
 * the DSH installation. Three strategies, in order of precision: an explicit
 * override, the `dsh` launcher's real path, then the npx cache.
 * @returns {string|undefined} a directory that can resolve {@link SDK_PACKAGE}.
 */
function findSdkRoot() {
  const explicit = process.env.DSH_NODE_MODULES;
  if (explicit && existsSync(join(explicit, SDK_PACKAGE))) return explicit;

  const has = (dir) => dir && existsSync(join(dir, SDK_PACKAGE));

  try {
    const launcher = execFileSync("/bin/sh", ["-c", "command -v dsh"], { encoding: "utf8" }).trim();
    if (launcher) {
      let dir = dirname(realpathSync(launcher));
      // Walk up to the filesystem root; the SDK may live several levels above
      // the launcher (e.g. in a nested npx cache), so never give up early here.
      for (;;) {
        if (has(dir)) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    /* dsh not on PATH — fall through to the cache scan */
  }

  const npxCache = join(homedir(), ".npm", "_npx");
  if (existsSync(npxCache)) {
    for (const entry of readdirSync(npxCache)) {
      const candidate = join(npxCache, entry, "node_modules");
      if (has(candidate)) return candidate;
    }
  }
  return undefined;
}

function loadSdk() {
  const root = findSdkRoot();
  if (!root) {
    throw new Error(
      "找不到 DSH 的 @modelcontextprotocol/sdk。请先安装 DSH（npm i -g @deepseek-ai/dsh 或 npx @deepseek-ai/dsh），或用 DSH_NODE_MODULES=<node_modules 路径> 指定。",
    );
  }
  const require = createRequire(join(root, "noop.js"));
  const clientPath = require.resolve(`${SDK_PACKAGE}/client/index.js`);
  const stdioPath = require.resolve(`${SDK_PACKAGE}/client/stdio.js`);
  return { clientPath: pathToFileURL(clientPath).href, stdioPath: pathToFileURL(stdioPath).href };
}

async function main() {
  const { clientPath, stdioPath } = loadSdk();
  const { Client } = await import(clientPath);
  const { StdioClientTransport } = await import(stdioPath);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(APP_ROOT, "src", "mcp", "server.mjs")],
    stderr: "pipe",
  });
  const client = new Client({ name: "dsh-mcp-client", version: "0.0.1" }, { capabilities: {} });

  const steps = [];
  const check = (label, ok, detail = "") => {
    steps.push({ label, ok });
    console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  await client.connect(transport);
  check("initialize 握手成功（DSH 客户端 SDK）", true);
  const version = client.getServerVersion?.();
  check("服务器信息可读", Boolean(version?.name), `${version?.name} ${version?.version}`);
  check("协议版本被接受", true, client.getServerCapabilities ? JSON.stringify(client.getServerCapabilities()) : "");

  const { tools } = await client.listTools();
  check("tools/list 返回 6 个工具", tools.length === 6, tools.map((tool) => tool.name).join(", "));
  check(
    "每个工具都声明了 object 型 inputSchema",
    tools.every((tool) => tool.inputSchema?.type === "object"),
  );
  check("工具名符合 DSH 的命名约束", tools.every((tool) => /^[A-Za-z0-9_-]+$/.test(tool.name)));

  // A real call, through the official client, with no model cost.
  const result = await client.callTool({ name: "qc_list_checklists", arguments: {} });
  const textOut = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  check("tools/call 返回文本内容", textOut.includes("份清单可用"), `${textOut.length} 字符`);
  check("四个清单 id 都在返回里", ["ecom-main-image", "detail-page", "live-cover", "design-review"].every((id) => textOut.includes(id)));
  check("未声明 outputSchema（避免 DSH 的 structuredContent 强制校验）", tools.every((tool) => tool.outputSchema === undefined));

  // Failure path: the host must receive isError, not a thrown protocol error.
  const bad = await client.callTool({ name: "qc_inspect_images", arguments: { paths: ["/no/such/image.png"] } });
  check("无效路径返回 isError 而不是协议错误", bad.isError === true, (bad.content?.[0]?.text ?? "").slice(0, 60));

  await client.close();
  const failed = steps.filter((step) => !step.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} 项通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`DSH 兼容性检查失败：${error.message}`);
  process.exit(1);
});
