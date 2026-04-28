import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:5173/?perf=1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickIfVisible(page, selector) {
  const el = page.locator(selector);
  if (await el.count()) {
    const visible = await el.first().isVisible().catch(() => false);
    if (visible) {
      await el.first().click();
      return true;
    }
  }
  return false;
}

async function startNewGameAtSize(page, _cols, _rows) {
  await page.click('#menu-new-game-btn');
  await clickIfVisible(page, '#confirm-new-game-btn');
  await page.waitForSelector('#settings-overlay:not(.hidden)', { timeout: 10000 });
  await page.click('#settings-start-btn');
  await page.waitForSelector('#board', { timeout: 10000 });
  await sleep(400);
}

async function runScenario(page, cols, rows) {
  await startNewGameAtSize(page, cols, rows);
  const turnBeforeAi = await page.locator('#turn').textContent();
  await page.click('#end-move-btn');
  await sleep(1200);
  await page.click('#end-move-btn');
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector('#turn');
      return !!el && el.textContent !== prev;
    },
    turnBeforeAi,
    { timeout: 30000 },
  );
  await sleep(400);
}

function filterPerfLogs(allLogs) {
  return allLogs.filter((l) => l.includes('[perf]'));
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => {
    logs.push(msg.text());
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-new-game-btn', { timeout: 10000 });

  const start24 = logs.length;
  await runScenario(page, 24, 24);
  const logs24 = filterPerfLogs(logs.slice(start24));

  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-overlay:not(.hidden)', { timeout: 5000 });
  await page.click('#pause-return-btn');
  await page.waitForSelector('#main-menu-overlay:not(.hidden)', { timeout: 10000 });

  const start48 = logs.length;
  await runScenario(page, 48, 48);
  const logs48 = filterPerfLogs(logs.slice(start48));

  console.log('--- PERF LOGS 24x24 ---');
  for (const l of logs24) console.log(l);
  console.log('--- PERF LOGS 48x48 ---');
  for (const l of logs48) console.log(l);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
