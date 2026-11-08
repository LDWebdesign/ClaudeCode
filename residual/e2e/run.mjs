/**
 * End-to-end checks in Chromium with fake camera/microphone.
 *   node e2e/make-media.py   (once, renders test scenes + speech)
 *   npm run build && npx vite preview --port 4173 &
 *   node e2e/run.mjs [room|hallway]
 * Writes screenshots and extracted recordings to e2e/out/.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = new URL('./out/', import.meta.url).pathname;
const MEDIA = new URL('./media/', import.meta.url).pathname;
const URL_ = 'http://localhost:4173/?debug';
const scene = process.argv[2] ?? 'room';
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);
};

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${MEDIA}${scene}.y4m`,
    `--use-file-for-fake-audio-capture=${MEDIA}speech.wav`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function phone() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.grantPermissions(['microphone', 'camera'], { origin: 'http://localhost:4173' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  return { ctx, page, errors };
}

const { page, errors } = await phone();
await page.goto(URL_);
await page.fill('#loc', 'E2E — ' + scene);
await page.click('button[type=submit]');
await page.waitForTimeout(2500);

// --- spirit box: responses actually play and get logged ------------------------------------
await page.evaluate(() => {
  const r = window.residual;
  r.config.update((c) => {
    c.spiritBox.response.silenceChance = 0;
    c.spiritBox.response.delays = [{ weight: 1, range: [1, 2] }, { weight: 0, range: [5, 8] }, { weight: 0, range: [10, 16] }, { weight: 0, range: [18, 40] }];
    c.spiritBox.response.minGapSec = 1;
    c.spiritBox.response.audioEventChance = 0;
    c.spiritBox.forms = { word: 1, partial: 0, syllable: 0, pseudo: 0, unintelligible: 0 };
    c.spiritBox.audio.clarity = 0.9;
    c.spiritBox.log.unloggedLowClarityChance = 0;
  });
});
await page.click('button.rec');
let voxSeen = false;
for (const q of ['Is anyone here?', 'Did you die in this house?', 'What is your name?', 'Do you want us to leave?']) {
  await page.evaluate((text) => window.residual.spiritBox.ask(text), q);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    voxSeen ||= await page.evaluate(() => document.querySelector('.lamp')?.classList.contains('on'));
  }
}
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}10-spiritbox-active.png` });
await page.click('button.rec');
await page.waitForTimeout(1500);
const sb = await page.evaluate(() => window.residual.session.events.map((e) => ({ type: e.type, title: e.title, text: e.text, alt: e.alternates, detail: e.detail, hidden: e.hidden })));
const frags = sb.filter((e) => e.type === 'fragment' || e.type === 'audio-event');
check('typed questions are logged', sb.filter((e) => e.type === 'question').length >= 4);
check('fragments play and are logged', frags.length >= 3, frags.map((f) => `${f.title}: ${f.text ?? '—'}`).join(' | '));
check('VOX lamp reacts to vocal output', voxSeen);
const clipEv = sb.find((e) => e.type === 'clip');
check('audio recording saved', !!clipEv, clipEv?.detail);

// pull the recorded audio out of IndexedDB for inspection
const audio = await page.evaluate(async () => {
  const r = window.residual;
  const clips = await r.store.bySession('clips', r.session.id);
  const c = clips.find((x) => x.kind === 'audio');
  if (!c) return null;
  const buf = new Uint8Array(await c.blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: c.mime, b64: btoa(s) };
});
if (audio) writeFileSync(`${OUT}spiritbox-recording.${audio.mime.includes('mp4') ? 'm4a' : 'webm'}`, Buffer.from(audio.b64, 'base64'));

// restore defaults for realistic behaviour
await page.evaluate(() => window.residual.config.reset());

// --- camera --------------------------------------------------------------------------------
await page.click('button[data-mode=camera]');
await page.waitForTimeout(4500);
check('camera goes live', (await page.evaluate(() => window.residual.camera.state)) === 'live');
await page.screenshot({ path: `${OUT}20-camera.png` });
const sites = await page.evaluate(() => window.residual.camera.sites.map((s) => ({ kind: s.kind, x: +s.box.x.toFixed(2), y: +s.box.y.toFixed(2), w: +s.box.w.toFixed(2), h: +s.box.h.toFixed(2), p: s.persistence, open: s.occluder?.open })));
console.log('sites:', JSON.stringify(sites));
check('camera finds believable locations', sites.length > 0, sites.map((s) => s.kind).join(','));

await page.evaluate(() => window.residual.config.update((c) => (c.diagnostics = true)));
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}21-camera-diagnostics.png` });
await page.evaluate(() => window.residual.config.update((c) => (c.diagnostics = false)));

// force each anomaly type and photograph it mid-appearance
await page.click('button.rec');
const types = await page.evaluate(() => ['densify', 'pool', 'crown', 'shoulder', 'brim', 'rise', 'hall-figure', 'stair-figure', 'window-shape', 'partial-figure', 'lean']);
for (const t of types) {
  const a = await page.evaluate((type) => {
    const r = window.residual;
    r.camera.anomalies.abort();
    if (!r.camera.force(type)) return null;
    const a = r.camera.anomalies.active;
    // hold it long enough to photograph
    const now = r.session.clock();
    a.t1 = now + 3;
    a.fade = Math.min(a.fade, 0.2);
    return { type: a.def.type, site: a.site.kind, density: a.density };
  }, t);
  if (!a) {
    console.log(`  (no compatible site for ${t} in this scene)`);
    continue;
  }
  await page.waitForTimeout(t === 'densify' ? 1200 : 700);
  await page.screenshot({ path: `${OUT}3x-anomaly-${t}.png` });
  await page.waitForTimeout(200);
  console.log(`  forced ${a.type} at ${a.site} (density ${a.density.toFixed(2)})`);
}
await page.evaluate(() => window.residual.camera.anomalies.abort());

// natural behaviour for a while: count what happens with default settings
const natural = await page.evaluate(async () => {
  const r = window.residual;
  r.camera.anomalies.reset(r.session.clock());
  const seen = [];
  const off = r.camera.anomalies.on('start', (a) => seen.push(a.def.type));
  const scans = [];
  const off2 = r.camera.anomalies.on('scan', (s) => scans.push(s.result));
  await new Promise((res) => setTimeout(res, 40000));
  off();
  off2();
  return { seen, scans };
});
check('natural scanning is mostly empty', natural.scans.filter((s) => s === 'anomaly').length <= 2, `scans: ${natural.scans.join(',')} · anomalies: ${natural.seen.join(',') || 'none'}`);

await page.click('button.rec');
await page.waitForTimeout(1500);
const vclip = await page.evaluate(async () => (await window.residual.store.bySession('clips', window.residual.session.id)).find((c) => c.kind === 'video'));
check('video recording saved', !!vclip, vclip ? `${vclip.mime} ${(vclip.size / 1e6).toFixed(2)} MB` : '');

// capture still
await page.click('button.shutter');
await page.waitForTimeout(800);
check('still capture logged', await page.evaluate(() => window.residual.session.events.some((e) => e.type === 'capture' && e.mediaId)));

// log drawer
await page.click('.log-head');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}40-log.png` });
await page.click('.log-head');

// end session -> review
await page.click('button[aria-label="End session"]');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}50-review.png`, fullPage: false });
check('review opens with recordings', await page.evaluate(() => document.querySelectorAll('.clips li').length >= 2));

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

// --- permission denied path ----------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await p.goto(URL_);
  await p.fill('#loc', 'Denied');
  await p.click('button[type=submit]');
  await p.waitForTimeout(1500);
  const micText = await p.textContent('.mic .state');
  check('mic denial is explained', /blocked/i.test(micText ?? ''), micText ?? '');
  check('spirit box still scans without a mic', await p.evaluate(() => window.residual.spiritBox.scanning));
  await p.click('button[data-mode=camera]');
  await p.waitForTimeout(1000);
  const camText = await p.textContent('.cam-msg');
  check('camera denial is explained', /refused/i.test(camText ?? ''), camText ?? '');
  await p.screenshot({ path: `${OUT}60-denied.png` });
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
