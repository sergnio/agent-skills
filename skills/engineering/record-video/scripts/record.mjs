#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, loadPlaywright, parseArgs } from './lib.mjs';

const HELP = `Usage: record.mjs --url URL --scenario FILE.mjs --out DIR [options]

Records real browser frames (CDP screencast, every painted frame) while the
scenario's run() executes. prepare() runs first and is NOT recorded.

Options:
  --width PX         CSS viewport width (default 1440)
  --height PX        CSS viewport height (default 900)
  --dpr N            Device pixel ratio (default 1)
  --mobile           Mobile + touch emulation
  --lead-ms MS       Recorded idle time before run() (default 500)
  --linger-ms MS     Recorded idle time after run() (default 1500)
  --playwright DIR   Project dir to load Playwright from (default: cwd)
  --headed           Show the browser window
  --force            Replace DIR if it already exists

Writes DIR/frames/*.png, DIR/frames.txt (ffmpeg concat manifest with real frame
durations) and DIR/meta.json (frame count, duration, marks).`;

const S = 'record';
const args = parseArgs(S, process.argv.slice(2), { flags: ['mobile', 'headed', 'force'] });
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
for (const key of ['url', 'scenario', 'out']) if (!args[key]) fail(S, `--${key} is required`);
const scenarioPath = isAbsolute(args.scenario) ? args.scenario : resolve(args.scenario);
if (!existsSync(scenarioPath)) fail(S, `scenario not found: ${scenarioPath}`);
const outDir = resolve(args.out);
if (existsSync(outDir) && readdirSync(outDir).length) {
  if (!args.force) fail(S, `${outDir} is not empty; pass --force to replace it`);
  rmSync(outDir, { recursive: true, force: true });
}
const framesDir = join(outDir, 'frames');
mkdirSync(framesDir, { recursive: true });

const scenario = await import(pathToFileURL(scenarioPath).href);
if (typeof scenario.run !== 'function') fail(S, 'scenario must export async function run({ page, mark })');

/** Keeps repainting an invisible pixel so the screencast records the idle final state. */
async function holdFinalState(page, ms) {
  await page.evaluate(async (duration) => {
    const pixel = Object.assign(document.createElement('div'), { ariaHidden: 'true' });
    pixel.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none';
    document.body.append(pixel);
    const end = performance.now() + duration;
    for (let i = 0; performance.now() < end; i++) {
      pixel.style.background = `rgba(0, 0, 0, ${i % 2 ? 0.01 : 0.02})`;
      await new Promise(requestAnimationFrame);
    }
    pixel.remove();
  }, ms);
}

const { chromium } = loadPlaywright(S, args.playwright);
const width = Number(args.width ?? 1440);
const height = Number(args.height ?? 900);
const browser = await chromium.launch({ headless: !args.headed });
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: Number(args.dpr ?? 1),
    isMobile: Boolean(args.mobile),
    hasTouch: Boolean(args.mobile),
  });
  await page.goto(args.url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (scenario.prepare) await scenario.prepare({ page });

  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(framesDir, `frame-${String(frames.length).padStart(6, '0')}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const marks = {};
  const mark = (name) => {
    marks[name] = Date.now() / 1000;
  };

  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.waitForTimeout(Number(args['lead-ms'] ?? 500));
  await scenario.run({ page, mark });
  await holdFinalState(page, Number(args['linger-ms'] ?? 1500));
  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(150);

  if (frames.length < 2) fail(S, `captured only ${frames.length} frame(s)`);
  const t0 = frames[0].t;
  const tail = 1 / 30;
  const manifest = frames
    .map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + tail) - f.t).toFixed(6)}`)
    .join('\n');
  writeFileSync(join(outDir, 'frames.txt'), `${manifest}\nfile '${frames.at(-1).file}'\n`);
  const meta = {
    url: args.url,
    scenario: scenarioPath,
    viewport: { width, height, dpr: Number(args.dpr ?? 1), mobile: Boolean(args.mobile) },
    frameCount: frames.length,
    durationSeconds: Number((frames.at(-1).t - t0 + tail).toFixed(3)),
    averageFps: Number(((frames.length - 1) / (frames.at(-1).t - t0)).toFixed(1)),
    marks: Object.fromEntries(Object.entries(marks).map(([k, t]) => [k, Number((t - t0).toFixed(3))])),
  };
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify(meta, null, 2));
} finally {
  await browser.close();
}
