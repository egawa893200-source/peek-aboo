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
  // **ここが本題。** `loop.start()` が終わっていても場面はまだ空のことがある
  await page.waitForFunction(() => window.__peekaboo.isReady());
  await page.waitForFunction(() => window.__peekaboo.getSpots().length === 4);
}

/** 隠れ場所の画面上の中心。当たり判定はここから測る（§7-3） */
async function spotCenters(page: Page): Promise<{ id: string; x: number; y: number; r: number }[]> {
  return page.evaluate(() =>
    window.__peekaboo
      .getSpots()
      .map((s) => ({ id: s.id, x: s.screenX, y: s.screenY, r: s.radiusPx }))
  );
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


test.describe('§4-1 状態遷移', () => {
  test('どの隠れ場所を押しても out まで到達する', async ({ page }) => {
    await boot(page);
    const spots = await spotCenters(page);
    expect(spots).toHaveLength(4);

    const tapsOf = () =>
      page.evaluate(() => Object.fromEntries(window.__peekaboo.getSpots().map((s) => [s.id, s.taps])));

    for (const spot of spots) {
      const before = await tapsOf();
      // **本物の pointerdown を通す。** デバッグ API から直接叩くと、
      // 「Input が document.body に付いていない」ような配線の事故を見逃す
      await page.mouse.click(spot.x, spot.y);
      await page.waitForFunction(
        (id) => window.__peekaboo.getSpots().find((s) => s.id === id)?.state === 'out',
        spot.id,
        { timeout: 3000 }
      );
      const after = await page.evaluate(
        (id) => window.__peekaboo.getSpots().find((s) => s.id === id),
        spot.id
      );
      expect(after?.reveal).toBe(1);

      // **押した場所だけが増えること。** 隣が反応したら当たり判定がずれている。
      // 累計ではなく「この1回で増えたか」で見る（前の周回のぶんが残るため）
      const now = await tapsOf();
      for (const other of spots) {
        const delta = now[other.id] - before[other.id];
        expect(delta, `${other.id} が ${spot.id} のタップを取った`).toBe(other.id === spot.id ? 1 : 0);
      }
      // 次の隠れ場所へ行く前に、押したぶんを引っ込めておく
      await page.waitForFunction(
        (id) => window.__peekaboo.getSpots().find((s) => s.id === id)?.state === 'hidden',
        spot.id,
        { timeout: 6000 }
      );
    }
  });

  test('hiding 中に押すと appearing に戻る（reveal は 0 に落ちない）', async ({ page }) => {
    await boot(page);
    const [spot] = await spotCenters(page);

    // **ブラウザの中で完結させる。** hiding は 0.5秒しか無いので、
    // Node から状態を取りに行くと往復の遅れで窓を外すことがある
    const result = await page.evaluate(async (target) => {
      const api = window.__peekaboo;
      const stateOf = () => api.getSpots().find((s) => s.id === target.id)!;
      const until = (pred: () => boolean) =>
        new Promise<void>((resolve) => {
          const step = () => (pred() ? resolve() : requestAnimationFrame(step));
          step();
        });

      api.tap(target.x, target.y);
      // **`hiding` に入った瞬間はまだ reveal が 1.0。**
      // 減りはじめるのは次のフレームなので、そこまで待たないと
      // 「途中から呼び戻せるか」を見たことにならない
      await until(() => stateOf().state === 'hiding' && stateOf().reveal < 1);
      const before = stateOf().reveal;

      api.tap(target.x, target.y);
      const afterState = stateOf().state;

      let min = stateOf().reveal;
      await until(() => {
        min = Math.min(min, stateOf().reveal);
        return stateOf().reveal >= 1;
      });
      return { before, afterState, min };
    }, spot);

    expect(result.before).toBeGreaterThan(0);
    expect(result.before).toBeLessThan(1);
    expect(result.afterState).toBe('appearing');
    // §4-1「hiding から呼び戻せること」。0 に落ちたら出直しになっている
    expect(result.min).toBeGreaterThanOrEqual(result.before);
  });

  test('60Hz で連打しても登場が完走する', async ({ page }) => {
    await boot(page);
    const [spot] = await spotCenters(page);

    // みずのなかの貝は、これで開き量の最大が 0.037 だった（1回押しなら 1.0）
    const maxReveal = await page.evaluate(async (target) => {
      const api = window.__peekaboo;
      let max = 0;
      for (let i = 0; i < 120; i++) {
        api.tap(target.x, target.y);
        await new Promise((r) => requestAnimationFrame(r));
        const s = api.getSpots().find((x) => x.id === target.id);
        if (s) max = Math.max(max, s.reveal);
      }
      return max;
    }, spot);

    expect(maxReveal).toBe(1);
    // 連打したぶんは1回残らず応答している（不変条件1・2）
    const [hits, responses] = await page.evaluate(() => [
      window.__peekaboo.getHitCount(),
      window.__peekaboo.getSpotResponseCount(),
    ]);
    expect(responses).toBe(hits);
    expect(hits).toBeGreaterThanOrEqual(120);
  });
});

test.describe('不変条件3 — 隠れていても必ず見えている', () => {
  test('隠れているとき、縁から出ている量が 0 でない', async ({ page }) => {
    await boot(page);
    const spots = await spotCenters(page);
    for (const spot of spots) {
      const e = await page.evaluate((id) => window.__peekaboo.getExposure(id), spot.id);
      expect(e, spot.id).not.toBeNull();
      expect(e!.fraction, spot.id).toBeGreaterThan(0);
      // §4-2「はみ出しは体長の 15〜25%」
      expect(e!.fraction, spot.id).toBeGreaterThanOrEqual(0.15);
      expect(e!.fraction, spot.id).toBeLessThanOrEqual(0.25);
      // 顔が見えていたら「ばあ！」が驚きにならない
      expect(e!.bodyFraction, spot.id).toBeLessThan(0.01);
    }
  });
});

test.describe('§3-2 UI と当たり判定', () => {
  test('隠れ場所どうしの当たり判定が重ならない', async ({ page }) => {
    await boot(page);
    const spots = await spotCenters(page);

    // みずのなかでは貝と岩が画面上 21px しか離れておらず、岩が先に取っていた。
    // ここは実測して記録する（数字は下の「描画量と当たり判定の実測」にも出る）
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const d = Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y);
        expect(spots[i].r + spots[j].r, `${spots[i].id}-${spots[j].id} d=${d.toFixed(1)}px`).toBeLessThan(d);
      }
    }
  });

  test('当たり判定がペアレンタルゲートのホットスポットを塞がない', async ({ page }) => {
    await boot(page);
    const spots = await spotCenters(page);
    const gate = await page.locator('.gate__hotspot').boundingBox();
    expect(gate).not.toBeNull();
    if (!gate) return;

    // ホットスポットの中心と、当たり判定の円が重ならないこと。
    // ここが重なると、右上を押したときに遊びとゲートのどちらが取るか分からなくなる
    const gx = gate.x + gate.width / 2;
    const gy = gate.y + gate.height / 2;
    for (const s of spots) {
      const d = Math.hypot(s.x - gx, s.y - gy);
      expect(d, `${s.id} とゲートの距離`).toBeGreaterThan(s.r + Math.max(gate.width, gate.height) / 2);
    }
  });

  test('隠れ場所の当たり判定が画面内に収まっている', async ({ page }) => {
    await boot(page);
    const spots = await spotCenters(page);
    const size = page.viewportSize();
    expect(size).not.toBeNull();
    if (!size) return;

    for (const s of spots) {
      // 中心が画面の外にあると、そもそも押せない
      expect(s.x, s.id).toBeGreaterThan(0);
      expect(s.x, s.id).toBeLessThan(size.width);
      expect(s.y, s.id).toBeGreaterThan(0);
      expect(s.y, s.id).toBeLessThan(size.height);
      // 半径が指より小さくなっていないこと（縮めすぎの検出）
      expect(s.r, s.id).toBeGreaterThan(40);
    }
  });
});

test.describe('不変条件8 — 場面を捨てるときに漏らさない', () => {
  test('場面を10往復しても renderer.info.memory が増え続けない', async ({ page }) => {
    await boot(page);

    // **描画を1フレーム挟むこと。** `renderer.info.memory` は
    // GPU に上げたぶんを数えるので、作り直した直後はまだ 0 のことがある。
    // ここを待たずに測ったせいで、同じコードが緑にも赤にもなった（実測）
    const reloadAndSettle = () =>
      page.evaluate(async () => {
        await window.__peekaboo.reloadScene();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });

    await reloadAndSettle();
    const before = await page.evaluate(() => window.__peekaboo.getMemory());
    expect(before.geometries).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) await reloadAndSettle();
    const after = await page.evaluate(() => window.__peekaboo.getMemory());

    // 往復のたびに漏らしていれば、10往復で 11倍に増える
    expect(after.geometries).toBeLessThanOrEqual(before.geometries);
    expect(after.textures).toBeLessThanOrEqual(before.textures);
  });
});

test.describe('描画量と当たり判定の実測（§10-2）', () => {
  test('三角形数・draw call・当たり判定の距離を記録する', async ({ page }) => {
    await boot(page);
    // 全部出した状態がいちばん重いので、そこで測る
    const spots = await spotCenters(page);
    for (const s of spots) await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(400);

    const info = await page.evaluate(() => window.__peekaboo.getRenderInfo());
    const fits = await page.evaluate(() =>
      window.__peekaboo.getSpots().map((s) => ({ id: s.id, ...window.__peekaboo.getFit(s.id)! }))
    );

    const lines = [
      `三角形: ${info.triangles}  draw call: ${info.calls}  geometry: ${info.geometries}  texture: ${info.textures}`,
      ...spots.map(
        (s) => `  ${s.id.padEnd(8)} 画面(${s.x.toFixed(1)}, ${s.y.toFixed(1)}) 当たり半径 ${s.r.toFixed(1)}px`
      ),
    ];
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const d = Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y);
        lines.push(
          `  ${spots[i].id}-${spots[j].id}: ${d.toFixed(1)}px  半径の和 ${(spots[i].r + spots[j].r).toFixed(1)}px  すき間 ${(d - spots[i].r - spots[j].r).toFixed(1)}px`
        );
      }
    }
    for (const f of fits) {
      lines.push(`  ${f.id.padEnd(8)} 開口 ${f.mouthWidth.toFixed(3)} / 動物 ${f.animalWidth.toFixed(3)} = ${f.ratio.toFixed(2)}倍`);
    }
    console.log(['[実測]', ...lines].join('\n'));

    // **fps は合否にしない**（GPU が無いので実機性能を反映しない）。
    // GPU に依存しない量だけを、天井をはっきり決めて見る（§10-2）。
    // 手続き生成の4体＋隠れ場所4つで 20,000三角形を超えたら、
    // モデルを .glb に差し替える前に分割数を見直すこと
    expect(info.triangles).toBeGreaterThan(0);
    expect(info.triangles).toBeLessThan(20_000);
    expect(info.calls).toBeLessThan(120);
    // テクスチャは1枚も使っていない（すべて単色。不変条件7 の確認にもなる）
    expect(await page.evaluate(() => window.__peekaboo.getTextureBytes().bytes)).toBe(0);
  });
});
