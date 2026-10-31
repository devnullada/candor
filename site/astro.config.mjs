import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { docLinks } from './src/doc-links.mjs';

// candorlanguage.org: static pages, built by `bun run build` into dist/ and shipped by
// `bun run deploy`. Port 4321 strictly, so a clash fails rather than moving the dev server.
export default defineConfig({
  site: 'https://candorlanguage.org',
  server: { port: 4321, strictPort: true },
  redirects: { '/docs': '/docs/start/' },
  markdown: {
    // Candor has no grammar yet (#64ea6126); Rust's is the closest stand-in.
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: 'dark', langAlias: { candor: 'rust' } },
    rehypePlugins: [docLinks],
  },
  // /api is sha256's contact service: Caddy proxies it on the server; in development it runs on
  // 5290 (apps/sha256.no/README.md in the sha256 repo says how, with CONTACT_DRY_RUN=1).
  vite: { plugins: [tailwindcss()], server: { fs: { allow: ['..'] }, proxy: { '/api': 'http://127.0.0.1:5290' } } },
});
