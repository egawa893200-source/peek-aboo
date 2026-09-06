/**
 * 場面の定義（設計書 §5-3）
 *
 * **データだけを置く。ロジックを書かない。**
 *
 * 5場面。おうち／そと／うみ／のうじょう がモードA（その場に住む）、
 * のはら だけがモードB（おいかけっこ / §4-5）。
 *
 * 隠れ場所は**モードAが4箇所、のはらだけ5箇所**（人間が決めた。NOHARA の注記）。
 *
 * 設計書 §5-3 は4場面（おうち・そと・うみ・のはら）だが、
 * **のうじょう を足して5場面にしたのは人間の判断**（2026-09-05）。
 * 隠れ場所は §5-3 のとおり、どの場面も**必ず4箇所**にしてある。
 *
 * **画面上の切替バーはまだ無い**（§12 Phase 6）。のはらを見るには
 * `__peekaboo.setScene('nohara')` を使う。
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

import type { SceneConfig } from "../types";

/**
 * 隠れ場所の当たり半径の**上限**（CSS px）。設計書 §7-3 の既定値。
 * 実際にはここまで使えないことのほうが多い（上のコメント参照）。
 */
const HIT_RADIUS_PX = 120;

const OUCHI: SceneConfig = {
  id: "ouchi",
  label: "おうち",
  mode: "hideout",
  // 素材はまだ1つも無い。null なら手続き生成に落ちる（不変条件7）
  backgroundUrl: null,
  ambientSound: null,
  spots: [
    {
      id: "hako",
      kind: "box",
      position: [-1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      // 1体だけ。同じ場所から別の動物が出る仕掛け（§6-2）は Phase 7
      animals: ["neko"],
    },
    {
      id: "kaaten",
      kind: "curtain",
      position: [1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["kotori"],
    },
    {
      id: "huton",
      kind: "blanket",
      position: [-1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["nezumi"],
    },
    {
      id: "tobira",
      kind: "door",
      position: [1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["inu"],
    },
  ],
};

/**
 * のはら（モードB「おいかけっこ」/ §4-5）。
 *
 * ------------------------------------------------------------------------
 * **ここだけ隠れ場所が5箇所。人間が決めた**（2026-09-05）。
 *
 * 設計書 §5-3 は「4箇所より多くしない。6つにすると1つあたりが小さくなり、
 * 押しにくくなる」としている。5箇所にすると実際に当たり判定は縮む:
 *
 *   4箇所（2×2）        いちばん近い組 204.8px → 実効半径 101.4px
 *   5箇所（4隅＋中央）  いちばん近い組 182.1px → 実効半径  90.1px
 *
 * 11% 小さくなるが、指の当たる大きさ（およそ 45px）よりは十分大きい。
 * **4隅を外へ広げてある**のはこのため。いまの 2×2 の座標のまま中央に
 * 足すと 159.6px（実効 78.8px）まで落ちた。
 *
 * モードBは「どこへ行ったかを追う」遊びなので、行き先が1つ増えるほど
 * 追いがいがある。**モードAの4場面は 4箇所のまま**にしてある。
 *
 * **4箇所とも同じ「くさむら」にしてある。** 手抜きではなく、
 * 形が何種類もあると移動先ではなく形のほうを見てしまうため（§5-3）。
 *
 * **`animals` は全部 空配列。** 誰がどこに居るかは実行時に決まる（§5-1）。
 * うさぎが居ない4箇所も**当たり判定はそのまま持つ**。
 * 空だからと判定を外すと、この場面でいちばん多い操作
 * （5回に4回は空振り）が無反応になる（不変条件3b / §4-6）。
 * ------------------------------------------------------------------------
 */
const NOHARA: SceneConfig = {
  id: "nohara",
  label: "のはら",
  mode: "chase",
  backgroundUrl: null,
  ambientSound: null,
  runner: "usagi",
  spots: [
    {
      id: "kusa1",
      kind: "bush",
      position: [-1.28, 1.75, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: [],
    },
    {
      id: "kusa2",
      kind: "bush",
      position: [1.28, 1.75, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: [],
    },
    {
      id: "kusa3",
      kind: "bush",
      position: [0, 0.15, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: [],
    },
    {
      id: "kusa4",
      kind: "bush",
      position: [-1.28, -1.45, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: [],
    },
    {
      id: "kusa5",
      kind: "bush",
      position: [1.28, -1.45, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: [],
    },
  ],
};

/**
 * そと（モードA / §5-3）。
 * くさむら・いわ・きのほら・うえきばち に、かえる・りす・はりねずみ・ちょうちょ。
 *
 * ヒントは 足・尻尾・鼻先・羽 で全部違う（§4-2）。
 */
const SOTO: SceneConfig = {
  id: "soto",
  label: "そと",
  mode: "hideout",
  backgroundUrl: null,
  ambientSound: null,
  spots: [
    {
      id: "kusa",
      kind: "bush",
      position: [-1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["kaeru"],
    },
    {
      id: "iwa",
      kind: "rock",
      position: [1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["risu"],
    },
    {
      id: "hora",
      kind: "hollow",
      position: [-1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["harinezumi"],
    },
    {
      id: "hachi",
      kind: "pot",
      position: [1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["chocho"],
    },
  ],
};

/**
 * うみ（モードA / §5-3）。
 * いわ・すいめん・かいそう・つぼ に、クマノミ・たこ・かに・ぺんぎん。
 *
 * **かいそうは くさむら（`bush`）で作っている。**
 * `SpotKind`（§5-1）に「かいそう」が無いため。緑の房が水中で揺れるので
 * 見た目の違和感は小さい。Phase 9 で .glb に差し替えるときに分ける。
 *
 * すいめん（`water`）だけは**開くのではなく水位が下がる**。
 * 4箇所とも同じ動きだと、どこを押しても同じに見えてしまう。
 */
const UMI: SceneConfig = {
  id: "umi",
  label: "うみ",
  mode: "hideout",
  backgroundUrl: null,
  ambientSound: null,
  spots: [
    {
      id: "suimen",
      kind: "water",
      position: [-1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["kumanomi"],
    },
    {
      id: "kaisou",
      kind: "bush",
      position: [1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["tako"],
    },
    {
      id: "umiiwa",
      kind: "rock",
      position: [-1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["kani"],
    },
    {
      id: "tsubo",
      kind: "pot",
      position: [1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["pengin"],
    },
  ],
};

/**
 * のうじょう（モードA）。
 *
 * 設計書 §5-3 には無い5場面目。**人間が足すと決めた**（2026-09-05）。
 * うし・ぶた・ひつじ・にわとり は、1歳半でも輪郭で見分けやすく、
 * ほかの場面の動物（けもの4体・とり2体）とも混ざらない。
 */
const NOUJOU: SceneConfig = {
  id: "noujou",
  label: "のうじょう",
  mode: "hideout",
  backgroundUrl: null,
  ambientSound: null,
  spots: [
    {
      id: "koya",
      kind: "door",
      position: [-1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["ushi"],
    },
    {
      id: "wara",
      kind: "bush",
      position: [1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["buta"],
    },
    {
      id: "saku",
      kind: "rock",
      position: [-1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["hitsuji"],
    },
    {
      id: "okego",
      kind: "pot",
      position: [1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["niwatori"],
    },
  ],
};

const DOBUTSUEN: SceneConfig = {
  id: "dobutsuen",
  label: "どうぶつえん",
  mode: "hideout",
  backgroundUrl: null,
  ambientSound: null,
  spots: [
    {
      id: "iwaba",
      kind: "rock",
      position: [-1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["raion"],
    },
    {
      id: "kigearth",
      kind: "hollow",
      position: [1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["zou"],
    },
    {
      id: "takaki",
      kind: "bush",
      position: [-1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["kirin"],
    },
    {
      id: "hachi",
      kind: "pot",
      position: [1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["saru"],
    },
  ],
};

const KYORYU: SceneConfig = {
  id: "kyoryu",
  label: "きょうりゅう",
  mode: "hideout",
  backgroundUrl: null,
  ambientSound: null,
  spots: [
    {
      id: "ooiwa",
      kind: "rock",
      position: [-1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["tirano"],
    },
    {
      id: "shida",
      kind: "bush",
      position: [1.15, 1.55, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["torikera"],
    },
    {
      id: "kikabu",
      kind: "hollow",
      position: [-1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["sutego"],
    },
    {
      id: "tamago",
      kind: "pot",
      position: [1.15, -1.2, 0],
      scale: 1.0,
      hitRadiusPx: HIT_RADIUS_PX,
      animals: ["putera"],
    },
  ],
};

export const SCENES: readonly SceneConfig[] = [
  OUCHI,
  SOTO,
  UMI,
  NOUJOU,
  DOBUTSUEN,
  KYORYU,
  NOHARA,
];

export const DEFAULT_SCENE_ID = OUCHI.id;

/** id から引く。無ければ最初の場面（起動しないよりまし。不変条件7） */
export function findScene(id: string): SceneConfig {
  return SCENES.find((s) => s.id === id) ?? OUCHI;
}
