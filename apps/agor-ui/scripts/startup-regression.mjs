/**
 * Real App/daemon regression, ONLY against an isolated source-served sqlite-demo
 * preview (public seeded demo credentials). Does not start/stop environments.
 *
 * AGOR_STARTUP_DEMO_URL=http://host:port node apps/agor-ui/scripts/startup-regression.mjs --demo
 *
 * Creates two disposable boards and removes them in finally. No tokens, IDs,
 * content, URLs or server errors are retained in the printed receipt.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

assert(process.argv.includes('--demo'), 'Requires explicit --demo acknowledgement');
const base = process.env.AGOR_STARTUP_DEMO_URL;
assert(base, 'Set AGOR_STARTUP_DEMO_URL to your own managed sqlite-demo preview');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on('pageerror', () => pageErrors.push('uncaught page error'));
const createdBoards = [];
const receipts = [];
let releasePendingHealth;
// Observe DOM synchronously when the diagnostic publishes its terminal status,
// not after waitForFunction (which could hide an early-ready bug).
await context.addInitScript(() => {
  let snapshot;
  const visible = (element, clip = document.documentElement) => {
    if (!element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = element.getBoundingClientRect();
    const c = clip.getBoundingClientRect();
    const left = Math.max(0, r.left, c.left);
    const right = Math.min(innerWidth, r.right, c.right);
    const top = Math.max(0, r.top, c.top);
    const bottom = Math.min(innerHeight, r.bottom, c.bottom);
    if (right <= left || bottom <= top) return false;
    return element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
  };
  Object.defineProperty(window, '__AGOR_INITIAL_LOAD_TIMINGS__', {
    configurable: true,
    get: () => snapshot,
    set(value) {
      snapshot = value;
      if (value.status !== 'success') return;
      const pane = document.querySelector('.react-flow');
      const transcript = document.querySelector('[data-testid="conversation-scroll-container"]');
      const nodes = [...document.querySelectorAll('.react-flow__node')];
      window.__startupDomReceipt = {
        home: [...document.querySelectorAll('h1,h2,h3,h4,h5')].some(
          (e) => e.textContent.includes('Hi, Alice') && visible(e)
        ),
        nodeCount: nodes.length,
        board: nodes.some(
          (e) => e.textContent.includes('Off-origin startup fixture') && visible(e, pane)
        ),
        emptyBoard: !!pane && nodes.length === 0 && pane.getBoundingClientRect().width > 0,
        transcript:
          !!transcript &&
          [...transcript.querySelectorAll('[data-task-block]')].some(
            (e) => e.textContent.trim().length > 20 && visible(e, transcript)
          ),
      };
    },
  });
});
async function api(path, method = 'GET', data) {
  return page.evaluate(
    async ({ path, method, data }) => {
      const { getDaemonUrl } = await import('/src/config/daemon.ts');
      const { ACCESS_TOKEN_KEY } = await import('/src/utils/tokenRefresh.ts');
      const response = await fetch(`${getDaemonUrl()}/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem(ACCESS_TOKEN_KEY)}`,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`Fixture API ${method} failed: ${response.status}`);
      return response.json();
    },
    { path, method, data }
  );
}
async function terminal(name, status = 'success', usable) {
  await page.waitForFunction(
    () =>
      window.__AGOR_INITIAL_LOAD_TIMINGS__?.status !== 'pending' &&
      !!window.__AGOR_INITIAL_LOAD_TIMINGS__
  );
  const result = await page.evaluate(() => ({
    timings: window.__AGOR_INITIAL_LOAD_TIMINGS__,
    dom: window.__startupDomReceipt,
  }));
  assert.equal(result.timings.status, status, name);
  if (usable)
    assert.equal(result.dom?.[usable], true, `${name}: usable DOM AT terminal publication`);
  receipts.push({
    name,
    status,
    independentUsability: usable ?? null,
    totalMs: result.timings.totalMs,
  });
  console.log(`PASS ${name}`);
  return result;
}
try {
  await page.goto(`${base}/?debugLoad=0`);
  await page.getByPlaceholder('Email address').fill('demo.alice@agor.live');
  await page.getByPlaceholder('Password', { exact: true }).fill('demo-password-alice');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByText('Hi, Alice Demo!').waitFor();
  await page.goto(`${base}/?debugLoad=1`);
  await terminal('home', 'success', 'home');
  const session = await page.evaluate(async () => {
    const { agorStore } = await import('/src/store/agorStore.ts');
    return [...agorStore.getState().sessionById.values()].find(
      (s) => !s.archived && s.branch_board_id
    )?.session_id;
  });
  assert(session, 'Seeded demo must contain a session with a nonempty transcript');
  for (const empty of [false, true]) {
    const board = await api('boards', 'POST', {
      name: `Startup regression ${empty ? 'empty' : 'off-origin'}`,
      objects: empty
        ? {}
        : {
            note: {
              type: 'markdown',
              x: 12000,
              y: -9000,
              width: 400,
              content: 'Off-origin startup fixture',
            },
          },
    });
    createdBoards.push(board.board_id);
    await page.goto(`${base}/b/${board.slug}/?debugLoad=1`);
    const result = await terminal(
      empty ? 'empty-board' : 'off-origin-board',
      'success',
      empty ? 'emptyBoard' : 'board'
    );
    if (!empty) {
      const at = (stage) => result.timings.stageTransitions.find((s) => s.stage === stage).atMs;
      assert(at('board-initial-position-settled') - at('board-initial-position-start') >= 200);
      assert.equal(result.dom.nodeCount, 1);
    }
  }
  await page.goto(`${base}/s/${session}/?debugLoad=1`);
  await terminal('direct-session', 'success', 'transcript');
  await page.goto(`${base}/?debugLoad=0`);
  await page.getByText('Hi, Alice Demo!').waitFor();
  assert.equal(await page.evaluate(() => window.__AGOR_INITIAL_LOAD_TIMINGS__), undefined);
  receipts.push({ name: 'debug-off', status: 'no snapshot' });

  // Current App already gates mounting on authConfigLoading. Hold health
  // while data finishes; the independent surface-before-health ordering is
  // exercised with the production observers in App.initialLoad.browser.test.
  for (const status of [200, 503]) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
      releasePendingHealth = resolve;
    });
    const hold = async (route) => {
      if (route.request().headers().authorization) return route.continue();
      await gate;
      return status === 200
        ? route.continue()
        : route.fulfill({ status, contentType: 'application/json', body: '{}' });
    };
    await page.route('**/health', hold);
    await page.goto(`${base}/?debugLoad=1`);
    await page.waitForFunction(() =>
      window.__AGOR_INITIAL_LOAD_TIMINGS__?.stageTransitions.some((s) => s.stage === 'data-ready')
    );
    assert.equal(await page.evaluate(() => window.__AGOR_INITIAL_LOAD_TIMINGS__.status), 'pending');
    assert.equal(await page.getByText('Hi, Alice Demo!').count(), 0);
    release();
    await terminal(
      `held-health-${status}`,
      status === 200 ? 'success' : 'error',
      status === 200 ? 'home' : undefined
    );
    await page.unrouteAll({ behavior: 'wait' });
  }
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    releasePendingHealth = resolve;
  });
  await page.route('**/health', async (route) => {
    if (route.request().headers().authorization) return route.continue();
    await gate;
    return route.continue();
  });
  await page.goto(`${base}/?debugLoad=1`);
  await page.waitForFunction(() =>
    window.__AGOR_INITIAL_LOAD_TIMINGS__?.stageTransitions.some((s) => s.stage === 'data-ready')
  );
  await page.evaluate(() => {
    history.pushState({}, '', '/settings/');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  const discarded = await terminal('route-change', 'discarded');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  assert.deepEqual(
    await page.evaluate(() => window.__AGOR_INITIAL_LOAD_TIMINGS__),
    discarded.timings
  );
  for (const path of ['/settings/', '/a/absent/', '/m/board/absent/', '/m/session/absent/']) {
    await page.goto(`${base}${path}?debugLoad=1`);
    await terminal(
      `unsupported-${path.split('/')[1]}-${path.split('/')[2] || 'root'}`,
      'unsupported'
    );
  }
  await page.goto(`${base}/s/00000000-0000-7000-8000-000000000000/?debugLoad=1`);
  await terminal('missing-session', 'error');
  assert(
    page.url().includes('/s/00000000-0000-7000-8000-000000000000/'),
    'Missing URL remains sticky'
  );
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ receipts, pageErrors: pageErrors.length }, null, 2));
} finally {
  releasePendingHealth?.();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  try {
    for (const id of createdBoards) await api(`boards/${id}`, 'DELETE');
  } finally {
    await context.close();
    await browser.close();
  }
}
