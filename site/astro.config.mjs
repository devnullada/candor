import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// candorlanguage.org: one static page, built by `bun run build` into dist/ and shipped by
// `bun run deploy`. Port 4321 strictly, so a clash fails rather than moving the dev server.
export default defineConfig({
  site: 'https://candorlanguage.org',
  server: { port: 4321, strictPort: true },
  vite: { plugins: [tailwindcss()] },
});
