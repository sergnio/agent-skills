#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fail, loadPlaywright, parseArgs, run } from './lib.mjs';

const HELP = `Usage: compose.mjs --clip DIR=LABEL [--clip DIR=LABEL ...] --out FILE.mp4 [options]

Turns record.mjs captures into one labeled review video: clips side by side,
played in real time, then again in slow motion. Also writes a contact sheet
(FILE-sheet.png) to eyeball the result, and optionally a GIF. If any clip has
ax-steps.json from axCaption(), writes FILE-ax.json with step times in the video.

Options:
  --crop W:H:X:Y    Crop every clip, in frame pixels (CSS px x dpr)
  --slow N          Slow-motion replay factor; 1 disables the replay (default 4)
  --align MARK      Trim clip starts so this record.mjs mark() lines up across clips
  --fps N           Output frame rate (default 60)
  --gif             Also write FILE.gif
  --gif-width PX    GIF width (default: video width, capped at 1000)
  --playwright DIR  Project dir to load Playwright from (renders the labels)
  --force           Overwrite existing outputs`;

const S = 'compose';
const DIVIDER = 2;
const LABEL_BAR = 44;
const TITLE_BAR = 48;
const args = parseArgs(S, process.argv.slice(2), { repeatable: ['clip'], flags: ['gif', 'force'] });
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (!args.clip.length) fail(S, 'at least one --clip DIR=LABEL is required');
if (!args.out || extname(args.out) !== '.mp4') fail(S, '--out must be an .mp4 path');
const out = resolve(args.out);
const gifOut = out.replace(/\.mp4$/, '.gif');
const sheetOut = out.replace(/\.mp4$/, '-sheet.png');
const axOut = out.replace(/\.mp4$/, '-ax.json');
for (const file of [out, sheetOut, axOut, ...(args.gif ? [gifOut] : [])]) {
  if (existsSync(file) && !args.force) fail(S, `${file} exists; pass --force to overwrite`);
}
const fps = Number(args.fps ?? 60);
const slow = Number(args.slow ?? 4);

const clips = args.clip.map((spec) => {
  const split = spec.indexOf('=');
  if (split < 1) fail(S, `--clip must be DIR=LABEL, got: ${spec}`);
  const dir = resolve(spec.slice(0, split));
  const manifest = join(dir, 'frames.txt');
  if (!existsSync(manifest)) fail(S, `no frames.txt in ${dir}; run record.mjs first`);
  const axSteps = join(dir, 'ax-steps.json');
  return {
    dir,
    manifest,
    label: spec.slice(split + 1),
    meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')),
    axSteps: existsSync(axSteps) ? JSON.parse(readFileSync(axSteps, 'utf8')) : [],
  };
});
const viewports = new Set(clips.map(({ meta: { viewport: v } }) => `${v.width}x${v.height}@${v.dpr}`));
if (viewports.size > 1) fail(S, `clips must share one viewport, got ${[...viewports].join(', ')}`);

for (const clip of clips) clip.trim = 0;
if (args.align) {
  const missing = clips.find((clip) => clip.meta.marks?.[args.align] === undefined);
  if (missing) fail(S, `mark "${args.align}" not found in ${missing.dir}/meta.json`);
  const earliest = Math.min(...clips.map((clip) => clip.meta.marks[args.align]));
  for (const clip of clips) clip.trim = clip.meta.marks[args.align] - earliest;
}
const longest = Math.max(...clips.map((clip) => clip.meta.durationSeconds - clip.trim));

const labelDir = mkdtempSync(join(tmpdir(), 'record-video-labels-'));
try {
  const { chromium } = loadPlaywright(S, args.playwright);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const renderLabel = async (name, text, background) => {
    await page.setContent(
      `<body style="margin:0"><div id="l" style="display:inline-block;font:bold 20px Arial,sans-serif;color:#fff;background:${background};padding:6px 10px">${text.replace(/</g, '&lt;')}</div></body>`
    );
    const path = join(labelDir, `${name}.png`);
    await page.locator('#l').screenshot({ path });
    return path;
  };
  const clipLabels = [];
  for (const [i, clip] of clips.entries()) clipLabels.push(await renderLabel(`clip${i}`, clip.label, 'rgba(0,0,0,.78)'));
  const realLabel = await renderLabel('real', 'real time', 'rgba(0,0,0,.78)');
  const slowLabel = await renderLabel('slow', `${slow}x slow motion`, '#c62828');
  await browser.close();

  const inputs = [
    ...clips.flatMap((clip) => ['-f', 'concat', '-safe', '0', '-i', clip.manifest]),
    ...[...clipLabels, realLabel, slowLabel].flatMap((png) => ['-i', png]),
  ];
  const labelInput = (i) => clips.length + i;
  const graph = clips.map((clip, i) => {
    const isLast = i === clips.length - 1;
    const steps = [
      `fps=${fps}`,
      `trim=start=${clip.trim.toFixed(3)}`,
      'setpts=PTS-STARTPTS',
      `tpad=stop_mode=clone:stop_duration=${(longest - (clip.meta.durationSeconds - clip.trim)).toFixed(3)}`,
      ...(args.crop ? [`crop=${args.crop}`] : []),
      `pad=iw+${isLast ? 0 : DIVIDER}:ih+${LABEL_BAR}:0:0:white`,
      ...(isLast ? [] : [`drawbox=x=iw-${DIVIDER}:y=0:w=${DIVIDER}:h=ih:color=gray:t=fill`]),
    ];
    return `[${i}:v]${steps.join(',')}[c${i}];[c${i}][${labelInput(i)}:v]overlay=(main_w-overlay_w-${isLast ? 0 : DIVIDER})/2:main_h-overlay_h-6[l${i}]`;
  });
  const stacked = clips.length > 1 ? `${clips.map((_, i) => `[l${i}]`).join('')}hstack=inputs=${clips.length}` : '[l0]null';
  graph.push(`${stacked},pad=ceil(iw/2)*2:ceil((ih+${TITLE_BAR})/2)*2:0:${TITLE_BAR}:white,split[forReal][forSlow]`);
  graph.push(`[forReal][${labelInput(clips.length)}:v]overlay=(main_w-overlay_w)/2:6[real]`);
  if (slow > 1) {
    graph.push(`[forSlow]setpts=${slow}*PTS[slowed];[slowed][${labelInput(clips.length + 1)}:v]overlay=(main_w-overlay_w)/2:6[slowLabeled]`);
    graph.push('[real][slowLabeled]concat=n=2:v=1[out]');
  } else {
    graph.push('[forSlow]nullsink;[real]null[out]');
  }

  run(S, 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', ...inputs,
    '-filter_complex', graph.join(';'), '-map', '[out]',
    '-r', String(fps), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ]);
} finally {
  rmSync(labelDir, { recursive: true, force: true });
}

const hasAxSteps = clips.some((clip) => clip.axSteps.length);
if (hasAxSteps) {
  const toVideoSeconds = (clip, seconds) => Math.max(0, seconds - clip.trim);
  const axClips = clips.map((clip) => ({
    label: clip.label,
    steps: clip.axSteps.map(({ step, seconds, rows }) => ({
      step,
      seconds: Number(toVideoSeconds(clip, seconds).toFixed(3)),
      ...(slow > 1 ? { slowMotionSeconds: Number((longest + toVideoSeconds(clip, seconds) * slow).toFixed(3)) } : {}),
      rows,
    })),
  }));
  writeFileSync(axOut, `${JSON.stringify({ video: out, clips: axClips }, null, 2)}\n`);
}

const probe = JSON.parse(
  run(S, 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames:format=duration,size', '-of', 'json', out])
);
const { width, height, nb_read_frames: frameCount } = probe.streams[0];
if (!(Number(frameCount) > 0)) fail(S, 'encoded video has no frames');

const sheetEvery = Math.max(1, Math.floor(Number(frameCount) / 24));
run(S, 'ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error', '-i', out,
  '-vf', `select='not(mod(n\\,${sheetEvery}))',scale=${Math.min(width, 600)}:-2,tile=4x6:padding=4:color=black`,
  '-frames:v', '1', '-update', '1', sheetOut,
]);

if (args.gif) {
  const gifWidth = Number(args['gif-width'] ?? Math.min(width, 1000));
  run(S, 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', out,
    '-vf', `fps=30,scale=${gifWidth}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`,
    '-loop', '0', gifOut,
  ]);
}

console.log(
  JSON.stringify(
    {
      video: out,
      gif: args.gif ? gifOut : undefined,
      contactSheet: sheetOut,
      axSteps: hasAxSteps ? axOut : undefined,
      width,
      height,
      durationSeconds: Number(Number(probe.format.duration).toFixed(2)),
      frames: Number(frameCount),
      bytes: Number(probe.format.size),
      trimmedSeconds: Object.fromEntries(clips.map((clip) => [clip.label, Number(clip.trim.toFixed(3))])),
    },
    null,
    2
  )
);
