/**
 * 場面の定義（設計書 §5-3）
 *
 * **データだけを置く。ロジックを書かない。**
 *
 * 今回は「おうち」1場面だけ。そと／うみ／のはら は Phase 6 で足す。
 * のはらだけがモードB（`chase`）になる予定なので、`mode` は最初から持たせてある。
 *
 * ------------------------------------------------------------------------
 * **座標は実測して決めた。目分量で置いていない。**
 *
 * カメラは z = 7.2 の PerspectiveCamera（縦画面では fov 66）。
 * Pixel 7（Playwright の実測で 412×839 CSS px）に投影すると、こう出る:
 *
 *   はこ    (102.0, 279.4)      カーテン (310.0, 279.4)
 *   ふとん  (103.6, 526.2)      とびら   (308.4, 526.2)
 *
 * いちばん近い組は「ふとん - とびら」で **204.8px**。
 * つまり**当たり半径を左右で分け合えるのは 102.4px まで**で、
 * 設計書 §7-3 の既定 120px は 2×2 に並べた時点で重なる。
 * ワールド座標を固定したまま画面の大きさだけ変わるので、
 * **どんな定数を選んでも全端末では成立しない**:
 *
 *   端末                  いちばん近い組   120+120 に対して
 *   Pixel 7   412×839         204.8px       35.2px 食い込む
 *   iPhone 12 390×750         183.0px       57.0px 食い込む
 *   小型      360×600         146.4px       93.6px 食い込む
 *   デスクトップ 1280×720     219.2px       20.8px 食い込む
 *   横持ち    844×390         118.7px      121.3px 食い込む
 *
 * そこで `hitRadiusPx` は**上限値**として持ち、実際の半径は
 * `SpotSystem.radiusAt()` が隣との距離を見て縮める。
 * Pixel 7 では 120 → 101.4〜103.0px に落ち、どの2つも 2.0px 以上あく
 * （E2E「隠れ場所どうしの当たり判定が重ならない」が毎回測っている）。
 *
 * 下端は 526.2 + 101.4 = 627.6px。Phase 6 で場面切替バーを置くときは、
 * **バーの上端が 628px より下**（Pixel 7 で画面下から 211px 以内）に
 * なることを E2E で確かめること。みずのなかでは切替バーが画面下部の岩に
 * 覆いかぶさり、岩を押しても水槽の切替になっていた（§3-2）。
 * ------------------------------------------------------------------------
 */

import type { SceneConfig } from '../types';

/**
 * 隠れ場所の当たり半径の**上限**（CSS px）。設計書 §7-3 の既定値。
 * 実際にはここまで使えないことのほうが多い（上のコメント参照）。
 */
const HIT_RADIUS_PX = 120;

const OUCHI: SceneConfig = {
  id: 'ouchi',
  label: 'おうち',
  mode: 'hideout',
  // 素材はまだ1つも無い。null なら手続き生成に落ちる（不変条件7）
  backgroundUrl: null,
  ambientSound: null,
  spots: [
    {
      id: 'hako',
      kind: 'box',
      position: [-1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      // 1体だけ。同じ場所から別の動物が出る仕掛け（§6-2）は Phase 7
      animals: ['neko'],
    },
    {
      id: 'kaaten',
      kind: 'curtain',
      position: [1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ['kotori'],
    },
    {
      id: 'huton',
      kind: 'blanket',
      position: [-1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ['nezumi'],
    },
    {
      id: 'tobira',
      kind: 'door',
      position: [1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ['inu'],
    },
  ],
};

export const SCENES: readonly SceneConfig[] = [OUCHI];

export const DEFAULT_SCENE_ID = OUCHI.id;

/** id から引く。無ければ最初の場面（起動しないよりまし。不変条件7） */
export function findScene(id: string): SceneConfig {
  return SCENES.find((s) => s.id === id) ?? OUCHI;
}
