import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Netlify はサイトの直下（/）で配信するので base は '/'。
// サブディレクトリに置くホスト（GitHub Pages など）に変えるときだけ
// BASE_PATH を指定する。**素材のURLは必ず resolveAssetUrl() を通すこと**
// （通っていないと、素材を置いた瞬間に 404 になるのに気づけない）。
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    // PWA: オフラインキャッシュ。ホーム画面に追加でフルスクリーン起動する
    VitePWA({
      registerType: 'autoUpdate',
      // 開発中は SW を動かさない（古いキャッシュが残ると原因の切り分けができない）
      devOptions: { enabled: false },
      manifest: {
        name: 'ばあ！',
        short_name: 'ばあ！',
        description: 'いないいないばあで遊ぶアプリ',
        lang: 'ja',
        start_url: '.',
        scope: '.',
        // 不変条件5: ブラウザUIに触れさせない
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#12203a',
        theme_color: '#12203a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // アプリ本体は全てプリキャッシュする（機内モードでも起動する）
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        // モデル・音・背景は大きいので、実際に見た場面のぶんだけ後からキャッシュする
        runtimeCaching: [
          {
            urlPattern: /\/(models|audio|backgrounds|textures)\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'baa-assets',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 60 },
              rangeRequests: true,
              cacheableResponse: { statuses: [0, 200, 206] },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
  server: {
    host: true, // 実機（iPhone / Android）から LAN 経由で開けるようにする
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
