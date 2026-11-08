import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The whole app (code, styles, fonts, voice bank) is inlined into one HTML file so it
// can be hosted anywhere static, saved to a phone, and run without a network.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  assetsInclude: ['**/*.bin'],
  build: {
    target: 'es2021',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
