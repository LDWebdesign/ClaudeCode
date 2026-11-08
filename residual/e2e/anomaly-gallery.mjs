/** Forces each anomaly type and saves before/after crops around it: e2e/out/gallery-<scene>.png */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = new URL('./out/', import.meta.url).pathname;
const MEDIA = new URL('./media/', import.meta.url).pathname;
const scene = process.argv[2] ?? 'room';
const vw = Number(process.argv[3] ?? 390), vh = Number(process.argv[4] ?? 844);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${MEDIA}${scene}.y4m`, `--use-file-for-fake-audio-capture=${MEDIA}speech.wav`] });
const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
await page.goto('http://localhost:4173/?debug');
await page.fill('#loc', 'gallery');
await page.click('button[type=submit]');
await page.waitForTimeout(800);
await page.evaluate(() => window.residual.spiritBox.setScanning(false));
await page.click('button[data-mode=camera]');
await page.waitForTimeout(4000);
const shots = [];
for (const type of ['densify', 'pool', 'crown', 'shoulder', 'brim', 'rise', 'hall-figure', 'stair-figure', 'window-shape', 'partial-figure', 'lean']) {
  // pause the scheduler so nothing else appears
  const box = await page.evaluate((type) => {
    const r = window.residual;
    const c = r.camera;
    c.anomalies.abort();
    c.anomalies.reset(r.session.clock() + 1e6);
    if (!c.force(type)) return null;
    const a = c.anomalies.active;
    a.t1 = r.session.clock() + 4;
    a.fade = 0.1;
    const motion = a.def.motion;
    a.def = { ...a.def, motion: (t, p, m) => motion(0.45, p, m) };
    const p = a.placement;
    const ax = a.site.region ? a.site.box.x + a.site.box.w / 2 : p.ax;
    const ay = a.site.region ? a.site.box.y + a.site.box.h / 2 : p.ay + 0.04;
    const [fx, fy] = c.renderer.frameToView(ax, ay);
    const rect = document.querySelector('.feed').getBoundingClientRect();
    return { x: rect.left + fx * rect.width, y: rect.top + fy * rect.height, site: a.site.kind, density: a.density };
  }, type);
  if (!box) { console.log(`skip ${type}: no compatible on-screen site`); continue; }
  await page.waitForTimeout(400);
  const size = 150;
  const clip = { x: Math.max(0, box.x - size / 2), y: Math.max(0, box.y - size / 2), width: size, height: size };
  const after = `${OUT}g-${type}-on.png`;
  await page.screenshot({ path: after, clip });
  await page.evaluate(() => window.residual.camera.anomalies.abort());
  await page.waitForTimeout(250);
  const before = `${OUT}g-${type}-off.png`;
  await page.screenshot({ path: before, clip });
  shots.push({ type, site: box.site, before, after });
  console.log(`${type} @ ${box.site} density ${box.density.toFixed(2)}`);
}
await browser.close();
execFileSync('python3', ['-c', `
import json,sys
from PIL import Image, ImageDraw
shots=json.loads(sys.argv[1]); n=len(shots)
import numpy as np
c=Image.new('RGB',(n*310,950),(50,50,50)); d=ImageDraw.Draw(c)
for i,s in enumerate(shots):
  a=Image.open(s['before']).convert('RGB').resize((300,300)); b=Image.open(s['after']).convert('RGB').resize((300,300))
  diff=np.abs(np.asarray(b,float)-np.asarray(a,float)).mean(2)
  k=6; h=300//k*k; blk=diff[:h,:h].reshape(h//k,k,h//k,k).mean((1,3))
  amp=Image.fromarray(np.clip(np.kron(blk,np.ones((k,k)))*12,0,255).astype('uint8')).convert('RGB')
  c.paste(a,(i*310,20)); c.paste(b,(i*310,330)); c.paste(amp,(i*310,640)); d.text((i*310+4,4),s['type']+' @ '+s['site'],fill=(220,220,200))
c.save(sys.argv[2])`, JSON.stringify(shots), `${OUT}gallery-${scene}.png`]);
