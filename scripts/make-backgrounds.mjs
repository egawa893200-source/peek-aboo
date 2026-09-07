/**
 * 背景の絵を、アプリの素材（WebP）に変換する
 *
 *   npm run backgrounds
 *
 * ==========================================================================
 * `reference/backgrounds/<場面id>.png` を `public/backgrounds/<場面id>.webp` にする。
 * `SceneConfig.backgroundUrl` がこれを指す。
 *
 * **素材が1つも無くてもアプリは起動する**（不変条件7）。
 * `public/backgrounds/` を空にすると、手続き生成のグラデーションに落ちる。
 *
 * 変換はヘッドレス Chromium にやらせている（WebP エンコーダを依存に足さないため）。
 * `scripts/make-cutouts.mjs` と同じ作りにしてある。
 * ==========================================================================
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = resolve(ROOT, 'reference/backgrounds');
const OUT_DIR = resolve(ROOT, 'public/backgrounds');

/**
 * 出力の高さ。**元の 2048 のまま**にしてある。
 * 背景の板は z = -1.55（カメラから 8.75）で縦 11.36 を覆う。
 * 縦 839px・DPR 3 の端末では画面に 2517px 出るので、1024 に落とすと足りない。
 */
const MAX_H = 2048;
/**
 * WebP の品質。0.82 で 1.2MB の PNG が 60KB 前後まで落ちる。
 * 動物の切り抜き（0.92）ほど上げていないのは、背景は輪郭線が無く
 * ゆるいグラデーションなので、滲みが目に見えないため。
 */
const QUALITY = 0.82;

async function convertInPage({ dataUrl, maxH, quality }) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, maxH / img.naturalHeight);
  const w = Math.round(img.naturalWidth * k);
  const h = Math.round(img.naturalHeight * k);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const url = canvas.toDataURL('image/webp', quality);
  // **WebP に落ちなかったら PNG が返る。** 黙って PNG を書くと、
  // 拡張子と中身が食い違って後で静かに壊れる（参照画像で実際に起きた）
  return { url, w, h, isWebp: url.startsWith('data:image/webp') };
}

async function main() {
  if (!existsSync(SRC_DIR)) {
    console.error(`${SRC_DIR} がありません`);
    process.exit(2);
  }
  const ids = (await readdir(SRC_DIR))
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.slice(0, -4))
    .sort();
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = only.length > 0 ? ids.filter((id) => only.includes(id)) : ids;
  if (targets.length === 0) {
    console.error('対象がありません');
    process.exit(2);
  }

  const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    ...(existsSync(executablePath) ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>backgrounds</title>');
  await mkdir(OUT_DIR, { recursive: true });

  let total = 0;
  try {
    for (const id of targets) {
      const src = resolve(SRC_DIR, `${id}.png`);
      const dataUrl = `data:image/png;base64,${(await readFile(src)).toString('base64')}`;
      const r = await page.evaluate(convertInPage, { dataUrl, maxH: MAX_H, quality: QUALITY });
      if (!r.isWebp) {
        console.error(`${id}: WebP に変換できませんでした`);
        process.exitCode = 1;
        continue;
      }
      const bytes = Buffer.from(r.url.slice(r.url.indexOf(',') + 1), 'base64');
      await writeFile(resolve(OUT_DIR, `${id}.webp`), bytes);
      total += bytes.length;
      const ratio = (r.w / r.h).toFixed(3);
      console.log(`${id.padEnd(12)} ${r.w}x${r.h} (${ratio})  ${(bytes.length / 1024).toFixed(0)}KB`);
    }
    console.log(`\n${targets.length} 枚 / 合計 ${(total / 1024).toFixed(0)}KB → public/backgrounds/`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
