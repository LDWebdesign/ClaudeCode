/** Desktop-size screenshots: e2e/out/d-*.png */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = new URL('./out/', import.meta.url).pathname;
const MEDIA = new URL('./media/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${MEDIA}room.y4m`, `--use-file-for-fake-audio-capture=${MEDIA}speech.wav`] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:4173/?debug');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}d-intro.png` });
await page.fill('#loc', 'Halvorsen house — upstairs hall');
await page.click('button[type=submit]');
for (const q of ['Is anyone here with us tonight?', 'Did you live in this house?', 'Can you tell us your name?']) {
  await page.evaluate((t) => window.residual.spiritBox.ask(t), q);
  await page.waitForTimeout(6000);
}
await page.screenshot({ path: `${OUT}d-spiritbox.png` });
await page.click('button[data-mode=camera]');
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}d-camera.png` });
await page.evaluate(() => window.residual.config.update((c) => (c.diagnostics = true)));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}d-camera-diag.png` });
await page.evaluate(() => window.residual.config.update((c) => (c.diagnostics = false)));
await page.click('button[aria-label=Calibration]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}d-calibration.png` });
await browser.close();
