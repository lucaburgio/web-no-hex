/**
 * E2E: start a new vs-AI game (territory map by default), end production, click a player unit
 * chip, assert the movement unit card shows (selection worked).
 * Run with Vite: `npx vite --port 5173 --host 127.0.0.1` then
 *   `node scripts/board-unit-select-e2e.mjs` (E2E_BASE defaults to 5173).
 * For a clean bundle, use `E2E_BASE` after `vite build` + `vite preview --port 4173`.
 * If dev HMR ever looks out of date, restart dev or use preview for this script.
 */
import { chromium } from 'playwright';

const base = process.env['E2E_BASE'] ?? 'http://127.0.0.1:5173/';

const browser = await chromium.launch();
const page = await browser.newPage();
if (process.env['E2E_DEBUG']) {
  page.on('console', (m) => console.log('[browser]', m.type(), m.text()));
}
await page.setViewportSize({ width: 1280, height: 800 });
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#menu-new-game-btn', { timeout: 15_000 });
  await page.click('#menu-new-game-btn');
  const confirm = page.locator('#new-game-confirm-overlay:not(.hidden)');
  if (await confirm.isVisible().catch(() => false)) {
    await page.click('#confirm-new-game-btn');
  }
  await page.waitForSelector('#settings-overlay:not(.hidden)', { timeout: 10_000 });
  await page.click('#settings-start-btn');
  await page.waitForSelector('#settings-overlay', { state: 'hidden', timeout: 15_000 });

  await page.waitForSelector('#end-move-btn', { state: 'visible', timeout: 10_000 });
  await page.click('#end-move-btn');
  // Wait until it is the human's movement turn (not AI planning / isAnimating), or board clicks are ignored.
  await page.waitForFunction(
    () => {
      const pl = (document.getElementById('phase-label')?.textContent ?? '').trim();
      const end = document.getElementById('end-move-btn');
      const d = end ? getComputedStyle(end).display : 'none';
      return pl === 'MOVEMENT' && d !== 'none';
    },
    { timeout: 25_000 },
  );

  // Territory: virtual row 2 = player home. Click the g.board-unit (faction image is above the
  // path and can intercept a body-only click in Playwright).
  const unitChip = page.locator('#trr-units g.board-un' + 'it[data-row="2"], #unit-layer g.board-un' + 'it').first();
  await unitChip.waitFor({ state: 'visible', timeout: 10_000 });
  // Center click on the chip (covers body + icon without relying on a single path)
  const box = await unitChip.boundingBox();
  if (box) {
    const px = box.x + box.width * 0.5;
    const py = box.y + box.height * 0.45;
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const g = el.closest?.('g.board-un' + 'it') ?? null;
        return {
          n: el.nodeName,
          c: el.getAttribute('class') ?? '',
          dcol: g?.getAttribute('data-col') ?? '',
          drow: g?.getAttribute('data-row') ?? '',
        };
      },
      [px, py],
    );
    if (process.env['E2E_DEBUG']) console.log('elementFromPoint', hit, { px, py });
    await page.mouse.click(px, py);
  } else {
    await unitChip.click({ timeout: 15_000 });
  }
  if (process.env['E2E_DEBUG']) {
    const dbg = await page.evaluate(() => {
      const st = document.getElementById('movement-hud-stack');
      const li = document.querySelectorAll('#log li');
      const logTail = Array.from(li)
        .slice(-4)
        .map((l) => l.textContent)
        .join(' | ');
      return {
        stack: st?.className ?? '',
        ph: document.getElementById('phase')?.textContent ?? '',
        pl: document.getElementById('phase-label')?.textContent ?? '',
        logTail,
      };
    });
    console.log('after click', dbg);
  }
  await page.waitForSelector('#movement-hud-stack.movement-hud-stack--visible', { timeout: 12_000 });
  const hasTitle = await page
    .locator('#movement-unit-card')
    .innerText()
    .then(
      (t) => t.trim().length > 0,
      () => false,
    );
  if (!hasTitle) throw new Error('movement card has no text after click — selection may have failed');

  console.log('ok: board unit select e2e passed');
} catch (e) {
  const shot = 'board-unit-select-e2e-fail.png';
  await page.screenshot({ path: shot, fullPage: true });
  console.error('fail:', e);
  console.error('screenshot:', shot);
  process.exitCode = 1;
} finally {
  await browser.close();
}
