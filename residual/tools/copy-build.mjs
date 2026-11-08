// Copies the single-file build to the repository root, next to the other standalone apps.
import { copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const src = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const dest = fileURLToPath(new URL('../../residual.html', import.meta.url));
copyFileSync(src, dest);
console.log(`residual.html written (${(statSync(dest).size / 1024).toFixed(0)} KB)`);
