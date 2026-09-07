/**
 * 同じ隠れ場所から別の動物が出る（§6-2 / 2026-09-06）
 *
 * ==========================================================================
 * 設計書 §6-2 は「`SpotConfig.animals` に複数入れておく」と書いているが、
 * **そのままでは動物が足りない。**
 *
 * いま動物は25体で、モードAの6場面 × 4箇所 ＝ 24箇所にちょうど1体ずつ、
 * のはらに うさぎ 1体。1箇所に2体ずつ入れるには48体要る。
 * かといって場面をまたいで使い回すと、
 * **「同じ動物を2つの場面に出さない」**（2026-09-05 に人間が決めた）を破る。
 *
 * そこで、**場面の中で動物を入れ替える**。
 * ねこの居たはこから、次はいぬが出る。動物は増えないが、
 * §6-2 が狙っている「またねこかな？」→「あ、いぬだ！」はそのまま起きる。
 * **同時に同じ動物が2箇所に出ることは、原理的にない**（交換なので）。
 *
 * **毎回入れ替えないこと。**
 * CLAUDE.md は「同じ場面の4体は必ず違う形にする。どの場所に誰が居るかを
 * 形で覚えられるようにするため」としている。毎回入れ替えると、
 * その手がかりが消える。4回に1回だけにして、覚えたことが
 * だいたい当たる状態を保つ。
 *
 * 守っていること:
 *  - **隠れ終わってから入れ替える。** 出ている最中だと目の前ですり替わる
 *  - **相手も隠れ終わっていること。** 開いている場所の中身が変わらない
 *  - モードB（§4-5）では何もしない。走り手が移動しているので、
 *    ここが動かすと2つの書き手が同じものを取り合う
 *  - 乱数は独立した種から（three の `generateUUID()` が `Math.random()` を
 *    消費するので、共有の乱数列に相乗りすると抽選が勝手に変わる）
 * ==========================================================================
 */

import type { AnimalSystem } from './AnimalSystem';
import type { SpotRuntime, SpotSystem } from './SpotSystem';

/**
 * 隠れ終わったときに入れ替える確率。
 *
 * **1.0 にしないこと。** 毎回変わると「どこに誰が居るか」を覚えられない。
 * 4回に1回なら、覚えたことがだいたい当たったうえで、たまに裏切られる
 */
export const SWAP_CHANCE = 0.25;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpotShuffleOptions {
  seed?: number;
  chance?: number;
}

export class SpotShuffle {
  private readonly rng: () => number;
  private readonly chance: number;
  private rolled = 0;

  constructor(
    private readonly spots: SpotSystem,
    private readonly animals: AnimalSystem,
    options: SpotShuffleOptions = {}
  ) {
    this.rng = mulberry32(options.seed ?? ((Date.now() ^ 0xc2b2ae35) >>> 0));
    this.chance = options.chance ?? SWAP_CHANCE;
    spots.onHidden((spot) => this.onHidden(spot));
  }

  private onHidden(spot: SpotRuntime): void {
    this.rolled++;
    if (this.rng() >= this.chance) return;
    if (!spot.occupied) return;

    // 相手は「隠れ終わっていて、中身が居る、別の場所」だけ
    const others = this.spots.runtimes.filter(
      (s) => s !== spot && s.occupied && s.state === 'hidden' && s.extraOpen === 0
    );
    if (others.length === 0) return;

    const pick = others[Math.min(others.length - 1, Math.floor(this.rng() * others.length))];
    this.animals.swap(spot, pick);
  }

  /** 抽選した回数。**入れ替えた回数は `AnimalSystem.getSwapCount()`** */
  getRolledCount(): number {
    return this.rolled;
  }
}
