#!/usr/bin/env node
/**
 * Sample generator.
 *
 * `--png` writes the synthetic gradient/checkerboard fixtures that the unit
 * tests use (pure Node, deterministic, no browser needed). Without it, the
 * script drives headless Chrome to render six *realistic* product photos with
 * the defects an e-commerce QC checklist looks for, so the demo has something
 * honest to show.
 *
 *   node scripts/make-samples.mjs           # Chrome screenshots → samples/
 *   node scripts/make-samples.mjs --live     # also run the real vision model once
 *   node scripts/make-samples.mjs --png      # synthetic fixtures → test/fixtures/
 *
 * @module vision-qc-agent/scripts/make-samples
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeSyntheticPng } from "../src/image/synthetic.mjs";

const run = promisify(execFile);
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return process.env.QC_CHROME && existsSync(process.env.QC_CHROME) ? process.env.QC_CHROME : undefined;
}

function product({ background, garment, size, text, watermark, clutter, dark, shadow, softness }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden}
    body{background:${background};display:grid;place-items:center;position:relative;
      filter:${softness ? `blur(${softness}px)` : "none"}}
    .scene{position:relative;width:94%;height:94%}
    .garment{position:absolute;inset:${clutter ? "4% 3% 8% 5%" : "2% 4% 6% 5%"};
      background:
        repeating-linear-gradient(94deg, rgba(255,255,255,.055) 0 2px, rgba(0,0,0,.05) 2px 4px),
        repeating-linear-gradient(0deg, rgba(255,255,255,.03) 0 3px, rgba(0,0,0,.035) 3px 6px),
        radial-gradient(120% 90% at 34% 22%, rgba(255,255,255,.30), rgba(255,255,255,0) 58%),
        ${garment};
      border-radius:${garment.shape ?? "26px 26px 20px 20px"};
      box-shadow:${shadow ? "16px 22px 38px rgba(0,0,0,.28), inset -18px -24px 60px rgba(0,0,0,.16), inset 12px 10px 40px rgba(255,255,255,.16)" : "inset -14px -20px 50px rgba(0,0,0,.10)"};
      ${garment.extra ?? ""}}
    .collar{position:absolute;left:50%;top:5%;transform:translateX(-50%);
      width:32%;height:14%;border-radius:50%;background:rgba(0,0,0,.26)}
    .sleeve{position:absolute;top:12%;width:24%;height:50%;background:inherit;
      border-radius:26px;opacity:.95}
    .sleeve.l{left:-15%;transform:rotate(12deg)}
    .sleeve.r{right:-15%;transform:rotate(-12deg)}
    .seam{position:absolute;left:8%;right:8%;bottom:13%;height:2px;background:rgba(0,0,0,.18)}
    .button{position:absolute;left:50%;transform:translateX(-50%);width:5.5%;height:5.5%;
      border-radius:50%;background:rgba(255,255,255,.88);box-shadow:0 1px 2px rgba(0,0,0,.25)}
    .fold{position:absolute;height:3px;background:rgba(0,0,0,.14);border-radius:3px;
      filter:blur(.6px)}
    .prop{position:absolute;border-radius:8px}
    .promo{position:absolute;top:5%;left:50%;transform:translateX(-50%);width:86%;
      text-align:center;font:800 ${Math.round(size / 11)}px/1.25 "PingFang SC",sans-serif;color:#fff;
      background:linear-gradient(90deg,#ff2d55,#ff9500);padding:10px 0;border-radius:10px;
      box-shadow:0 8px 24px rgba(255,45,85,.42)}
    .watermark{position:absolute;right:3%;bottom:4%;font:700 ${Math.round(size / 26)}px/1 "PingFang SC",sans-serif;
      color:rgba(0,0,0,.32)}
    .price{position:absolute;left:6%;bottom:6%;font:800 ${Math.round(size / 14)}px/1 sans-serif;color:#e11d48;
      text-shadow:0 2px 10px rgba(255,255,255,.8)}
    .tint{position:absolute;inset:0;background:${dark ? "rgba(8,12,24,.55)" : "transparent"}}
  </style></head><body>
    <div class="scene">
      <div class="garment"><div class="collar"></div><div class="sleeve l"></div><div class="sleeve r"></div>
        <div class="seam"></div><div class="button" style="top:26%"></div><div class="button" style="top:42%"></div>
        <div class="fold" style="top:58%;left:14%;width:58%"></div>
        <div class="fold" style="top:67%;left:22%;width:46%"></div>
        <div class="fold" style="top:76%;left:10%;width:64%"></div>
        <div class="fold" style="top:34%;left:16%;width:34%"></div>
      </div>
      ${clutter ? `<div class="prop" style="right:4%;top:22%;width:16%;height:16%;background:#7c3aed;opacity:.5;transform:rotate(18deg)"></div>
      <div class="prop" style="left:2%;bottom:18%;width:22%;height:10%;background:#facc15;opacity:.55"></div>
      <div class="prop" style="right:10%;bottom:8%;width:26%;height:7%;background:#0ea5e9;opacity:.45"></div>` : ""}
    </div>
    ${text ? `<div class="promo">限时 5 折 · 今日下单立减 ¥99</div>` : ""}
    ${text ? `<div class="price">¥199</div>` : ""}
    ${watermark ? `<div class="watermark">© 某某旗舰店 盗图必究</div>` : ""}
    <div class="tint"></div>
  </body></html>`;
}

const SAMPLES = [
  {
    file: "01-perfect-white.png",
    size: 1000,
    html: product({
      background: "#ffffff",
      garment: "#2f6fb3",
      size: 1000,
      shadow: false,
    }),
  },
  {
    file: "02-fine-pass.png",
    size: 1000,
    html: product({
      background: "#f3f6fa",
      garment: "#c2410c",
      size: 1000,
      shadow: true,
      clutter: false,
    }),
  },
  {
    file: "03-marketing-text.png",
    size: 1000,
    html: product({
      background: "#ffffff",
      garment: "#111827",
      size: 1000,
      text: true,
      shadow: false,
    }),
  },
  {
    file: "04-watermark-logo.png",
    size: 1000,
    html: product({
      background: "#ffffff",
      garment: "#0f766e",
      size: 1000,
      watermark: true,
      shadow: true,
    }),
  },
  {
    file: "05-lowres-messy.png",
    size: 520,
    html: product({
      background: "#d9c9a8",
      garment: "#7f1d1d",
      size: 520,
      clutter: true,
      shadow: true,
      softness: 1.6,
    }),
  },
  {
    file: "06-dark-oversized.png",
    size: 1400,
    html: product({
      background: "#1f2937",
      garment: "#166534",
      size: 1400,
      dark: true,
      shadow: true,
      clutter: true,
      softness: 0.6,
    }),
  },
];

/**
 * Capture one screenshot.
 *
 * Headless Chrome writes the PNG and then lingers for ~30s before exiting, so
 * waiting on process exit wastes half a minute per image. We instead poll for
 * the output file to reach a stable size and then stop the browser ourselves.
 */
function capture(chrome, args, target, env, timeoutMs = 60_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(chrome, args, { env, stdio: "ignore" });
    const started = Date.now();
    let lastSize = -1;
    let stableTicks = 0;
    const tick = setInterval(() => {
      if (existsSync(target)) {
        const size = statSync(target).size;
        if (size > 0 && size === lastSize) stableTicks += 1;
        else stableTicks = 0;
        lastSize = size;
        if (stableTicks >= 2) return finish();
      }
      if (Date.now() - started > timeoutMs) {
        finish(new Error(`Chrome 在 ${timeoutMs}ms 内未生成截图 ${target}`));
      }
    }, 250);
    const finish = (error) => {
      clearInterval(tick);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolvePromise(target);
    };
    child.on("error", (error) => finish(error));
  });
}

async function shoot(chrome, sample, outDir, tmpDir) {
  const htmlPath = join(tmpDir, `${sample.file}.html`);
  const target = join(outDir, sample.file);
  await writeFile(htmlPath, sample.html, "utf8");
  // A fresh profile per image: a stale singleton lock makes headless Chrome hang.
  const profile = join(tmpDir, `profile-${sample.file.replace(/[^\w]+/g, "_")}`);
  await capture(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--no-sandbox",
      "--user-data-dir=" + profile,
      "--crash-dumps-dir=" + join(tmpDir, "crash"),
      `--window-size=${sample.size},${sample.size}`,
      `--screenshot=${target}`,
      `file://${htmlPath}`,
    ],
    target,
    // Keep every Chrome scratch file inside the project so the run works in a
    // sandbox that only allows writes under the workspace.
    { ...process.env, TMPDIR: tmpDir, XDG_CONFIG_HOME: join(tmpDir, "config"), XDG_CACHE_HOME: join(tmpDir, "cache") },
  );
  return target;
}

async function generateScreenshots(live) {
  const chrome = findChrome();
  if (!chrome) {
    process.stderr.write("未找到 Chrome/Chromium/Edge，无法生成截图样例。可改用 `--png` 生成合成图。\n");
    process.exit(1);
  }
  const outDir = join(APP_ROOT, "samples");
  const tmpDir = join(APP_ROOT, "data", "sample-build");
  await mkdir(outDir, { recursive: true });
  await mkdir(join(tmpDir, "crash"), { recursive: true });
  for (const sample of SAMPLES) {
    const target = await shoot(chrome, sample, outDir, tmpDir);
    process.stdout.write(`  ✓ ${target}\n`);
  }
  process.stdout.write(`\n已生成 ${SAMPLES.length} 张样例图 → ${outDir}\n`);
  if (live) {
    process.stdout.write("\n用真实视觉模型跑一遍…\n\n");
    await run(process.execPath, [join(APP_ROOT, "src", "cli.mjs"), outDir, "--save"], {
      timeout: 600_000,
      env: process.env,
    }).then(({ stdout }) => process.stdout.write(stdout));
  }
}

async function generateSynthetic() {
  const dir = join(APP_ROOT, "test", "fixtures");
  await mkdir(dir, { recursive: true });
  const fixtures = [
    { name: "white-1200.png", size: 1200, kind: "white" },
    { name: "gradient-800.png", size: 800, kind: "gradient" },
    { name: "checker-640.png", size: 640, kind: "checker" },
    { name: "wide-1600x900.png", width: 1600, height: 900, kind: "gradient" },
  ];
  for (const fixture of fixtures) {
    const target = join(dir, fixture.name);
    await writeSyntheticPng(target, fixture);
    process.stdout.write(`  ✓ ${target}\n`);
  }
  process.stdout.write(`\n已生成 ${fixtures.length} 张测试基准图 → ${dir}\n`);
}

const argv = process.argv.slice(2);
if (argv.includes("--png")) await generateSynthetic();
else await generateScreenshots(argv.includes("--live"));
