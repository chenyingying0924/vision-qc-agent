/**
 * Zero-dependency HTTP server: JSON API, multipart upload, SSE progress, static UI.
 *
 * Deliberately built on `node:http` only — the project has no runtime
 * dependencies, so `npm start` works on a clean machine with no install step
 * and the demo has nothing to break.
 *
 * @module vision-qc-agent/server
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { loadConfig, publicConfig } from "./config.mjs";
import { FACT_CATALOG } from "./core/facts.mjs";
import { FeedbackStore, OVERTURN_REASONS, suggestAdjustments } from "./core/feedback.mjs";
import { formatMoney, projection, RATE_CARD } from "./core/pricing.mjs";
import { parseMultipart } from "./core/multipart.mjs";
import { inspectBatch, saveReports } from "./core/pipeline.mjs";
import { loadChecklists } from "./core/rules.mjs";

const config = loadConfig();
const PUBLIC_DIR = join(config.appRoot, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Reports survive restarts and make repeat runs free. */
const reportCache = new Map();
/** Consistency results are cached per image group so a replayed batch is free. */
const consistencyCache = new Map();
/** Reviewer overturns live in an append-only JSONL log under the project. */
const feedback = new FeedbackStore(join(config.appRoot, "data", "feedback.jsonl"));

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`上传内容超过上限 ${Math.round(limit / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Server-sent-events writer; each call emits one `data:` frame. */
function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  return (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const target = normalize(join(PUBLIC_DIR, relative));
  const insidePublic = target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + sep);
  if (!insidePublic || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return json(res, 200, { ok: true, config: publicConfig(config) });
    }

    if (req.method === "GET" && pathname === "/api/checklists") {
      return json(res, 200, { checklists: loadChecklists(join(config.appRoot, "checklists")) });
    }

    if (req.method === "GET" && pathname === "/api/facts") {
      return json(res, 200, { facts: FACT_CATALOG });
    }

    if (req.method === "GET" && pathname === "/api/reports") {
      return json(res, 200, {
        reports: [...reportCache.values()].map((report) => ({
          key: report.key,
          name: report.image.name,
          score: report.score,
          verdict: report.verdict,
          at: report.cachedAt,
          checklist: report.checklist.name,
        })),
      });
    }

    /* ---------------- human-in-the-loop ---------------- */

    if (req.method === "GET" && pathname === "/api/feedback") {
      feedback.reload();
      return json(res, 200, {
        total: feedback.size,
        reasons: OVERTURN_REASONS,
        byRule: feedback.byRule(),
        records: feedback.records.slice(-200),
      });
    }

    if (req.method === "POST" && pathname === "/api/feedback") {
      let body;
      try {
        body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
      } catch (error) {
        return json(res, 400, { error: `请求体不是合法 JSON：${error.message}` });
      }
      try {
        const entry = feedback.record({
          imageName: body.imageName,
          ruleId: body.ruleId,
          originalStatus: body.originalStatus ?? "fail",
          reason: body.reason ?? "other",
          note: body.note ?? "",
          reviewer: body.reviewer ?? "anonymous",
          context: body.context ?? {},
        });
        return json(res, 201, { ok: true, entry, total: feedback.size });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && pathname === "/api/adjustments") {
      if (url.searchParams.get("reload") === "1") feedback.reload();
      const checklistId = url.searchParams.get("checklistId");
      const checklists = loadChecklists(join(config.appRoot, "checklists"));
      const checklist = checklists.find((entry) => entry.id === checklistId) ?? checklists[0];
      const failuresByRule = new Map();
      for (const report of reportCache.values()) {
        for (const result of report.results ?? []) {
          if (result.status !== "fail") continue;
          failuresByRule.set(result.id, (failuresByRule.get(result.id) ?? 0) + 1);
        }
      }
      const suggestions = suggestAdjustments({ checklist, store: feedback, options: { failuresByRule } });
      return json(res, 200, {
        checklist: { id: checklist.id, name: checklist.name },
        overturns: feedback.size,
        suggestions,
      });
    }

    if (req.method === "GET" && pathname === "/api/pricing") {
      return json(res, 200, {
        rateCard: RATE_CARD,
        sample: {
          perImageUsd: 0.0002,
          formatted: formatMoney(0.0002),
          projection: projection(0.0002),
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/inspect") {
      const body = await readBody(req, config.maxUploadBytes);
      const { fields, files } = parseMultipart(body, req.headers["content-type"]);
      const images = files
        .filter((file) => file.buffer.length > 0)
        .slice(0, config.maxImages);
      if (images.length === 0) return json(res, 400, { error: "没有收到图片文件" });
      const forceMock = fields.mock === "1" || url.searchParams.get("mock") === "1";
      const wantConsistency = fields.consistency !== "0" && url.searchParams.get("consistency") !== "0";
      const send = sse(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => clearInterval(ping));
      try {
        const { batch, reports, consistency } = await inspectBatch({
          config,
          images,
          checklistId: fields.checklistId,
          forceMock,
          cache: reportCache,
          consistency: wantConsistency,
          consistencyCache,
          feedback,
          onEvent: (event) => send(event),
        });
        const saved = process.env.QC_NO_SAVE === "1" ? null : saveReports(config, batch, reports, consistency);
        send({ type: "saved", dir: saved?.dir ?? null, files: saved?.files?.length ?? 0 });
        send({ type: "complete" });
      } catch (error) {
        send({ type: "fatal", message: error.message });
      } finally {
        clearInterval(ping);
        res.end();
      }
      return undefined;
    }

    if (req.method === "GET") return serveStatic(req, res, pathname);

    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    return res.end("405");
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return undefined;
    }
    if (String(error.message).includes("上传内容超过上限")) {
      return json(res, 413, { error: error.message });
    }
    return json(res, 500, { error: error.message });
  }
});

if (process.env.QC_NO_LISTEN !== "1") {
  server.listen(config.port, "127.0.0.1", () => {
    const summary = publicConfig(config);
    process.stdout.write(
      [
        `\n  视觉质检 Agent 已启动  http://127.0.0.1:${config.port}`,
        `  视觉线路: ${summary.providerLabel} · ${summary.model}${summary.mock ? " (mock)" : ""}`,
        `  凭据: ${summary.apiKeyEnv} ← ${summary.credentialSource}${summary.apiKeyConfigured ? "" : "  ⚠️ 未配置，将自动使用本地像素兜底"}`,
        "",
      ].join("\n"),
    );
  });
}

export { config, server };
