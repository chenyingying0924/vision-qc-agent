/**
 * HTTP layer integration test — the part `curl` used to cover manually.
 *
 * Starts the real server in-process on an ephemeral port with:
 *   QC_MOCK=1        → no model calls, no API key needed
 *   QC_NO_SAVE=1     → never writes into reports/
 *   QC_DATA_DIR=tmp  → the overturn log goes somewhere disposable
 *
 * Offline and repeatable: no network, no key, no fixed port, no leftover state.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { encodePng } from "../src/image/synthetic.mjs";

/* Environment must be set before the server module is imported: `config.mjs`
   resolves everything at import time (and fails fast on garbage). */
const DATA_DIR = mkdtempSync(join(tmpdir(), "qc-http-data-"));
process.env.QC_MOCK = "1";
process.env.QC_NO_SAVE = "1";
process.env.QC_NO_LISTEN = "1";
process.env.QC_DATA_DIR = DATA_DIR;
process.env.QC_MAX_IMAGES = "2";

const { config, server } = await import("../src/server.mjs");

let base = "";

before(async () => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
});

const png = (shade) => encodePng(160, 160, shade);

/** Build a multipart body the way the browser does. */
function form(files, fields = {}) {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  for (const file of files) body.append("images", new Blob([file.buffer], { type: "image/png" }), file.name);
  return body;
}

/** Read an SSE response into `{text, events}`. */
async function readSse(response) {
  const text = await response.text();
  const events = text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
  return { text, events };
}

test("health reports the route without leaking the key", async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.config.mock, true);
  assert.equal(body.config.apiKey, undefined, "the key value must never be serialised");
  assert.equal(JSON.stringify(body).includes(config.apiKey ?? "\u0000nokey"), false);
});

test("checklists and facts are served as JSON", async () => {
  const checklists = await fetch(`${base}/api/checklists`).then((response) => response.json());
  assert.equal(checklists.checklists.length, 4);
  const facts = await fetch(`${base}/api/facts`).then((response) => response.json());
  assert.ok(Object.keys(facts.facts).length > 40);
});

test("POST /api/inspect streams a full SSE run", async () => {
  const response = await fetch(`${base}/api/inspect`, {
    method: "POST",
    body: form([{ name: "one.png", buffer: png(() => [255, 255, 255]) }], { mock: "1" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const { events, text } = await readSse(response);
  const types = events.map((event) => event.type);
  for (const expected of ["batch-start", "image-start", "image-measured", "image-facts", "image-report", "cost", "batch-end", "saved", "complete"]) {
    assert.ok(types.includes(expected), `missing ${expected} in ${types.join(",")}`);
  }
  assert.equal(events.find((event) => event.type === "batch-start").mock, true);
  assert.equal(events.find((event) => event.type === "saved").dir, null, "QC_NO_SAVE must skip writing reports");
  assert.match(text, /^: connected/, "the stream opens with a comment frame");
});

test("a two-image batch produces exactly one consistency-report event", async () => {
  const response = await fetch(`${base}/api/inspect`, {
    method: "POST",
    body: form(
      [
        { name: "a.png", buffer: png(() => [200, 30, 30]) },
        { name: "b.png", buffer: png(() => [30, 30, 200]) },
      ],
      { mock: "1", consistency: "1" },
    ),
  });
  const { events } = await readSse(response);
  const reports = events.filter((event) => event.type === "consistency-report");
  assert.equal(reports.length, 1, "the cached path used to emit this event twice");
  assert.equal(reports[0].report.ok, true);
});

test("over-cap uploads are reported with a dropped count", async () => {
  const files = [
    { name: "1.png", buffer: png(() => [255, 255, 255]) },
    { name: "2.png", buffer: png(() => [250, 250, 250]) },
    { name: "3.png", buffer: png(() => [245, 245, 245]) },
  ];
  const response = await fetch(`${base}/api/inspect`, { method: "POST", body: form(files, { mock: "1", consistency: "0" }) });
  const { events } = await readSse(response);
  const start = events.find((event) => event.type === "batch-start");
  assert.equal(start.total, 2, "QC_MAX_IMAGES=2 caps the batch");
  assert.equal(start.dropped, 1);
  const warning = events.find((event) => event.type === "batch-warning");
  assert.ok(warning, "the caller is told about the dropped file");
  assert.match(warning.message, /1 张/);
});

test("a malformed multipart request answers 400, not 500", async () => {
  const response = await fetch(`${base}/api/inspect`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not multipart at all",
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "BAD_MULTIPART");
});

test("an unknown checklist id is a 400 with the valid ids", async () => {
  const response = await fetch(`${base}/api/inspect`, {
    method: "POST",
    body: form([{ name: "one.png", buffer: png(() => [255, 255, 255]) }], { mock: "1", checklistId: "nope" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "UNKNOWN_CHECKLIST");
  assert.deepEqual(body.available.sort(), ["design-review", "detail-page", "ecom-main-image", "live-cover"]);
});

test("a non-image upload is refused before any vision work (422)", async () => {
  const body = new FormData();
  body.append("mock", "1");
  body.append("images", new Blob([Buffer.from("plain text, not an image")], { type: "image/png" }), "fake.png");
  const response = await fetch(`${base}/api/inspect`, { method: "POST", body });
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.code, "UNSUPPORTED_FORMAT");
  assert.deepEqual(payload.files, ["fake.png"]);
});

test("static serving does not escape the public directory", async () => {
  for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/../../../../etc/passwd"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, `${path} must not be served`);
  }
  const ok = await fetch(`${base}/`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /视觉质检 Agent/);
});

test("feedback round-trips into the isolated data dir", async () => {
  const empty = await fetch(`${base}/api/feedback`).then((response) => response.json());
  assert.equal(empty.total, 0, "the temp data dir starts empty");

  const bad = await fetch(`${base}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "BAD_JSON");

  const wrongReason = await fetch(`${base}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageName: "a.png", ruleId: "R01", reason: "not-a-reason" }),
  });
  assert.equal(wrongReason.status, 400);

  const created = await fetch(`${base}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageName: "a.png", ruleId: "R02", reason: "rule-misapplied", note: "http test", context: { checklistId: "ecom-main-image" } }),
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.total, 1);

  const logPath = join(DATA_DIR, "feedback.jsonl");
  assert.equal(existsSync(logPath), true, "the record lands in QC_DATA_DIR");
  assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 1);

  const adjustments = await fetch(`${base}/api/adjustments?checklistId=ecom-main-image`).then((response) => response.json());
  assert.equal(adjustments.overturns, 1);
  assert.ok(Array.isArray(adjustments.suggestions));

  // Same contract as /api/inspect: an explicit-but-unknown id is a 400.
  const badAdjustments = await fetch(`${base}/api/adjustments?checklistId=nope`);
  assert.equal(badAdjustments.status, 400);
  assert.equal((await badAdjustments.json()).code, "UNKNOWN_CHECKLIST");
});

test("unsupported methods answer 405", async () => {
  const response = await fetch(`${base}/api/health`, { method: "PUT" });
  assert.equal(response.status, 405);
});
