/**
 * E2E は「壊れていないこと」だけを見る。
 * fps の数値判定とスクリーンショットの画素比較はしない（CLAUDE.md 参照）。
 *
 * **`window.__peekaboo` の型は src から import すること。**
 * 書き写すと、後から足した API が「存在しないプロパティ」のまま残る
 * （みずのなかで実際に起きた）。
 */

import { expect, test, type Page } from '@playwright/test';

import type { App } from '../../src/app/App';

type DebugApi = ReturnType<App['createDebugApi']>;

declare global {
  interface Window {
    __peekaboo: DebugApi;
  }
}

/**
 * アプリの起動を待つ。
 *
 * **`loop.start()` が終わっていても、場面の構築は終わっていない。**
 * みずのなかでは、そこを待たずに隠れ場所を取りに行って `[]` が返り、
 * 5回に1回落ちるテストになっていた。**構築の完了そのものを待つこと。**
 */
async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__peekaboo !== 'undefined');
  await page.waitForFunction(() => window.__peekaboo.getFrameCount() > 10);
}

test.describe('起動', () => {
  test('起動して、フレームが進む', async ({ page }) => {
    await boot(page);
    const a = await page.evaluate(() => window.__peekaboo.getFrameCount());
    await page.waitForTimeout(500);
    const b = await page.evaluate(() => window.__peekaboo.getFrameCount());
    expect(b).toBeGreaterThan(a);
  });

  test('起動から10秒間 console.error が出ない', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await boot(page);
    await page.waitForTimeout(10_000);
    expect(errors).toEqual([]);
  });
});

test.describe('不変条件1 — 無反応を作らない', () => {
  test('画面のどこをタップしても波紋が出る', async ({ page }) => {
    await boot(page);
    const box = await page.locator('#webgl-layer canvas').boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // 四隅と中央。隠れ場所が無い場所でも必ず反応すること。
    //
    // **右上だけは 40px 内側に寄せてある。** そこはペアレンタルゲートの
    // ホットスポット（24×24px, top/right 6px）で、遊びの当たり判定を持たない
    // 唯一の場所だから（不変条件5 の例外）。
    // 実測: (幅-8, 8) を押すとゲートが飲み込み、getTapCount が増えなかった。
    // ここを「無反応のバグ」と読み違えないこと。
    const points = [
      [box.x + 8, box.y + 8],
      [box.x + box.width - 40, box.y + 8],
      [box.x + 8, box.y + box.height - 8],
      [box.x + box.width - 8, box.y + box.height - 8],
      [box.x + box.width / 2, box.y + box.height / 2],
    ] as const;

    // **`.ripple` の要素数を数えても意味が無い。**
    // Ripple は起動時にプールを12個作るので、1度も押していなくても 12 ある。
    // 「押したら実際に波紋が走ったか」は Web Animations で見る。
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      await page.mouse.click(x, y);
      expect(await page.evaluate(() => window.__peekaboo.getTapCount())).toBe(i + 1);
      const running = await page.evaluate(() => document.getAnimations().length);
      expect(running).toBeGreaterThan(0);
    }
  });

  test('連打しても DOM が増え続けない（波紋はプールを使い回す）', async ({ page }) => {
    await boot(page);
    const box = await page.locator('#webgl-layer canvas').boundingBox();
    if (!box) throw new Error('canvas が無い');
    for (let i = 0; i < 40; i++) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 0 });
    }
    // プールの上限（Ripple.POOL_SIZE = 12）＋全画面用1を超えない
    expect(await page.locator('.ripple').count()).toBeLessThanOrEqual(13);
  });
});

test.describe('不変条件5 — ジェスチャに機能を割り当てない', () => {
  test('例外はペアレンタルゲートの2秒長押しだけ。短く押しても開かない', async ({ page }) => {
    await boot(page);
    const hotspot = page.locator('.gate__hotspot');
    await expect(hotspot).toHaveCount(1);

    // 短押しでは開かない（幼児が偶然通過しないこと）
    await hotspot.click();
    await page.waitForTimeout(300);
    await expect(page.locator('.gate__confirm')).toHaveCount(0);
  });
});

test.describe('素材が無くても動く（不変条件7）', () => {
  test('モデル・テクスチャ・音がすべて404でも起動する', async ({ page }) => {
    await page.route('**/*.{glb,gltf,png,jpg,mp3,ogg,wav}', (r) => r.abort());
    await boot(page);
    const a = await page.evaluate(() => window.__peekaboo.getFrameCount());
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__peekaboo.getFrameCount())).toBeGreaterThan(a);
  });
});

// --- ここから先は SpotSystem / AnimalSystem を書いてから ---
//
// test.describe('§4-1 状態遷移', ...)
//   - 隠れ場所を押すと out まで到達する
//   - hiding 中に押すと appearing に戻る
// test.describe('§3-2 UI が当たり判定を塞がない', ...)
//   - 隠れ場所の当たり判定が、UI のボタンと重ならない
//   - 隠れ場所どうしの当たり判定が重ならない
//   （みずのなかでは切替バーが画面下部の岩に覆いかぶさっていた）
// test.describe('§4-5 移動モード', ...)
//   - 移動中に連打しても必ず到着する
//   - 同じ隠れ場所に連続で戻らない（20周まわして 0 回）
// test.describe('不変条件8 メモリ', ...)
//   - 場面を10往復しても renderer.info.memory が増え続けない
