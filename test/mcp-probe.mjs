/**
 * Standalone MCP protocol probe: spawns the QC MCP server and exercises the
 * handshake + tool calls over newline-delimited JSON-RPC, printing raw results.
 *
 * Usage: node test/mcp-probe.mjs
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
await wait(1500);

const init = responses.get(1);
console.log("initialize →", init?.result?.protocolVersion, JSON.stringify(init?.result?.capabilities), init?.result?.serverInfo?.name);
const list = responses.get(2);
console.log("tools/list →", list?.result?.tools?.map((tool) => tool.name).join(", "));
const cost = responses.get(3);
console.log("qc_cost_estimate →", cost?.result?.content?.[0]?.text?.split("\n").slice(0, 3).join(" | "));
const checklists = responses.get(4);
console.log("qc_list_checklists →", checklists?.result?.content?.[0]?.text?.slice(0, 80).replace(/\n/g, " "), "…");
const unknown = responses.get(5);
console.log("unknown tool →", unknown?.error ? `error ${unknown.error.code}: ${unknown.error.message}` : JSON.stringify(unknown?.result).slice(0, 100));

child.kill("SIGKILL");
process.exit(0);
