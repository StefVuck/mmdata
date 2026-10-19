// Renders short GIFs of each act for the README. Needs `npx vite preview` on port 4173,
// Playwright, and Python with Pillow. Usage: node tools/capture_gifs.cjs docs/media
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');

const CLIPS = [
  { name: 'act1-exchange', query: 'act=1&beat=engine&advance=2.2', frames: 44, dt: 1 / 9 },
  { name: 'act2-fibre', query: 'act=2&beat=coil&advance=0.8', frames: 40, dt: 1 / 9 },
  { name: 'act3-switch', query: 'act=3&beat=cross', frames: 40, dt: 1 / 7.5 },
  { name: 'act4-nic', query: 'act=4&beat=unpack&advance=0.5', frames: 44, dt: 1 / 3.6 },
  { name: 'act5-core', query: 'act=5&beat=tuned&advance=4', frames: 44, dt: 1 / 7, hud: true },
  { name: 'act5-beam', query: 'act=5&beat=verdict&advance=9', frames: 44, dt: 1 / 12,
    setup: (d) => { const a = d.act; a.freeDilation = 3e3; a.t = 0.05 * d.timeline.duration; a.setCamera('memory'); for (let k = 0; k < 150; k++) d.frame(1 / 30); } },
];

(async () => {
  const out = path.resolve(process.argv[2] || 'docs/media');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  for (const clip of CLIPS) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), clip.name));
    await page.goto(`http://localhost:4173/?${clip.query}${clip.hud ? '' : '&hud=0'}`);
    await page.waitForTimeout(1200);
    await page.evaluate((setup) => {
      const d = window.director;
      d.renderer.setAnimationLoop(null);
      if (setup) (0, eval)(`(${setup})`)(d);
      document.getElementById('controls').hidden = true;
      document.getElementById('inspector').hidden = true;
      for (let k = 0; k < 20; k++) d.frame(1 / 30);
    }, clip.setup ? clip.setup.toString() : null);
    for (let f = 0; f < clip.frames; f++) {
      await page.evaluate((dt) => window.director.frame(dt), clip.dt);
      await page.screenshot({ path: path.join(dir, `${String(f).padStart(3, '0')}.png`) });
    }
    execFileSync('python3', ['-I', '-c', `
import sys, glob
from PIL import Image
files = sorted(glob.glob(sys.argv[1] + '/*.png'))
frames = [Image.open(f).convert('RGB').resize((640, 360), Image.LANCZOS) for f in files]
picks = frames[::max(1, len(frames) // 6)][:6]
sheet = Image.new('RGB', (640, 360 * len(picks)))
for i, f in enumerate(picks):
    sheet.paste(f, (0, 360 * i))
pal = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
q[0].save(sys.argv[2], save_all=True, append_images=q[1:], duration=90, loop=0, optimize=True)
`, dir, path.join(out, `${clip.name}.gif`)]);
    console.log('wrote', clip.name);
  }
  await browser.close();
})();
