/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves from /<repo>/; override with BASE_PATH for other hosts
// (Netlify / Cloudflare Pages serve from root, so set BASE_PATH=/ there).
const base = process.env.BASE_PATH ?? '/block-game/';

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // Service worker OFF in `npm run dev` so phone testing over the LAN never
      // serves stale cached code. Verify install/offline with `npm run build`
      // + `npm run preview` instead (or flip this to true temporarily).
      devOptions: { enabled: false },
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Block Game',
        short_name: 'Blocks',
        description: 'A friendly block puzzle game.',
        theme_color: '#1e293b',
        background_color: '#1e293b',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
