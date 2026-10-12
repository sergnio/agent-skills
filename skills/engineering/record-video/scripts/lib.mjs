import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

/** Prints an error prefixed with the script name and exits non-zero. */
export function fail(script, message) {
  console.error(`${script}: ${message}`);
  process.exit(1);
}

/**
 * Loads Playwright from `--playwright DIR`, $PLAYWRIGHT_FROM, or the current
 * directory's node_modules, so the skill reuses the project's own install.
 */
export function loadPlaywright(script, fromDir) {
  const base = resolve(fromDir ?? process.env.PLAYWRIGHT_FROM ?? process.cwd());
  const require = createRequire(join(base, 'noop.js'));
  for (const name of ['playwright', '@playwright/test']) {
    try {
      return require(name);
    } catch {
      // try the next package name
    }
  }
  fail(
    script,
    `Playwright not found from ${base}. Run from a project that has it installed, ` +
      'pass --playwright <project dir>, or `npm i playwright && npx playwright install chromium` in a scratch dir.'
  );
}

/** Parses `--key value` pairs; repeatable keys collect into arrays and bare flags become true. */
export function parseArgs(script, argv, { repeatable = [], flags = [] } = {}) {
  const args = Object.fromEntries(repeatable.map((key) => [key, []]));
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(script, `unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'help' || flags.includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(script, `${arg} requires a value`);
    if (repeatable.includes(key)) args[key].push(value);
    else args[key] = value;
  }
  return args;
}

/** Runs a command synchronously and exits with its stderr on failure. */
export function run(script, command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.error) fail(script, `${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(script, `${command} failed:\n${result.stderr.trim()}`);
  return result.stdout;
}
