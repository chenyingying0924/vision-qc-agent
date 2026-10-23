/**
 * Standalone MCP protocol probe: spawns the QC MCP server and exercises the
 * handshake + tool calls over newline-delimited JSON-RPC.
 *
 * It prints what the host model would see AND asserts it, so it can guard a
 * regression instead of only producing output nobody reads (CI runs it).
 * The inspection call uses `mock: true`, so the probe is offline and free.
 *
 * Usage: node test/mcp-probe.mjs
 * Exit code: 0 when every assertion passes, 1 otherwise.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [join(APP_ROOT, "src", "mcp", "server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = new Map();
let buffer = "";
const steps = [];
const check = (label, ok, detail = "") => {
  steps.push({ label, ok });
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
};

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      responses.set(message.id, message);
    } catch {
      console.log("unparsed line:", line.slice(0, 160));
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const textOf = (id) => responses.get(id)?.result?.content?.[0]?.text ?? "";

await wait(250);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1.0.0" } },
});
await wait(400);
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "qc_cost_estimate", arguments: { images: 5000 } } });
send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "qc_list_checklists", arguments: {} } });
send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "qc_bogus", arguments: {} } });
send({
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: {
    name: "qc_inspect_images",
    arguments: {
      mock: true,
      consistency: true,
      paths: ["samples/01-perfect-white.png", "samples/04-watermark-logo.png"].map((path) => join(APP_ROOT, path)),
    },
  },
});
send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "qc_inspect_images", arguments: { paths: [] } } });
send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "qc_threshold_advice", arguments: { checklistId: "nope" } } });
await wait(2500);

const init = responses.get(1);
check("initialize 返回协议版本与 serverInfo", Boolean(init?.result?.protocolVersion && init?.result?.serverInfo?.name), init?.result?.protocolVersion);

const list = responses.get(2);
const names = (list?.result?.tools ?? []).map((tool) => tool.name);
check("tools/list 返回 6 个工具", names.length === 6, names.join(", "));
check(
  "每个工具都声明 object 型 inputSchema",
  (list?.result?.tools ?? []).every((tool) => tool.inputSchema?.type === "object"),
);

const cost = textOf(3);
check("qc_cost_estimate 给出单张与整批成本", /单张图约/.test(cost) && /本批 5000 张/.test(cost), cost.split("\n")[1]?.trim().slice(0, 60));

const checklists = textOf(4);
check("qc_list_checklists 列出四份清单", ["ecom-main-image", "detail-page", "live-cover", "design-review"].every((id) => checklists.includes(id)));

const unknown = responses.get(5);
check("未知工具返回 -32602", unknown?.error?.code === -32602, unknown?.error?.message);

const inspected = responses.get(6)?.result;
const inspectText = inspected?.content?.[0]?.text ?? "";
check(
  "qc_inspect_images（mock）返回两张图的结论与结构化内容",
  inspected?.structuredContent?.reports?.length === 2 && /清单：/.test(inspectText),
  inspectText.split("\n").find((line) => line.includes("结论："))?.slice(0, 60),
);
check(
  "多图时附带 SKU 一致性结论",
  /多图一致性：/.test(inspectText),
);
check(
  "空 paths 返回 isError 而不是协议错误",
  responses.get(7)?.result?.isError === true,
  responses.get(7)?.result?.content?.[0]?.text?.slice(0, 50),
);
check(
  "未知 checklistId 在阈值建议工具里也是 isError",
  responses.get(8)?.result?.isError === true,
  responses.get(8)?.result?.content?.[0]?.text?.slice(0, 50),
);

child.kill("SIGKILL");
const failed = steps.filter((step) => !step.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
