// Records the narration with ElevenLabs. Opens the viewer in a headless browser at desktop and
// phone sizes, reads every caption of Acts I to V with the bundled trace's numbers, and saves one
// mp3 per line in web/public/audio with a manifest the viewer reads. Lines already recorded are
// kept, so rerunning after a caption change only pays for the new lines.
//
// Usage:
//   node tools/narrate.mjs --dry-run              list the lines and their keys
//   ELEVENLABS_API_KEY=... node tools/narrate.mjs
// Optional: ELEVENLABS_VOICE_ID (default Brian, a deep narration voice), ELEVENLABS_MODEL.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const outDir = path.join(web, 'public', 'audio');
const dryRun = process.argv.includes('--dry-run');
const key = process.env.ELEVENLABS_API_KEY;
const voice = process.env.ELEVENLABS_VOICE_ID || 'nPczCjzI2devNBz1zQrb';
const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

if (!dryRun && !key) {
  console.error('Set ELEVENLABS_API_KEY, or pass --dry-run to list the lines.');
  process.exit(1);
}

const { speakable, lineKey } = await import(pathToFileURL(path.join(web, 'src', 'speech.js')));
const { createServer } = await import(pathToFileURL(createRequire(path.join(web, 'package.json')).resolve('vite')));

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch {
    return req(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}

async function collectCaptions() {
  const server = await createServer({ root: web, configFile: path.join(web, 'vite.config.js'), server: { port: 4179, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const captions = new Set();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      await page.goto('http://localhost:4179/');
      await page.waitForFunction(() => window.director);
      const found = await page.evaluate(() => {
        const d = window.director;
        const out = [];
        for (let k = 0; k < 5; k++) {
          const ids = d.acts[k].script.beats.map((b) => b.id);
          for (const id of ids) {
            d.switchTo(k);
            d.act.script.skipTo(id);
            d.act.update(1 / 60, 1 / 60);
            if (d.act.caption) out.push(d.act.caption);
          }
        }
        return out;
      });
      found.forEach((c) => captions.add(c));
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return [...captions];
}

async function record(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true, speed: 0.95 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const ends = body.alignment?.character_end_times_seconds || [];
  return { audio: Buffer.from(body.audio_base64, 'base64'), seconds: ends.length ? ends[ends.length - 1] : text.length / 14 };
}

const lines = new Map();
for (const c of await collectCaptions()) {
  const text = speakable(c);
  if (text) lines.set(lineKey(text), text);
}

if (dryRun) {
  for (const [k, text] of lines) console.log(`${k}  ${text}\n`);
  const chars = [...lines.values()].reduce((n, t) => n + t.length, 0);
  console.log(`${lines.size} lines, ${chars.toLocaleString()} characters`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(outDir, 'manifest.json');
const old = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).lines || {} : {};
const manifest = { voice, model, lines: {} };

for (const [k, text] of lines) {
  const file = `${k}.mp3`;
  if (old[k] && fs.existsSync(path.join(outDir, file))) {
    manifest.lines[k] = old[k];
    continue;
  }
  process.stdout.write(`recording ${k} (${text.length} chars)... `);
  const { audio, seconds } = await record(text);
  fs.writeFileSync(path.join(outDir, file), audio);
  manifest.lines[k] = { file, seconds: Math.round(seconds * 100) / 100, text };
  console.log(`${seconds.toFixed(1)} s`);
}

for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.mp3') && !manifest.lines[f.slice(0, -4)]) fs.unlinkSync(path.join(outDir, f));
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`${Object.keys(manifest.lines).length} lines in web/public/audio. Rebuild the site to include them.`);
