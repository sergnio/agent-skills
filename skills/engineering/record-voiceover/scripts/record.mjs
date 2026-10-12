#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail, loadPlaywright, parseArgs, run } from '../../record-video/scripts/lib.mjs';

const HELP = `Usage: record.mjs --url URL --scenario FILE.mjs --out DIR [options]

Records real macOS VoiceOver output while the scenario's run() drives a
dedicated Chromium window: the browser window, a strip naming each step, and
VoiceOver's caption panel, plus system audio when the Mac is not muted.
prepare() runs first and is NOT recorded.

Options:
  --title TEXT        Header shown above the video (default: the URL)
  --width PT          Browser window width in points (default 1000)
  --height PT         Browser window height in points (default 720)
  --hold-ms MS        Default wait after each step() so VoiceOver can finish (default 3000)
  --lead-ms MS        Recorded idle time before run() (default 1500)
  --linger-ms MS      Recorded idle time after run() (default 2500)
  --start-voiceover   Start VoiceOver if it is off, and quit it afterwards
  --no-audio          Don't capture system audio
  --channel NAME      Playwright browser channel, e.g. chrome (default: bundled Chromium)
  --playwright DIR    Project dir to load Playwright from (default: cwd)
  --force             Replace DIR if it already exists

Writes DIR/voiceover.mp4, DIR/voiceover-sheet.png (contact sheet),
DIR/transcript.json (caption panel text over time, read with macOS Vision OCR),
and DIR/frames.txt + DIR/meta.json so record-video's compose.mjs can put
several runs side by side.`;

const S = 'record-voiceover';
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const args = parseArgs(S, process.argv.slice(2), { flags: ['start-voiceover', 'no-audio', 'force'] });
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (process.platform !== 'darwin') fail(S, 'VoiceOver recording needs macOS');
for (const key of ['url', 'scenario', 'out']) if (!args[key]) fail(S, `--${key} is required`);
const scenarioPath = isAbsolute(args.scenario) ? args.scenario : resolve(args.scenario);
if (!existsSync(scenarioPath)) fail(S, `scenario not found: ${scenarioPath}`);
const outDir = resolve(args.out);
if (existsSync(outDir) && readdirSync(outDir).length) {
  if (!args.force) fail(S, `${outDir} is not empty; pass --force to replace it`);
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });
const scenario = await import(pathToFileURL(scenarioPath).href);
if (typeof scenario.run !== 'function') fail(S, 'scenario must export async function run({ page, step, mark })');

const holdMs = Number(args['hold-ms'] ?? 3000);
const width = Number(args.width ?? 1000);
const height = Number(args.height ?? 720);
const rawVideo = join(outDir, 'raw.mp4');
const rawAudio = join(outDir, 'raw-audio.mp4');
const muted = run(S, 'osascript', ['-e', 'output muted of (get volume settings)']).trim() === 'true';
const wantAudio = !args['no-audio'] && !muted;
const helper = buildHelper();
const { chromium } = loadPlaywright(S, args.playwright);

/** Compiles vo-helper.swift once per source version into the user cache. */
function buildHelper() {
  const source = join(SCRIPTS, 'vo-helper.swift');
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12);
  const binary = join(homedir(), 'Library/Caches/record-voiceover', `vo-helper-${hash}`);
  if (!existsSync(binary)) {
    mkdirSync(dirname(binary), { recursive: true });
    run(S, 'swiftc', ['-O', '-swift-version', '5', source, '-o', binary]);
  }
  return binary;
}

function voiceOverPid() {
  const result = spawnSync('pgrep', ['-x', 'VoiceOver'], { encoding: 'utf8' });
  return result.status === 0 ? Number(result.stdout.trim().split('\n')[0]) : undefined;
}

async function startVoiceOver() {
  run(S, 'open', ['/System/Library/CoreServices/VoiceOver.app']);
  for (let i = 0; i < 50; i += 1) {
    const pid = voiceOverPid();
    if (pid) {
      await new Promise((r) => setTimeout(r, 2500));
      return pid;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(S, 'VoiceOver did not start');
}

function stopVoiceOver(pid) {
  spawnSync('kill', [String(pid)]);
  spawnSync('defaults', ['write', 'com.apple.universalaccess', 'voiceOverOnOffKey', '-int', '0']);
}

async function browserProcessId(browser) {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  return processInfo.find((p) => p.type === 'browser').id;
}

/** The main display's top-left is (0, 0) in macOS window coordinates. */
async function placeWindowOnMainDisplay(page) {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  // Chrome can report a stale position and skip a move to it, so nudge first.
  for (const offset of [20, 0]) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40 + offset, top: 60 + offset, width, height, windowState: 'normal' } });
    await page.waitForTimeout(300);
  }
}

function frontmostPid() {
  const front = run(S, 'lsappinfo', ['front']).trim();
  return Number(run(S, 'lsappinfo', ['info', '-only', 'pid', front]).match(/=(\d+)/)?.[1]);
}

/** Starts vo-helper capture and resolves with its ready event (crop rects in pixels). */
function startCapture(pid) {
  const audioArgs = wantAudio ? ['--audio-out', rawAudio] : [];
  const child = spawn(helper, ['capture', '--out', rawVideo, '--pid', String(pid), ...audioArgs], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = createInterface({ input: child.stdout });
  const exited = new Promise((r) => child.on('exit', r));
  const ready = new Promise((resolveReady, rejectReady) => {
    events.on('line', (line) => {
      const event = JSON.parse(line);
      if (event.event === 'ready') resolveReady(event);
    });
    exited.then((code) => rejectReady(new Error(`vo-helper exited with ${code} before recording`)));
  });
  return { ready, stop: () => (child.stdin.end(), exited) };
}

let startedVoiceOver;
let capture;
let ready;
let failure;
const steps = [];
const marks = {};
process.on('SIGINT', () => {
  if (startedVoiceOver) stopVoiceOver(startedVoiceOver);
  process.exit(130);
});
try {
  if (!voiceOverPid()) {
    if (!args['start-voiceover']) throw new Error('VoiceOver is off. Turn it on (Cmd+F5) or pass --start-voiceover.');
    startedVoiceOver = await startVoiceOver();
  }
  const browser = await chromium.launch({
    headless: false,
    channel: args.channel,
    args: ['--force-renderer-accessibility'],
  });
  try {
    const page = await (await browser.newContext({ viewport: null })).newPage();
    await page.goto(args.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    if (scenario.prepare) await scenario.prepare({ page });

    const browserPid = await browserProcessId(browser);
    await placeWindowOnMainDisplay(page);
    for (let attempt = 0; frontmostPid() !== browserPid; attempt += 1) {
      if (attempt === 5) throw new Error('could not bring the browser to the front; VoiceOver would read another app');
      await page.bringToFront();
      await page.waitForTimeout(500);
    }
    capture = startCapture(browserPid);
    ready = await capture.ready;
    const t0 = Date.now();
    if (!ready.captionPanel) {
      throw new Error('VoiceOver caption panel not found. Enable it in VoiceOver Utility > Visuals > Panels and Menus.');
    }
    const elapsed = () => Number(((Date.now() - t0) / 1000).toFixed(3));
    const step = async (label, action, options = {}) => {
      steps.push({ t: elapsed(), label });
      await action?.();
      await page.waitForTimeout(options.holdMs ?? holdMs);
    };
    const mark = (name) => {
      marks[name] = elapsed();
    };
    await page.waitForTimeout(Number(args['lead-ms'] ?? 1500));
    await scenario.run({ page, step, mark });
    await page.waitForTimeout(Number(args['linger-ms'] ?? 2500));
  } finally {
    await capture?.stop();
    await browser.close();
  }
} catch (error) {
  failure = error;
} finally {
  if (startedVoiceOver) stopVoiceOver(startedVoiceOver);
}
if (failure) fail(S, failure.message);

const probeDuration = (file) =>
  Number(run(S, 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
const even = (n) => Math.round(n / 2) * 2;
const cropOf = ({ width: w, height: h, x, y }) => `crop=${even(w)}:${even(h)}:${even(x)}:${even(y)}`;
const duration = probeDuration(rawVideo);
const outWidth = even(ready.window.width / ready.scale);

const scratch = mkdtempSync(join(tmpdir(), 'record-voiceover-'));
try {
  const captionFrames = join(scratch, 'caption');
  mkdirSync(captionFrames);
  run(S, 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', rawVideo, '-vf', `fps=2,${cropOf(ready.captionPanel)}`, join(captionFrames, '%05d.png')]);
  const captionPngs = readdirSync(captionFrames).sort().map((f) => join(captionFrames, f));
  const texts = JSON.parse(run(S, helper, ['ocr', ...captionPngs]));
  const transcript = [];
  texts.forEach((text, i) => {
    if (text && text !== transcript.at(-1)?.text) transcript.push({ t: i / 2, text });
  });
  writeFileSync(join(outDir, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`);

  const labels = await renderLabels(scratch);
  const audioLevel = wantAudio ? maxVolume(rawAudio) : undefined;
  const audio = muted ? 'muted' : args['no-audio'] ? 'off' : audioLevel > -60 ? 'captured' : 'silent';
  const inputs = ['-i', rawVideo, ...(audio === 'captured' ? ['-i', rawAudio] : [])];
  const firstLabel = inputs.length / 2;
  const labelInputs = labels.flatMap((png) => ['-loop', '1', '-framerate', String(FPS), '-i', png]);
  const [title, idle, captionTitle, ...stepLabels] = labels.map((_, i) => `[${firstLabel + i}:v]`);
  const stepOverlays = steps.map(({ t }, i) => {
    const end = steps[i + 1]?.t ?? duration;
    return `${stepLabels[i]}overlay=enable='between(t,${t},${end})'[k${i}]`;
  });
  const graph = [
    `[0:v]fps=${FPS},split[w][c]`,
    `[w]${cropOf(ready.window)},scale=${outWidth}:-2[win]`,
    `[c]${cropOf(ready.captionPanel)},scale=${outWidth}:-2[cap]`,
    ...stepOverlays.map((overlay, i) => `${i ? `[k${i - 1}]` : idle}${overlay}`),
    `${title}[win]${steps.length ? `[k${steps.length - 1}]` : idle}${captionTitle}[cap]vstack=5,format=yuv420p[out]`,
  ];
  const video = join(outDir, 'voiceover.mp4');
  run(S, 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', ...inputs, ...labelInputs,
    '-filter_complex', graph.join(';'), '-map', '[out]', ...(audio === 'captured' ? ['-map', '1:a', '-c:a', 'aac'] : []),
    '-t', duration.toFixed(3), '-r', String(FPS), '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', video,
  ]);
  const [videoWidth, videoHeight] = run(S, 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video])
    .trim()
    .split(',')
    .map(Number);
  const sheet = join(outDir, 'voiceover-sheet.png');
  const sheetEvery = Math.max(1, Math.floor((duration * FPS) / 12));
  run(S, 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', video,
    '-vf', `select='not(mod(n\\,${sheetEvery}))',scale=${Math.min(videoWidth, 600)}:-2,tile=3x4:padding=4:color=black`,
    '-frames:v', '1', '-update', '1', sheet,
  ]);

  writeFileSync(join(outDir, 'frames.txt'), `file '${video}'\n`);
  const meta = {
    url: args.url,
    scenario: scenarioPath,
    viewport: { width: videoWidth, height: videoHeight, dpr: 1 },
    durationSeconds: Number(duration.toFixed(3)),
    audio,
    steps,
    marks,
    video,
    contactSheet: sheet,
    transcript,
  };
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  rmSync(rawAudio, { force: true });
  console.log(JSON.stringify(meta, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function maxVolume(file) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = result.stderr.match(/max_volume: (-?[\d.]+|-inf) dB/);
  return match && match[1] !== '-inf' ? Number(match[1]) : -Infinity;
}

/** Renders title, step, and section labels as PNGs with Chromium, since many ffmpeg builds lack drawtext. */
async function renderLabels(dir) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: outWidth, height: 200 } });
    const render = async (name, text, { size = 20, background = '#141414', barHeight = 44 } = {}) => {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      await page.setContent(
        `<body style="margin:0"><div id="l" style="box-sizing:border-box;width:${outWidth}px;height:${barHeight}px;padding:0 16px;display:flex;align-items:center;font:600 ${size}px -apple-system,Arial,sans-serif;color:#fff;background:${background};white-space:nowrap;overflow:hidden">${escaped}</div></body>`
      );
      const path = join(dir, `${name}.png`);
      await page.locator('#l').screenshot({ path });
      return path;
    };
    const paths = [
      await render('title', args.title ?? args.url, { size: 17, background: '#000' }),
      await render('idle', 'Step: (none yet)', { background: '#1f3a5f' }),
      await render('caption-title', 'VoiceOver caption panel (what VoiceOver spoke):', { size: 15, background: '#000', barHeight: 32 }),
    ];
    for (const [i, { label }] of steps.entries()) paths.push(await render(`step${i}`, `Step: ${label}`, { background: '#1f3a5f' }));
    return paths;
  } finally {
    await browser.close();
  }
}
