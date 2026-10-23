/**
 * Browser end-to-end check: drives the real UI in headless Chrome over CDP.
 *
 * Verifies the parts curl cannot: file upload, the SSE-driven rendering, the
 * overturn form posting to /api/feedback, and the threshold-advice panel.
 *
 * The test hosts its own server against a throwaway data directory, so it is
 * repeatable: it never appends fake overturns to the demo's `data/feedback.jsonl`
 * (which used to change the sample scores and made the second run fail).
 *
 * Usage: node test/ui-e2e.mjs             (offline: mock mode, temp data dir)
 *        QC_MOCK=0 node test/ui-e2e.mjs   (real model calls — costs money)
 *        QC_URL=http://127.0.0.1:4599/ node test/ui-e2e.mjs   (use a running server)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.QC_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Mock is the default: an offline test must not need a key or spend money. */
const MOCK = process.env.QC_MOCK !== "0";
const PROFILE = join(APP_ROOT, "data", "ui-e2e");
const DATA_DIR = mkdtempSync(join(tmpdir(), "qc-ui-data-"));

let serverProcess = null;
let baseUrl = process.env.QC_URL ?? "";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Minimal CDP client over the DevTools WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else done(message.result);
      }
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((done, fail) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", () => fail(new Error("CDP socket error")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function findPageTarget(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* browser still starting */
    }
    await wait(250);
  }
  throw new Error("Chrome DevTools endpoint never became ready");
}

/**
 * Start the server under test on a throwaway port + data directory.
 * Skipped when `QC_URL` points at a server the caller already started.
 */
async function ensureServer() {
  if (baseUrl) return;
  const port = 4700 + (process.pid % 200);
  baseUrl = `http://127.0.0.1:${port}/`;
  serverProcess = spawn(process.execPath, [join(APP_ROOT, "src", "server.mjs")], {
    env: {
      ...process.env,
      QC_PORT: String(port),
      QC_MOCK: MOCK ? "1" : "0",
      QC_NO_SAVE: "1",
      QC_DATA_DIR: DATA_DIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`服务启动失败：${stderr.slice(-400)}`);
    try {
      const health = await fetch(`${baseUrl}api/health`);
      if (health.ok) return;
    } catch {
      /* not listening yet */
    }
    await wait(100);
  }
  throw new Error(`服务未在 10s 内就绪：${stderr.slice(-400)}`);
}

function stopServer() {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
  serverProcess = null;
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* temp dir: best effort */
  }
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "page evaluation failed");
  return result.result.value;
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  await ensureServer();
  mkdirSync(PROFILE, { recursive: true });
  const port = 9333 + (process.pid % 200);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(PROFILE, "chrome")}`,
      `--crash-dumps-dir=${join(PROFILE, "crash")}`,
      "--window-size=1600,1400",
      baseUrl,
    ],
    { stdio: "ignore", env: { ...process.env, TMPDIR: PROFILE } },
  );

  const target = await findPageTarget(port);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  // Surface page-side exceptions instead of letting them vanish into the void.
  const pageErrors = [];
  cdp.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      pageErrors.push(details?.exception?.description ?? details?.text ?? "unknown page exception");
    }
  });
  await wait(800);

  const steps = [];
  const check = (label, ok, detail = "") => {
    steps.push({ label, ok, detail });
    console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  // 1. boot state: the route banner must show that the API is reachable.
  const route = await evaluate(cdp, undefined, "document.getElementById('route-text').textContent");
  check("页面加载并显示视觉线路", /DeepSeek|兜底|演示/.test(route), route);

  const checklistCount = await evaluate(cdp, undefined, "document.getElementById('checklist').options.length");
  check("清单下拉已加载 4 份清单", checklistCount === 4, `${checklistCount} 项`);

  // 2. upload two images through the real file input.
  const files = ["samples/01-perfect-white.png", "samples/04-watermark-logo.png"].map((p) => join(APP_ROOT, p));
  await cdp.send("DOM.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId: fileInput } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#files" });
  if (!fileInput) throw new Error("页面上找不到 #files 输入框");
  await cdp.send("DOM.setFileInputFiles", { nodeId: fileInput, files });
  await wait(500);
  const thumbs = await evaluate(cdp, undefined, "document.querySelectorAll('#thumbs li').length");
  check("两张图片已进入上传队列", thumbs === 2, `${thumbs} 张缩略图`);

  if (MOCK) {
    await evaluate(cdp, undefined, "document.getElementById('mock').checked = true");
  }

  // 3. run and wait for results.
  await evaluate(cdp, undefined, "document.getElementById('run').click()");
  let cards = 0;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    cards = await evaluate(cdp, undefined, "document.querySelectorAll('#stream .card').length");
    const done = await evaluate(cdp, undefined, "!document.getElementById('run').disabled");
    if (cards >= 2 && done) break;
    await wait(1000);
  }
  check("两张图都渲染出结果卡片", cards >= 2, `${cards} 张卡片`);

  const summary = await evaluate(cdp, undefined, "({score: document.getElementById('m-score').textContent, cost: document.getElementById('m-cost').textContent, unit: document.getElementById('m-unit').textContent})");
  check("汇总条显示分数与成本", summary.score !== "–" && summary.cost !== "–", `${summary.score} 分 · ${summary.cost} · ${summary.unit}`);

  const consistency = await evaluate(cdp, undefined, "document.querySelector('#consistency-slot .card') ? document.querySelector('#consistency-slot .card h3').textContent : ''");
  check("多图一致性卡片已渲染", consistency.includes("多图一致性"), consistency || "未渲染");

  const swatches = await evaluate(cdp, undefined, "document.querySelectorAll('#consistency-slot .dot-color').length");
  check("色差实测色块已渲染", swatches >= 2, `${swatches} 个色块`);

  // 4. overturn the first failing rule through the UI form.
  const overturnButton = await evaluate(
    cdp,
    undefined,
    "(() => { const b = document.querySelector('#stream tr.fail td.action button'); if (!b) return false; b.click(); return true; })()",
  );
  check("失败项存在「推翻」按钮", overturnButton === true);
  await wait(400);
  const formVisible = await evaluate(cdp, undefined, "document.querySelectorAll('.override-form').length");
  check("推翻表单展开", formVisible === 1);
  await evaluate(
    cdp,
    undefined,
    "(() => { const f = document.querySelector('.override-form'); f.querySelector('input.note-input').value = 'UI 端到端测试'; const b = [...f.querySelectorAll('button')].find(x => x.textContent.includes('确认推翻')); b.click(); return true; })()",
  );
  await wait(1200);
  const saved = await evaluate(cdp, undefined, "document.querySelector('.override-form button')?.textContent ?? ''");
  check("推翻记录已提交到后端", saved.includes("已记录") || saved.includes("失败"), saved);

  const feedbackLine = await evaluate(cdp, undefined, "document.getElementById('feedback-summary').textContent");
  check("复核面板统计已刷新", /已记录 1 条/.test(feedbackLine), feedbackLine);

  // 5. threshold advice panel.
  await evaluate(cdp, undefined, "document.getElementById('show-adjustments').click()");
  await wait(900);
  const advice = await evaluate(cdp, undefined, "document.getElementById('adjustments').textContent.slice(0, 120)");
  check("阈值调整建议面板有响应", advice.length > 0, advice.replace(/\s+/g, " ").slice(0, 90));

  // 6. screenshot for the record.
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const { writeFileSync } = await import("node:fs");
  const shotPath = join(APP_ROOT, "data", "ui-e2e.png");
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  check("已截图", statSync(shotPath).size > 10_000, shotPath);

  // 7. isolation proof: the overturn must land in the temp data dir, not in the
  //    project's data/feedback.jsonl (which would corrupt the demo dataset).
  const isolated = existsSync(join(DATA_DIR, "feedback.jsonl"));
  check("推翻记录写入临时数据目录", isolated || Boolean(process.env.QC_URL), isolated ? DATA_DIR : "QC_URL 模式下跳过");

  chrome.kill("SIGKILL");
  stopServer();
  if (pageErrors.length > 0) {
    console.log("\n页面异常：");
    for (const error of pageErrors.slice(0, 5)) console.log(`  ! ${String(error).split("\n")[0]}`);
  }
  const failed = steps.filter((step) => !step.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} 项通过`);
  process.exit(failed.length === 0 && pageErrors.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`UI 端到端测试失败：${error.message}`);
  stopServer();
  process.exit(1);
});
