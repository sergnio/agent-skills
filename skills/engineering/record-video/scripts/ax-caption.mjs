const sessions = new WeakMap();
const STATES = ['required', 'invalid', 'expanded', 'checked', 'selected', 'disabled', 'modal', 'hasPopup'];
const SHOWN_ONLY_WHEN_SET = ['invalid', 'disabled', 'modal'];
const DEFAULT_HOLD_MS = 1500;
const STEP_LOG = Symbol.for('record-video.axStepLog');

/** Lets record.mjs collect captions for ax-steps.json. A global symbol survives a second copy of this module. */
export function startAxStepLog(page) {
  page[STEP_LOG] = { recording: false, steps: [] };
  return page[STEP_LOG];
}

/** Returns one CDP session per page, created on first use. */
async function cdpFor(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}

/**
 * Reads what a screen reader gets for an element from Chrome's accessibility tree.
 * `target` is a Playwright locator, or a JS expression string that returns an element.
 */
export async function readAx(page, target) {
  const cdp = await cdpFor(page);
  let expression = target;
  if (typeof target !== 'string') {
    if (!(await target.count())) return null;
    await target.evaluate((el) => el.setAttribute('data-ax-probe', ''));
    expression = `document.querySelector('[data-ax-probe]')`;
  }
  const { result } = await cdp.send('Runtime.evaluate', { expression });
  if (typeof target !== 'string') await target.evaluate((el) => el.removeAttribute('data-ax-probe'));
  if (!result.objectId) return null;
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
    objectId: result.objectId,
    fetchRelatives: false,
  });
  const node = nodes.find((n) => !n.ignored) ?? nodes[0];
  const props = Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value.value]));
  return {
    role: node.role?.value,
    name: node.name?.value ?? '',
    description: node.description?.value || undefined,
    value: node.value?.value || undefined,
    states: Object.fromEntries(
      STATES.filter((s) => s in props)
        .filter((s) => !SHOWN_ONLY_WHEN_SET.includes(s) || ![false, 'false'].includes(props[s]))
        .map((s) => [s, props[s]])
    ),
  };
}

/** Shortens long names and descriptions so a caption stays readable. */
function truncate(text, max = 140) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Formats an AX node like a screen reader line: role "name", then states. */
export function describeAx(ax) {
  if (!ax) return '(not in the accessibility tree)';
  const parts = [`${ax.role}: ${ax.name ? `"${truncate(ax.name)}"` : '(no name)'}`];
  if (ax.value) parts.push(`value "${ax.value}"`);
  if (ax.description) parts.push(`description "${truncate(ax.description)}"`);
  for (const [state, value] of Object.entries(ax.states)) parts.push(`${state}=${value}`);
  return parts.join(', ');
}

/**
 * Overlays a caption bar of real accessibility-tree data, by default for the focused element and its dialog.
 * During run() it then waits `holdMs` so the caption can be read; prepare() is off camera, so it doesn't wait.
 */
export async function axCaption(page, step, targets, { holdMs = DEFAULT_HOLD_MS } = {}) {
  const rows = targets ?? [
    { label: 'Focused', target: 'document.activeElement' },
    { label: 'In dialog', target: `document.activeElement?.closest('[role=dialog],[role=alertdialog],dialog') ?? null` },
  ];
  const lines = [];
  const shownRows = [];
  for (const { label, target } of rows) {
    const ax = await readAx(page, target);
    if (ax || !label.startsWith('In ')) {
      lines.push(`${label} ${describeAx(ax)}`);
      shownRows.push({ label, inAccessibilityTree: Boolean(ax), ...ax });
    }
  }
  await page.evaluate(
    ({ step, lines }) => {
      let bar = document.getElementById('__ax_caption');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = '__ax_caption';
        bar.setAttribute('aria-hidden', 'true');
        bar.style.cssText =
          'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;pointer-events:none;' +
          'background:rgba(0,0,0,.85);color:#fff;font:600 13px/1.35 -apple-system,system-ui,sans-serif;' +
          'padding:8px 10px;border-radius:8px;word-break:break-word';
        document.body.append(bar);
      }
      const heading = document.createElement('div');
      heading.textContent = step;
      heading.style.cssText = 'color:#9cf;font-size:11px;margin-bottom:2px';
      bar.replaceChildren(heading, ...lines.map((text) => Object.assign(document.createElement('div'), { textContent: text })));
    },
    { step, lines }
  );
  console.error(`[${step}] ${lines.join(' | ')}`);
  const log = page[STEP_LOG];
  log?.steps.push({ step, shownAt: Date.now() / 1000, rows: shownRows });
  if (log?.recording && holdMs > 0) await page.waitForTimeout(holdMs);
  return lines;
}
