#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    steps: { type: 'string' },
    out: { type: 'string' },
    match: { type: 'string', multiple: true, default: [] },
    'settle-ms': { type: 'string', default: '5000' },
    headed: { type: 'boolean', default: false },
    playwright: { type: 'string' },
  },
});

if (!args.url || !args.steps || !args.out) {
  console.error(
    'usage: capture.mjs --url <url> --steps <steps.mjs> --out <dir> [--match <regex>]... [--settle-ms 5000] [--headed] [--playwright <dir>]'
  );
  process.exit(2);
}

/** Loads Playwright from --playwright <dir>, $PLAYWRIGHT_FROM, or the current directory's node_modules. */
const loadChromium = (fromDir) => {
  const base = resolve(fromDir ?? process.env.PLAYWRIGHT_FROM ?? process.cwd());
  const require = createRequire(join(base, 'noop.js'));
  for (const name of ['playwright', '@playwright/test']) {
    try {
      return require(name).chromium;
    } catch {
      // try the next package name
    }
  }
  console.error(
    `Playwright not found from ${base}. Run from a project that has it installed, ` +
      'pass --playwright <project dir>, or `npm i playwright && npx playwright install chromium` in a scratch dir.'
  );
  process.exit(2);
};

const chromium = loadChromium(args.playwright);
const outDir = resolve(args.out);
const matchers = args.match.map((pattern) => new RegExp(pattern));
const events = [];
let markCount = 0;

/** Records one timeline event with a wall-clock timestamp. */
const record = (kind, text, extra = {}) =>
  events.push({ time: new Date().toISOString(), kind, text, ...extra });

/** Returns true when a request URL matches any --match pattern. */
const isMatched = (url) => matchers.some((matcher) => matcher.test(url));

/** Splits a request into its decoded parameter sets: the URL query plus one per POST body line. */
const decodeParams = (request) => {
  const url = new URL(request.url());
  const sets = [Object.fromEntries(url.searchParams)];
  const body = request.postData() ?? '';
  for (const line of body.split('\n').filter((part) => part.includes('='))) {
    sets.push(Object.fromEntries(new URLSearchParams(line)));
  }
  return sets;
};

/** Serializes a console message's arguments so objects keep their contents. */
const serializeConsole = async (message) => {
  const parts = await Promise.all(
    message.args().map((arg) => arg.jsonValue().catch(() => arg.toString()))
  );
  const text = parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')
    .trim();
  return text && text !== '{}' ? text : message.text();
};

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: !args.headed });
const context = await browser.newContext({
  recordHar: { path: join(outDir, 'network.har'), content: 'omit' },
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

page.on('console', async (message) => {
  const time = new Date().toISOString();
  const text = await serializeConsole(message);
  events.push({ time, kind: `console.${message.type()}`, text });
});
page.on('pageerror', (error) => record('pageerror', error.message));
context.on('request', (request) => {
  if (!isMatched(request.url())) return;
  record('request', `${request.method()} ${request.url().split('?')[0]}`, {
    params: decodeParams(request),
  });
});
context.on('requestfinished', async (request) => {
  if (!isMatched(request.url())) return;
  const response = await request.response();
  record('response', `${response?.status() ?? 'no response'} ${request.url().split('?')[0]}`);
});
context.on('requestfailed', (request) => {
  if (!isMatched(request.url())) return;
  record('requestfailed', `${request.failure()?.errorText} ${request.url().split('?')[0]}`);
});

/** Adds a marker line to the timeline and screenshots the page at that moment. */
const mark = async (label) => {
  markCount += 1;
  const file = `${String(markCount).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  record('mark', `>>> ${label}`, { screenshot: file });
  await page.screenshot({ path: join(outDir, file) });
};

let failure;
try {
  await page.goto(args.url, { waitUntil: 'load' });
  const { default: steps } = await import(pathToFileURL(resolve(args.steps)).href);
  await steps({ page, mark, context });
  await page.waitForTimeout(Number(args['settle-ms']));
} catch (error) {
  failure = error;
  record('capture-error', (error.stack ?? String(error)).replace(/\x1b\[[0-9;]*m/g, ''));
}
await context.close();
await browser.close();

events.sort((a, b) => a.time.localeCompare(b.time));
const timeline = events.map(({ time, kind, text, params }) => {
  const head = `${time.slice(11, 23)}  ${kind.padEnd(14)} ${text}`;
  if (!params) return head;
  const lines = params
    .filter((set) => Object.keys(set).length)
    .map((set) => `${' '.repeat(29)}${new URLSearchParams(set).toString()}`);
  return [head, ...lines].join('\n');
});
await writeFile(join(outDir, 'timeline.txt'), `${timeline.join('\n')}\n`);
await writeFile(join(outDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

const counts = events.reduce((acc, { kind }) => ({ ...acc, [kind]: (acc[kind] ?? 0) + 1 }), {});
console.log(JSON.stringify({ outDir, counts, failed: Boolean(failure) }, null, 2));
process.exit(failure ? 1 : 0);
