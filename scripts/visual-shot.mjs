/**
 * 見た目の採点用に、場面を**決定論的に**撮る
 *
 *   npm run visual:shot                     capture/visual/current/ に7場面
 *   npm run visual:shot -- --out baseline   capture/visual/baseline/ に撮る
 *   npm run visual:shot -- --verify         2回撮ってバイト単位で一致するか見る
 *
 * ==========================================================================
 * **これは CI の合否ではない。** §10-2（CLAUDE.md「CI が判定しないこと」）で
 * 動いている場面の画素比較は禁止されている。ここで撮るのは
 * **人間と `visual-judge` が見た目を採点するための材料**で、
 * `npm run verify` からは呼ばない。
 *
 * 決定論のために2つやっている:
 *  ① `__peekaboo.freezeAt()` が rAF を止め、更新時計を 0 に戻してから
 *     ちょうど n ステップ進めて1枚描く。**壁時計を読まない**ので、
 *     GPU の速さでアニメーションの位相が変わらない
 *  ② 場面ごとに**ページを読み直す**。場面を続けて切り替えると、
 *     three の `generateUUID()` が `Math.random()` を消費した回数が変わって、
 *     触っていない場面の乱数までずれる（CLAUDE.md の実測）
 *
 * 隠れ場所だけを消した2枚目（`<id>.bg.png`）も撮る。
 * 2枚の差が、そのまま「隠れ場所の画素」になる（`visual-score.mjs`）。
 * ==========================================================================
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 撮る場面。**全場面を撮る**（合格ラインは「いちばん悪いもの」で決まる） */
const SCENES = ['ouchi', 'soto', 'umi', 'noujou', 'dobutsuen', 'kyoryu', 'nohara'];
/** 場面の乱数の種。**固定**（変えると飾りの位置が変わって比較にならない） */
const SEED = 20260907;
/** 何秒ぶん進めてから撮るか。更新時計（§10-2）。常時のゆれの位相がここで決まる */
const AT_SEC = 2.0;
/** 端末。Pixel 7 の縦持ち。DPR は 1（2 にすると SwiftShader で撮影が不安定） */
const VIEWPORT = { width: 412, height: 839 };

function parseArgs(argv) {
  const out = { outDir: 'current', verify: false, scenes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = argv[++i];
    else if (a === '--verify') out.verify = true;
    else if (a === '--scene') out.scenes.push(argv[++i]);
  }
  return out;
}

async function shootAll(page, baseUrl, scenes, outDir) {
  await mkdir(outDir, { recursive: true });
  const spots = {};
  for (const id of scenes) {
    // **場面ごとに読み直す**（上の理由②）
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__peekaboo?.isReady?.(), null, { timeout: 40000 });
    await page.evaluate(
      ([sceneId, seed, sec]) => window.__peekaboo.freezeAt(sceneId, seed, sec),
      [id, SEED, AT_SEC]
    );
    const canvas = page.locator('canvas');
    // ①ふつう ②接地影だけ消す ③隠れ場所ごと消す。
    // ②−③ が「隠れ場所そのものの画素」、①−② が「接地影の効き」
    await canvas.screenshot({ path: resolve(outDir, `${id}.png`) });
    await page.evaluate(() => window.__peekaboo.setShadowsVisible(false));
    await canvas.screenshot({ path: resolve(outDir, `${id}.solid.png`) });
    await page.evaluate(() => window.__peekaboo.setSpotsVisible(false));
    await canvas.screenshot({ path: resolve(outDir, `${id}.bg.png`) });
    await page.evaluate(() => {
      window.__peekaboo.setSpotsVisible(true);
      window.__peekaboo.setShadowsVisible(true);
    });
    spots[id] = await page.evaluate(() =>
      window.__peekaboo.getSpots().map((s) => ({ id: s.id, x: s.screenX, y: s.screenY }))
    );
    console.log(`  ${id}`);
  }
  return spots;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenes = args.scenes.length > 0 ? args.scenes : SCENES;

  const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5199 } });
  await server.listen();
  const baseUrl = 'http://localhost:5199/';

  const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    ...(existsSync(executablePath) ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

  try {
    if (args.verify) {
      // **同じコードで2回撮ってバイト単位で一致するか。**
      // 一致しないなら、採点の材料としても使えない（CLAUDE.md の match-gate と同じ作法）
      const a = resolve(ROOT, 'capture/visual/.verify-a');
      const b = resolve(ROOT, 'capture/visual/.verify-b');
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
      console.log('1回目');
      await shootAll(page, baseUrl, scenes, a);
      console.log('2回目');
      await shootAll(page, baseUrl, scenes, b);
      let bad = 0;
      for (const id of scenes) {
        for (const suffix of ['png', 'solid.png', 'bg.png']) {
          const [x, y] = await Promise.all([
            readFile(resolve(a, `${id}.${suffix}`)),
            readFile(resolve(b, `${id}.${suffix}`)),
          ]);
          const same = x.equals(y);
          if (!same) bad++;
          console.log(`  ${same ? '一致' : '不一致'}  ${id}.${suffix}  ${x.length}B / ${y.length}B`);
        }
      }
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
      if (bad > 0) {
        console.error(`\n${bad} 枚が一致しなかった。決定論が崩れているので採点に使えない`);
        process.exitCode = 1;
      } else {
        console.log('\nすべてバイト単位で一致');
      }
    } else {
      const outDir = resolve(ROOT, 'capture/visual', args.outDir);
      console.log(`→ capture/visual/${args.outDir}/`);
      const spots = await shootAll(page, baseUrl, scenes, outDir);
      await writeFile(
        resolve(outDir, 'shot.json'),
        JSON.stringify({ scenes, seed: SEED, atSec: AT_SEC, viewport: VIEWPORT, spots }, null, 2) + '\n',
        'utf8'
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
