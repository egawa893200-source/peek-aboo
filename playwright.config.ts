import { defineConfig, devices } from '@playwright/test';

/**
 * E2E は「壊れていないこと」だけを見る。
 * fps の数値判定とスクリーンショット比較はしない（CLAUDE.md 参照）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  // 描画を待つテストが多いので、全体は長めに、1件ごとは短めに
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Pixel 7'],
        // Pixel 7 の deviceScaleFactor は 2.625。そのままだと毎フレーム
        // 1081×2401 = 260万画素をソフトウェア描画することになり、CI では
        // 1秒に1枚も進まなくなる（実測: e2e 全体で 11.6分）。
        // 見た目の検証はしない（CLAUDE.md「CI が判定しないこと」）ので、
        // 等倍にして画素数を落とす。判定する内容は何も変えていない。
        deviceScaleFactor: 1,
        // CI にも開発コンテナにも GPU が無いので、WebGL はソフトウェア描画で動かす
        launchOptions: {
          // Playwright が用意した Chromium を使えない環境向けの逃げ道。
          // CI では `npx playwright install chromium` が入るので不要
          ...(process.env.PW_CHROMIUM_PATH
            ? { executablePath: process.env.PW_CHROMIUM_PATH }
            : {}),
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
