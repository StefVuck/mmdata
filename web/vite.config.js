import { defineConfig } from 'vite';

// Link previews need absolute URLs, so the deployed address comes in as SITE_URL at build
// time, e.g. SITE_URL=https://example.com/slow-trade npm run build. Without it, the tags fall
// back to relative paths, which some apps ignore.
const site = (process.env.SITE_URL || '.').replace(/\/+$/, '');

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
  server: { fs: { allow: ['..'] } },
  plugins: [
    {
      name: 'site-url',
      transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', site),
    },
  ],
});
