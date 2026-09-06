/**
 * 参照画像の切り抜きを、アプリの素材（WebP）に変換する
 *
 *   npm run cutouts
 *
 * ==========================================================================
 * `reference/animals/<id>/front.png`（背景が透明・輪郭線つき）を
 * `public/animals/<id>.webp` にする。**これがそのまま動物になる**（道A）。
 *
 * この app のカメラは動物を最大 17.0° しか回り込まない（実測）。
 * 立体である必要がほとんど無いので、絵をそのまま板に貼る。
 *
 * **素材が1つも無くてもアプリは起動する**（不変条件7）。
 * `public/animals/` を空にすると、手続き生成の動物に落ちる。
 *
 * 変換もヘッドレス Chromium にやらせている（WebP エンコーダを依存に足さないため）。
 * ==========================================================================
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = resolve(ROOT, 'reference/animals');
const OUT_DIR = resolve(ROOT, 'public/animals');

/** 出力の高さ。1体が画面に占めるのは高くても 400px 程度なので 512 で足りる */
const MAX_H = 512;
/** WebP の品質。0.9 未満にすると輪郭線のふちに滲みが出る */
const QUALITY = 0.92;

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
  const ids = (await readdir(SRC_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
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
  await page.setContent('<!doctype html><meta charset="utf-8"><title>cutouts</title>');
  await mkdir(OUT_DIR, { recursive: true });

  let total = 0;
  const sizes = [];
  try {
    for (const id of targets) {
      const src = resolve(SRC_DIR, id, 'front.png');
      if (!existsSync(src)) {
        console.error(`${id}: front.png がありません`);
        process.exitCode = 1;
        continue;
      }
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
      sizes.push([id, r.w, r.h]);
      console.log(`${id.padEnd(12)} ${r.w}x${r.h}  ${(bytes.length / 1024).toFixed(0)}KB`);
    }
    console.log(`\n${targets.length} 体 / 合計 ${(total / 1024).toFixed(0)}KB → public/animals/`);

    // **絵の大きさを src にも書き出す。**
    // 単体テストは node で走るので画像を読めない。ここが無いと、絵を貼った
    // 動物（`CutoutAnimal`）を一度もテストできない。実際にそれで
    // 「ヒントの位置を設定し忘れて 25体すべてが不変条件3 違反」を見逃した
    if (only.length === 0) {
      const lines = sizes.map(([id, w, h]) => `  ${id}: [${w}, ${h}],`).join('\n');
      const file = `/**
 * 絵の大きさ（**自動生成。手で書き換えないこと**）
 *
 * \`npm run cutouts\` が \`public/animals/<id>.webp\` を作るときに一緒に書く。
 * 単体テストが、画像を読まずに絵の縦横比を再現するために使う。
 * アプリ本体は使わない（実行時はテクスチャから読む）。
 */
export const CUTOUT_SIZES: Readonly<Record<string, readonly [number, number]>> = {
${lines}
};
`;
      await writeFile(resolve(ROOT, 'src/data/cutoutSizes.ts'), file, 'utf8');
      console.log('src/data/cutoutSizes.ts を書きました');
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
