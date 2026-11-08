/** Default-settings spirit-box session with typed questions; prints the resulting log. */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const MEDIA = new URL('./media/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${MEDIA}silence.wav`] });
const page = await (await browser.newContext()).newPage();
await page.goto('http://localhost:4173/?debug');
await page.fill('#loc', 'realistic');
await page.click('button[type=submit]');
await page.waitForTimeout(1500);
const qs = ['Is anyone here with us?', 'Are you a man?', 'Did you die here?', 'What is your name?', 'How old are you?', 'Do you want us to leave?', 'Can you knock for us?', 'Are you in the basement?'];
for (const q of qs) {
  await page.evaluate((t) => window.residual.spiritBox.ask(t), q);
  await page.waitForTimeout(30000);
}
await page.waitForTimeout(15000);
const log = await page.evaluate(() => {
  const s = window.residual.session;
  const t0 = s.record.startedAt;
  return s.events.map((e) => `${((e.t - t0) / 1000).toFixed(1).padStart(6)}s ${e.hidden ? '(unlogged) ' : ''}${e.type.padEnd(12)} ${e.title}${e.text ? ` “${e.text}”` : ''}${e.alternates ? ` alt ${e.alternates.join('/')}` : ''}${e.detail ? ` — ${e.detail}` : ''}${e.meta?.tier ? `   [${e.meta.tier}${e.meta.cause ? '/' + e.meta.cause : ''}]` : ''}`);
});
console.log(log.join('\n'));
await browser.close();
