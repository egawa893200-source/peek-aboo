/**
 * 隠れ場所の手続き生成（設計書 §9 / 不変条件7）
 *
 * `public/` が空でも動くように、はこ・カーテン・ふとん・とびら（おうち）と
 * くさむら（のはら）を、箱と球と円錐だけで組み立てる。
 * Blender の .glb に差し替えるのは Phase 9。
 *
 * ------------------------------------------------------------------------
 * **どの形も同じ約束で作ってある。** ここを揃えておかないと
 * `AnimalSystem` が隠れ場所ごとに分岐だらけになる。
 *
 *  - 原点は隠れ場所の**中心**（`SpotConfig.position` がここに来る）
 *  - `coverTopY` … 動物を隠している板の**上端**。動物はこの線より下に隠れ、
 *                  §4-2 のヒント（尻尾・耳）だけがこの線より上に出る
 *  - `animalZ`   … 動物を置く z。**必ず前板より奥**。
 *                  ここを間違えると動物が板を突き抜けて「隠れていない」になる
 *  - `mouthWidth`… 開口部の幅。動物の幅がこれを超えると、はみ出して見える
 *
 *  - `hintZ`     … §4-2 のヒントを置く z。**必ず前板より手前**。
 *                  奥に置くと、上段の隠れ場所（カメラより上にある）で
 *                  ふたやレールに隠れて1画素も見えなくなる
 *
 * **隠れ場所に穴を空けて中を見せないこと。** 不変条件3（隠れていても体の一部が
 * 見えている）を満たすのはヒントの役目で、隙間の役目ではない。
 * カーテンの中央を 0.10 空けていたときは、そこから体が縦一直線に丸見えだった。
 * ------------------------------------------------------------------------
 */

import * as THREE from 'three';

import type { SpotKind } from '../types';

/**
 * three のリソースを1つ残らず捨てる（不変条件8）。
 *
 * 場面を捨てるときに geometry / material / texture を1つでも漏らすと、
 * 切替のたびに増えていく。みずのなかでは実際にそうなった。
 *
 * **ここに置いてあるのは、`SpotShapes` がこの階層でいちばん下の
 * モジュールだから**（ここから上へ import すると循環する）。
 */
export function disposeObject3D(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((obj) => {
    const mesh = obj as Partial<THREE.Mesh>;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) materials.add(m);
    } else if (mat) {
      materials.add(mat);
    }
  });

  for (const g of geometries) g.dispose();
  for (const m of materials) {
    // マテリアルが抱えているテクスチャも捨てる。
    // material.dispose() はテクスチャまでは面倒を見てくれない。
    for (const value of Object.values(m as unknown as Record<string, unknown>)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    m.dispose();
  }
  root.removeFromParent();
}

/** 隠れ場所1つぶんの見た目 */
export interface SpotShape {
  readonly group: THREE.Group;
  /** 動物を隠している板の上端（group ローカル座標） */
  readonly coverTopY: number;
  /**
   * 隠している板の**下端**（group ローカル座標）。
   *
   * ここより下に動物がはみ出すと、**隠れ場所の下から体が見える**。
   * 上端しか見ていなかったせいで、うさぎ（体高 1.38）を
   * くさむら（当時 1.05）に入れたときに、下から白い体が飛び出していた。
   * 縁より上の量は正しかったので、**数値のテストは通っていた**。
   * いまは `tests/unit/safety.test.ts` が下側もはみ出しを測る。
   */
  readonly coverBottomY: number;
  /** 開口部の幅。動物の幅はこれより狭くないと、隠れきらない（§4-2） */
  readonly mouthWidth: number;
  /** 動物を置く z（group ローカル座標）。必ず前板より奥 */
  readonly animalZ: number;
  /**
   * §4-2 のヒント（尻尾・耳）を置く z。**必ず前板より手前**。
   *
   * ここを動物と同じ z（前板の奥）に置くと、**縁より上に出ていても見えない**。
   * 上段の隠れ場所はカメラ（y=0.3）より上にあるので下から見上げる形になり、
   * ふたやレールがその後ろを丸ごと隠す。
   * 実際にそうなっていて、はこ（ねこの尻尾）とカーテンでヒントが1画素も
   * 見えていなかった。**数値のテストは通っていた**（高さは足りていたため）。
   * いまは `tests/unit/safety.test.ts` がカメラからレイを飛ばして遮蔽を見る。
   */
  readonly hintZ: number;
  /**
   * 開き具合 0..1。
   * 0 = 閉じている（それでも完全な密閉にはしていない）／1 = 開ききり。
   */
  setOpen(t: number): void;
  /**
   * 揺れ（ラジアン）。§4-2 のヒントの揺れと、§4-3 の「ぷるっ」の両方に使う。
   * **明滅ではなく動きにしてあるのは不変条件6 のため。**
   */
  setWobble(radians: number): void;
  dispose(): void;
}

/* -------------------------------------------------------------------------
 * 寸法。4種類で共通にしてある。
 *
 * 幅 1.35 は「Pixel 7 縦（412px）で 132px ほどに写る」ところから決めた。
 * 当たり半径（実効 111px）より見た目が小さいと、縁を押しても反応するので
 * 「押した場所と反応した場所がずれている」ようには見えない。
 * ---------------------------------------------------------------------- */
const W = 1.35;
const H = 1.05;
const D = 0.5;
const HALF_W = W / 2;
const HALF_H = H / 2;
const HALF_D = D / 2;

/** 前板の z。動物はこれより奥（`ANIMAL_Z`）に置く */
const FRONT_Z = 0.22;
/** 動物を置く z。前板との間に 0.42 空けてある（体の厚みは 0.42 未満に作る） */
const ANIMAL_Z = -0.2;
/**
 * ヒントを置く z（前板より手前）。
 * はこだけ深いのは、閉じたふたの前端が z = 0.31 まで張り出しているため。
 */
const HINT_Z = 0.36;
const HINT_Z_BOX = 0.44;

/** 板の厚み */
const PLATE = 0.07;

interface Palette {
  body: number;
  cover: number;
  accent: number;
}

/**
 * 隠れ場所の色。
 *
 * **`SpotConfig` に色を持たせていない**のは、色が「データ」ではなく
 * 手続き生成の代役でしかないため。Blender の .glb に差し替えたら
 * この表ごと要らなくなる（§8-5）。
 */
const PALETTES: Record<SpotKind, Palette> = {
  box: { body: 0xc08a52, cover: 0xd8a86b, accent: 0x8c5f33 },
  door: { body: 0xe4d6bd, cover: 0xcbb693, accent: 0x8a7550 },
  curtain: { body: 0x9a3b45, cover: 0xc45361, accent: 0xe0c268 },
  bush: { body: 0x4a8f43, cover: 0x63ad55, accent: 0x35682f },
  rock: { body: 0x7a7f86, cover: 0x969ba3, accent: 0x585d64 },
  water: { body: 0x2f6f96, cover: 0x4a97bf, accent: 0x9fd8ea },
  blanket: { body: 0xdfe6ef, cover: 0x5a86c4, accent: 0x3f6091 },
  hollow: { body: 0x6b4a30, cover: 0x8a6440, accent: 0x3f2c1c },
  pot: { body: 0xc4653f, cover: 0xdc7c53, accent: 0x6f4326 },
};

function standard(color: number, roughness = 0.85): THREE.MeshStandardMaterial {
  // metalness は 0。金属反射は幼児向けの絵に要らないし、
  // 環境マップが無い状態で上げると真っ黒になる。
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.0 });
}

/**
 * 板を1枚。
 *
 * **`name` は必ず付けること。** ヒントの遮蔽を見る単体テストが、
 * 「何が遮ったか」を名前で報告する。無名だと `Mesh` としか出ず、
 * どの板を直せばいいのか分からない。
 */
function plate(
  name: string,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.name = name;
  return mesh;
}

/**
 * 隠れ場所を1つ作る。
 *
 * **未知の `kind` でも必ず何かを返す**（不変条件1／7）。
 * データの打ち間違いで隠れ場所が1つ消えると、そこは「押しても無反応」になる。
 */
export function createSpotShape(kind: SpotKind): SpotShape {
  const palette = PALETTES[kind] ?? PALETTES.box;
  switch (kind) {
    case 'curtain':
      return createCurtain(palette);
    case 'blanket':
      return createBlanket(palette);
    case 'door':
      return createDoor(palette);
    case 'bush':
      return createBush(palette);
    default:
      // rock / water / hollow / pot は今回まだ使わない。
      // 箱で代役を立てて、押しても無反応にはしない
      return createBox(palette);
  }
}

/* --- はこ ---------------------------------------------------------------- */

/**
 * ふたが開く箱。
 *
 * ふたの閉状態を 0.20rad だけ開けてあるのは、そこから尻尾を出すため（不変条件3）。
 * 0 にすると完全な密閉になり、「隠れていることが伝わらない」ではなく
 * 「何も無い箱」に見える。
 */
function createBox(p: Palette): SpotShape {
  const group = new THREE.Group();
  const body = standard(p.body);
  const cover = standard(p.cover);

  group.add(plate('box.front', W, H, PLATE, body, 0, 0, FRONT_Z));
  group.add(plate('box.side.l', PLATE, H, D, body, -HALF_W, 0, 0));
  group.add(plate('box.side.r', PLATE, H, D, body, HALF_W, 0, 0));
  // 奥の板。無いと箱の中が背景に抜けて「穴」に見える
  group.add(plate('box.back', W, H, PLATE, standard(p.accent), 0, 0, -HALF_D - 0.2));

  // ふたは奥の上端を蝶番にする。手前に向かってパタンと開く
  const hinge = new THREE.Group();
  hinge.position.set(0, HALF_H, -HALF_D);
  const lid = plate('box.lid', W + 0.1, PLATE, D + 0.12, cover, 0, 0, (D + 0.12) / 2);
  hinge.add(lid);
  group.add(hinge);

  const CLOSED = -0.2;
  const OPEN = -1.5;

  return {
    group,
    coverTopY: HALF_H,
    mouthWidth: W - PLATE * 2,
    animalZ: ANIMAL_Z,
    coverBottomY: -HALF_H,
    hintZ: HINT_Z_BOX,
    setOpen(t) {
      hinge.rotation.x = CLOSED + (OPEN - CLOSED) * t;
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}

/* --- カーテン ------------------------------------------------------------ */

/**
 * 左右に開くカーテン。
 *
 * **中央に隙間を空けないこと。** 最初は不変条件3 のつもりで 0.10 空けていたが、
 * その隙間から体が縦一直線に丸見えになり、「ばあ！」の驚きが消えていた。
 * 隠れていることを伝えるのはヒント（レールの手前に垂れる足）の役目で、
 * 隠れ場所に穴を開ける役目ではない。
 */
function createCurtain(p: Palette): SpotShape {
  const group = new THREE.Group();
  const cloth = standard(p.cover, 0.95);

  // レール。ここが coverTopY になる
  const railGeo = new THREE.CylinderGeometry(0.045, 0.045, W + 0.24, 8);
  const rail = new THREE.Mesh(railGeo, standard(p.accent, 0.5));
  rail.rotation.z = Math.PI / 2;
  rail.name = 'curtain.rail';
  rail.position.set(0, HALF_H, FRONT_Z);
  group.add(rail);

  // わずかに重ねる。ぴったり突き合わせると継ぎ目に背景が透ける
  const OVERLAP = 0.02;
  const panelW = W / 2 + OVERLAP;
  const closedX = panelW / 2 - OVERLAP;
  // 開ききっても画面の外へ逃げないよう、スライド量は板幅の 0.62 まで。
  // 0.82 だと、右のカーテンの外端がワールド 2.37 まで届き、
  // Pixel 7 縦の画面半幅 2.30 をはみ出して切れて見えた（実測）。
  // これでも内側の端は ±0.44 まで開き、いちばん幅のある動物（いぬ 0.80）が通る
  const openX = closedX + panelW * 0.62;

  const left = plate('curtain.panel.l', panelW, H, 0.05, cloth, -closedX, -0.02, FRONT_Z);
  const right = plate('curtain.panel.r', panelW, H, 0.05, cloth, closedX, -0.02, FRONT_Z);
  group.add(left, right);

  // 奥の壁。カーテンが開いたときに背景が抜けないように
  group.add(plate('curtain.back', W, H, PLATE, standard(p.body, 0.95), 0, 0, -HALF_D - 0.2));

  return {
    group,
    coverTopY: HALF_H,
    mouthWidth: W - 0.1,
    animalZ: ANIMAL_Z,
    coverBottomY: -HALF_H,
    hintZ: HINT_Z,
    setOpen(t) {
      const x = closedX + (openX - closedX) * t;
      left.position.x = -x;
      right.position.x = x;
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}

/* --- ふとん -------------------------------------------------------------- */

/** 手前にめくれる布。上端を蝶番にして、こちら側へ持ち上がる */
function createBlanket(p: Palette): SpotShape {
  const group = new THREE.Group();

  // 敷き布団。布がめくれたときに下に何か無いと、宙に浮いて見える
  group.add(plate('blanket.mattress', W, 0.22, D, standard(p.body, 0.95), 0, -HALF_H + 0.11, 0.02));
  group.add(plate('blanket.back', W, H, PLATE, standard(p.accent, 0.95), 0, 0, -HALF_D - 0.2));

  const hinge = new THREE.Group();
  hinge.position.set(0, HALF_H, FRONT_Z);
  const clothH = H * 0.94;
  const sheet = plate('blanket.sheet', W, clothH, 0.06, standard(p.cover, 0.98), 0, -clothH / 2, 0);
  hinge.add(sheet);
  group.add(hinge);

  const CLOSED = 0.06;
  const OPEN = -1.35;

  return {
    group,
    coverTopY: HALF_H,
    mouthWidth: W - 0.08,
    animalZ: ANIMAL_Z,
    coverBottomY: -HALF_H,
    hintZ: HINT_Z,
    setOpen(t) {
      hinge.rotation.x = CLOSED + (OPEN - CLOSED) * t;
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}

/* --- とびら -------------------------------------------------------------- */

/**
 * 横に開く扉。
 *
 * **鴨居（上の横木）を `coverTopY` から 0.30 上げてある。**
 * ここを詰めると、隠れているときに出しているヒント（耳・鼻先）が
 * 鴨居に隠れて見えなくなり、不変条件3 を静かに破る。
 */
function createDoor(p: Palette): SpotShape {
  const group = new THREE.Group();
  const frame = standard(p.accent);

  const LINTEL_Y = HALF_H + 0.3;
  group.add(plate('door.post.l', 0.09, H + 0.42, 0.14, frame, -HALF_W, 0.16, FRONT_Z - 0.04));
  group.add(plate('door.post.r', 0.09, H + 0.42, 0.14, frame, HALF_W, 0.16, FRONT_Z - 0.04));
  group.add(plate('door.lintel', W + 0.2, 0.09, 0.14, frame, 0, LINTEL_Y, FRONT_Z - 0.04));
  group.add(plate('door.back', W, H, PLATE, standard(p.body, 0.95), 0, 0, -HALF_D - 0.2));

  // 蝶番は左端。手前（+z）に向かって開く
  const hinge = new THREE.Group();
  hinge.position.set(-HALF_W + 0.05, 0, FRONT_Z);
  const panelW = W - 0.06;
  const panel = plate('door.panel', panelW, H, PLATE, standard(p.cover), panelW / 2, 0, 0);
  hinge.add(panel);
  // ノブ。扉だと分かる目印
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), standard(p.accent, 0.4));
  knob.name = 'door.knob';
  knob.position.set(panelW - 0.12, -0.02, PLATE);
  hinge.add(knob);
  group.add(hinge);

  const CLOSED = -0.12;
  const OPEN = -1.45;

  return {
    group,
    coverTopY: HALF_H,
    mouthWidth: panelW,
    animalZ: ANIMAL_Z,
    coverBottomY: -HALF_H,
    hintZ: HINT_Z,
    setOpen(t) {
      hinge.rotation.y = CLOSED + (OPEN - CLOSED) * t;
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}

/* --- くさむら -------------------------------------------------------------- */

/**
 * 左右に分かれる草むら（のはら / §5-3）。
 *
 * **のはらは4箇所とも同じ形にする。** 手抜きではなく、
 * 形が4種類あると移動先ではなく形のほうを見てしまうため（§5-3）。
 * 「どこに入ったか」だけに注意を向けさせたい。
 *
 * 葉の房は左右に開く。カーテンと同じ理屈で、**中央に隙間を空けない**
 * （空けると中の体が丸見えになる）。
 */
function createBush(p: Palette): SpotShape {
  const group = new THREE.Group();
  const leaf = standard(p.cover, 0.95);
  const deep = standard(p.body, 0.95);

  // 奥の茂み。葉が開いたときに背景が抜けないように。
  // **下に深く取る。** うさぎは体高 1.38 あって、箱の高さ 1.05 には収まらない
  const mound = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), deep);
  mound.name = 'bush.mound';
  mound.scale.set(HALF_W * 1.05, HALF_H * 1.55, 0.26);
  mound.position.set(0, -H * 0.24, -HALF_D - 0.1);
  group.add(mound);

  // 前の房。左右2つ。1つを4個の球で作ると、輪郭がぼこぼこして草に見える。
  // いちばん下の球は、うさぎの足元まで隠すためのもの
  const bunches: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const bunch = new THREE.Group();
    const blobs: [number, number, number, number][] = [
      [side * 0.06, -H * 0.56, 0.02, 0.74],
      [0, -H * 0.12, 0, 0.62],
      [side * 0.2, H * 0.16, 0.03, 0.62],
      [side * -0.14, H * 0.2, -0.02, 0.62],
    ];
    for (let i = 0; i < blobs.length; i++) {
      const blob = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), leaf);
      blob.name = `bush.leaf.${side < 0 ? 'l' : 'r'}.${i}`;
      blob.scale.set(HALF_W * 0.42, HALF_H * blobs[i][3], 0.14);
      blob.position.set(blobs[i][0], blobs[i][1], FRONT_Z + blobs[i][2]);
      bunch.add(blob);
    }
    // **中央でしっかり重ねる。** 0.03 しか寄せていなかったときは、
    // 左右の房のあいだに 0.05 ほどの縦の隙間が残り、
    // そこから白いうさぎの体が縦一直線に見えていた（カーテンと同じ失敗）。
    // 房の内側の球（局所 x = 0）が x = 0 を 0.08 またぐところまで寄せる
    bunch.position.x = (side * W) / 4 - side * 0.14;
    group.add(bunch);
    bunches.push(bunch);
  }

  // 手前の株。**開いても動かない。**
  // 左右の房は球なので、下のほうでは横幅がすぼまって中央に隙間が残り、
  // うさぎの足元が1点だけ覗けていた（格子で測って 1/63 点）。
  // ここは動物が出きる高さ（y = 0.39 以上）より下だけを塞ぐので、
  // 出てきたうさぎを隠すことはない
  const skirt = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), leaf);
  skirt.name = 'bush.skirt';
  skirt.scale.set(HALF_W * 0.52, HALF_H * 0.62, 0.15);
  skirt.position.set(0, -H * 0.62, FRONT_Z + 0.05);
  group.add(skirt);

  // 上に伸びる草。ヒント（うさぎの耳）と混ざらないよう、細く短くする
  for (let i = 0; i < 5; i++) {
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.3 + (i % 3) * 0.07, 6), deep);
    blade.name = `bush.blade.${i}`;
    blade.position.set(-HALF_W + 0.22 + i * 0.24, HALF_H - 0.02, FRONT_Z - 0.04);
    blade.rotation.z = (i - 2) * 0.09;
    group.add(blade);
  }

  // 閉じるときに深く重ねたぶん、開くときは多めに逃がす。
  // 開ききったときの内側の端は ±0.37 で、いちばん幅のある動物（うさぎ 0.31）が通る。
  // **0.42 まで開けると、画面端の草むらが横にはみ出して切れる**
  // （Pixel 7 縦の画面半幅 2.30 に対して 2.40 まで届いていた）
  const openX = W * 0.34;

  return {
    group,
    coverTopY: HALF_H,
    // いちばん下の房が届くところ。うさぎの足元（-0.855）より下
    coverBottomY: -H * 0.56 - HALF_H * 0.74,
    mouthWidth: W - 0.12,
    animalZ: ANIMAL_Z,
    hintZ: HINT_Z,
    setOpen(t) {
      // 開くときは横に逃がしつつ、少しだけ倒す。真横に平行移動させると
      // 「草がスライドした」に見えて、かき分けた感じにならない
      for (let i = 0; i < bunches.length; i++) {
        const side = i === 0 ? -1 : 1;
        bunches[i].position.x = (side * W) / 4 - side * 0.14 + side * openX * t;
        bunches[i].rotation.z = -side * 0.5 * t;
      }
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}
