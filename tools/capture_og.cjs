// Renders the link-preview image (web/public/og.png, 1200x630) from the live title screen, and
// the Apple touch icon from the favicon. Needs `npx vite preview` on port 4173 and Playwright.
// Usage: node tools/capture_og.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');

const pub = path.join(__dirname, '..', 'web', 'public');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto('http://localhost:4173/');
  await page.waitForTimeout(4000);
  // A preview card is small and has no buttons: keep the title, a short line and the book.
  await page.addStyleTag({ content: `
    .title-cards, .title-buttons, #title-meta, .keys, .disclaimer { display: none !important; }
    #title { place-items: center start !important; }
    .title-inner { margin-left: 80px; max-width: 640px; padding: 0 !important; }
    #title h1 { font-size: 92px !important; margin: 18px 0 22px !important; }
    .lede { font-size: 24px !important; line-height: 1.45 !important; color: #d4e0f2 !important; }
    .og-route { margin-top: 28px; font: 15px ui-monospace, Menlo, monospace; letter-spacing: 0.04em; color: #3fd8ff; }
    .og-route span { color: #5d6b85; margin: 0 8px; }
  ` });
  await page.evaluate(() => {
    document.querySelector('.lede').textContent =
      'Follow one market data packet from the exchange to an order, slowed down until a single cache miss takes seconds.';
    const route = document.createElement('div');
    route.className = 'og-route';
    route.innerHTML = ['exchange', 'fibre', 'switch', 'network card', 'CPU', 'order'].join('<span>→</span>');
    document.querySelector('.title-inner').append(route);
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(pub, 'og.png') });

  const icon = await browser.newPage({ viewport: { width: 180, height: 180 } });
  const svg = fs.readFileSync(path.join(pub, 'favicon.svg'), 'utf8');
  await icon.setContent(`<html><body style="margin:0;background:#03050a">${svg.replace('<svg ', '<svg width="180" height="180" ')}</body></html>`);
  await icon.screenshot({ path: path.join(pub, 'apple-touch-icon.png') });

  await browser.close();
  console.log('wrote web/public/og.png and web/public/apple-touch-icon.png');
})();
