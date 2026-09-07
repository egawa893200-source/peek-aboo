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
export function disposeObject3D(
  root: THREE.Object3D,
  options: { keepTextures?: boolean } = {}
): void {
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
    //
    // **`keepTextures` のときは捨てない。** 絵を貼った動物（CutoutAnimal）の
    // テクスチャは `AssetLoader` が持っていて場面をまたいで使い回すので、
    // ここで捨てると場面を作り直すたびに読み直しになる
    for (const value of options.keepTextures
      ? []
      : Object.values(m as unknown as Record<string, unknown>)) {
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
const W = 1.7;
const H = 1.35;
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
  // §6「残るもの」。**隠れ場所そのものが入れ替わる**（2026-09-07 に人間が決めた）
  egg: { body: 0xf1e3c6, cover: 0xf7efdc, accent: 0xc9a97a },
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
export function createSpotShape(kind: SpotKind, spotY = 0): SpotShape {
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
    case 'rock':
      return createRock(palette, spotY);
    case 'water':
      return createWater(palette);
    case 'hollow':
      return createHollow(palette);
    case 'pot':
      return createPot(palette);
    case 'egg':
      return createEgg(palette);
    default:
      // 未知の形でも、箱で代役を立てて押しても無反応にはしない（不変条件1／7）
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

  // 中央の板。**開いても動かない。**
  // 球を並べただけでは、房と株のあいだに斜めから抜ける隙間が残る
  // （隠れ場所を大きくした 2026-09-07 に、どうぶつえん の たかき で
  //  局所 y = −0.54 に 1点だけ出た）。CLAUDE.md の
  // 「球だけで隠れ場所を作ると必ず隙間ができる。平らな板を1枚重ねて塞ぐ」。
  // **上端は縁ちょうど**なので、出てきた動物は隠さない
  // 上端は縁より 0.25 下。縁ちょうどまで伸ばした版は、出たあとの癖
  // （§6-2 の傾き）で振れた体の下側を隠して、見えている割合が 49% まで
  // 落ちた（判定は 55%）。隙間は縁のずっと下（局所 −0.54）なので、ここで足りる
  const frontTop = HALF_H - 0.25;
  group.add(
    plate('bush.front', W * 0.66, frontTop + H * 0.75, PLATE, leaf, 0, (frontTop - H * 0.75) / 2, FRONT_Z - 0.01)
  );

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
  // 開いたときに半分が逃げる距離。
  // **隠れ場所を大きくした（2026-09-07）ぶん、比率のままでは足りない。**
  // 出きった動物の見えている割合が 53% まで落ちた（判定は 55%）
  const openX = W * 0.42;

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

/**
 * 庇（ひさし）を、見込み角のぶんだけずらす量。
 *
 * ==========================================================================
 * **「縁の高さ」ではなく「縁に見える高さ」に置く。**
 *
 * カメラは (0, 0.3, 7.2) に固定。上の段（y = +2.45）は見上げる形になるので、
 * 手前（z = 0.20）にある板の上端は縁より**高く**見え、出てきた動物の
 * 下半分を隠す（実測で見えている割合が 53% まで落ちた。判定は 55%）。
 * 下の段（y = −1.95）は逆で、見下ろすぶん上端が縁より**低く**見え、
 * 隠れている体が縁の上から覗く（さく で 1点）。
 *
 * 上下で符号が変わるので、隠れ場所の高さから計算する。
 * ==========================================================================
 */
function browShift(spotY: number): number {
  const CAM_Y = 0.3;
  const CAM_Z = 7.2;
  const BROW_Z = FRONT_Z - 0.02;
  /** 庇と、その裏に居る体との奥行きの差 */
  const DEPTH = 0.25;
  return (DEPTH * (spotY + HALF_H - CAM_Y)) / (CAM_Z - BROW_Z);
}

/* --- いわ ------------------------------------------------------------------ */

/**
 * 割れて左右に開く岩。
 *
 * くさむらと同じで**中央に隙間を残さない**。
 * 深さも同じだけ取ってある（背の高い動物が入るため。`coverBottomY` の注記）。
 */
function createRock(p: Palette, spotY: number): SpotShape {
  const group = new THREE.Group();
  const stone = standard(p.cover, 0.95);

  group.add(plate('rock.back', W, H * 1.6, PLATE, standard(p.body, 0.95), 0, -H * 0.2, -HALF_D - 0.1));

  const halves: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const half = new THREE.Group();
    // ごつごつさせる。1個の球だと「たまご」に見えて岩にならない
    const blobs: [number, number, number, number, number][] = [
      [0, -H * 0.5, 0, 0.5, 0.62],
      [side * 0.1, -H * 0.06, 0.02, 0.46, 0.5],
      [side * -0.08, H * 0.28, -0.02, 0.4, 0.42],
    ];
    for (let i = 0; i < blobs.length; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), stone);
      b.name = `rock.chunk.${side < 0 ? 'l' : 'r'}.${i}`;
      b.scale.set(HALF_W * blobs[i][3], HALF_H * blobs[i][4], 0.15);
      b.position.set(blobs[i][0], blobs[i][1], FRONT_Z + blobs[i][2]);
      b.rotation.z = (i - 1) * 0.2 * side;
      half.add(b);
    }
    // 内側の板。**球だけでは中央が塞げない。**
    // 球は上下で横幅がすぼまるので、上下の球のあいだに菱形の隙間が残り、
    // そこから体が覗いた（実測: 世界座標 x=1.15 / y=1.33 あたりで 4点）。
    // 左右の板を中央で 0.72 ぶん重ねて、縁から下を隙間なく覆う。
    // 開くときは半分と一緒に逃げるので、出てきた体は隠さない
    // 幅は隠れ場所いっぱいまで取る。動物のいちばん広いところ（かに 1.22）が
    // 板からはみ出して、外側の縁で覗けていた（局所 x = ±0.41〜0.49）。
    // **開いても、この板は動物を隠さない。** 板の上端は局所 0.30 で、
    // 出きった動物の足元（0.44 以上）より下にあるため
    const slab = plate(
      `rock.slab.${side < 0 ? 'l' : 'r'}`,
      W * 1.1,
      H * 1.1,
      0.12,
      stone,
      -side * 0.16,
      -H * 0.26,
      FRONT_Z - 0.05
    );
    half.add(slab);

    half.position.x = (side * W) / 4 - side * 0.15;
    group.add(half);
    halves.push(half);
  }

  // 庇（ひさし）。**動かない。**
  //
  // 球だけで作ると、縁のあたりで横幅がすぼまって中央に隙間ができ、
  // そこから頭が覗いた（格子 225点で 4〜63点。いわを使う3場面すべてで出た）。
  // 動く半分に平らな板を足しても、開いたときに一緒に逃げてしまい、
  // 今度は出てきた体を隠してしまう。**縁のすぐ下だけを固定で覆う**のが正解。
  // 上端は coverTopY ちょうど。ヒント（z = 0.36）はこの板より手前を通る
  //
  // **上端は「縁の高さ」ではなく「縁に見える高さ」に置く。**
  // 上の段（y = +2.45）はカメラ（y = 0.3）より上にあるので見上げる形になり、
  // 手前（z = 0.20）にある板の上端は、縁より高い位置に見える。
  // 上端をちょうど縁に合わせた版では、出てきた動物の下半分が庇に隠れて
  // 見えている割合が 53% まで落ちた（判定は 55%）。
  // 見込み角ぶん（0.10）下げる
  const brow = plate(
    'rock.brow',
    W + 0.05,
    HALF_H * 0.43,
    0.24,
    stone,
    0,
    HALF_H * 0.785 - browShift(spotY),
    FRONT_Z - 0.02
  );
  group.add(brow);

  const openX = W * 0.36;

  return {
    group,
    coverTopY: HALF_H,
    coverBottomY: -H * 0.5 - HALF_H * 0.62,
    mouthWidth: W - 0.14,
    animalZ: ANIMAL_Z,
    hintZ: HINT_Z,
    setOpen(t) {
      for (let i = 0; i < halves.length; i++) {
        const side = i === 0 ? -1 : 1;
        halves[i].position.x = (side * W) / 4 - side * 0.15 + side * openX * t;
        halves[i].rotation.z = -side * 0.3 * t;
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

/* --- すいめん -------------------------------------------------------------- */

/**
 * 水面。**開く板ではなく、下がる水**。
 *
 * ほかの形は横に逃げるか上に開くが、ここだけは水位が下がって
 * 中身が現れる。うみの4箇所を全部「開く」にすると単調になるので、
 * 1つだけ違う動きにしてある。
 */
function createWater(p: Palette): SpotShape {
  const group = new THREE.Group();

  group.add(plate('water.back', W, H * 1.7, PLATE, standard(p.body, 0.95), 0, -H * 0.25, -HALF_D - 0.1));

  // 水。**底を固定して、水位だけを下げる。**
  //
  // 最初は水の塊ごと下へ動かしていたが、下がりきったときに
  // **下の段の隠れ場所まで水柱が伸びて、そこに居るかにを丸ごと覆っていた**
  // （水柱が世界座標 y = -0.71 まで届いていた。かには -0.72〜-0.07）。
  // 隠れ場所は 2.75 おきに並んでいるので、どの部品も自分の枠
  // （±1.375）から出してはいけない。
  // 底を原点にして y だけ縮めれば、水が引くようにも見えて枠からも出ない
  const WATER_H = HALF_H - -H * 0.95; // 底（coverBottomY）から縁まで
  const surface = new THREE.Group();
  const body = plate('water.body', W, WATER_H, 0.16, standard(p.cover, 0.4), 0, WATER_H / 2, FRONT_Z);
  surface.add(body);
  // 波の縁。まっすぐな板だと「青い箱」に見える
  for (let i = 0; i < 5; i++) {
    const crest = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), standard(p.accent, 0.35));
    crest.name = `water.crest.${i}`;
    crest.scale.set(W * 0.14, 0.05, 0.09);
    crest.position.set(-HALF_W + 0.16 + (i * (W - 0.32)) / 4, WATER_H, FRONT_Z + 0.04);
    surface.add(crest);
  }
  surface.position.y = -H * 0.95;
  group.add(surface);

  return {
    group,
    coverTopY: HALF_H,
    coverBottomY: -H * 0.95,
    mouthWidth: W - 0.06,
    animalZ: ANIMAL_Z,
    hintZ: HINT_Z,
    setOpen(t) {
      // 水位が下がる。**横には動かさない。** 底は固定したまま縮める。
      // 0.28 まで引けば、出きった動物（局所 0.44 以上）は完全に出る
      surface.scale.y = 1 - 0.72 * t;
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}

/* --- きのほら -------------------------------------------------------------- */

/**
 * 木の洞。**観音開き**で開く。
 *
 * 最初は上下の唇が開く形にしていたが、上の唇が上がりきっても
 * 出てきた動物の高さ（局所 0.46〜1.10）に重なって、**はりねずみが
 * 一度も見えなかった**。上へ逃がすには枠（±1.375）を越える必要があり、
 * 縦に開く形そのものが成り立たない。
 * 横に開くのは いわ・くさむら と同じだが、**軸で回る**ので動きは違って見える。
 */
function createHollow(p: Palette): SpotShape {
  const group = new THREE.Group();
  const bark = standard(p.body, 0.95);

  // 幹。洞の左右に太く
  group.add(plate('hollow.trunk.l', 0.24, H * 2.0, D, bark, -HALF_W - 0.1, -H * 0.2, 0));
  group.add(plate('hollow.trunk.r', 0.24, H * 2.0, D, bark, HALF_W + 0.1, -H * 0.2, 0));
  group.add(
    plate('hollow.back', W + 0.4, H * 2.0, PLATE, standard(p.accent, 0.95), 0, -H * 0.2, -HALF_D - 0.15)
  );

  const doors: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    // 蝶番は外側の縁。中央で 0.2 ほど重ねて隙間を作らない
    const pivot = new THREE.Group();
    pivot.position.set(side * HALF_W, -H * 0.24, FRONT_Z);
    const panel = plate(
      side < 0 ? 'hollow.door.l' : 'hollow.door.r',
      HALF_W * 1.18,
      H * 1.62,
      0.1,
      standard(p.cover, 0.9),
      -side * HALF_W * 0.59,
      0,
      0
    );
    pivot.add(panel);
    group.add(pivot);
    doors.push(pivot);
  }

  return {
    group,
    coverTopY: HALF_H,
    coverBottomY: -H * 0.24 - H * 0.81,
    mouthWidth: W - 0.1,
    animalZ: ANIMAL_Z,
    hintZ: HINT_Z,
    setOpen(t) {
      // 手前に向かって開く。左右で回る向きが逆
      doors[0].rotation.y = 1.45 * t;
      doors[1].rotation.y = -1.45 * t;
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}

/* --- うえきばち ------------------------------------------------------------ */

/** 植木鉢。生えている葉が left/right に開いて、中から出てくる */
function createPot(p: Palette): SpotShape {
  const group = new THREE.Group();

  // 鉢。**手前に置いて、動物の足元を隠す**（下からのはみ出し対策）
  // 鉢は高めに取る。低いと鉢の口と葉のあいだに帯が空いて、
  // そこから体が覗く（にわとりの胴で 1点だけ残っていた）
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(HALF_W * 0.9, HALF_W * 0.64, H * 0.86, 14));
  pot.material = standard(p.body, 0.9);
  pot.name = 'pot.body';
  pot.position.set(0, -H * 0.55, FRONT_Z - 0.02);
  group.add(pot);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(HALF_W * 0.96, HALF_W * 0.96, 0.12, 14));
  rim.material = standard(p.accent, 0.9);
  rim.name = 'pot.rim';
  rim.position.set(0, -H * 0.12, FRONT_Z - 0.02);
  group.add(rim);
  group.add(plate('pot.back', W, H * 1.6, PLATE, standard(p.accent, 0.95), 0, -H * 0.2, -HALF_D - 0.1));

  // 葉。鉢から上に生えて、開くと左右に倒れる
  const leaves: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const leaf = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), standard(p.cover, 0.95));
      blade.name = `pot.leaf.${side < 0 ? 'l' : 'r'}.${i}`;
      blade.scale.set(HALF_W * 0.3, HALF_H * (0.66 - i * 0.1), 0.1);
      blade.position.set(side * i * 0.12, H * (0.02 + i * 0.16), FRONT_Z + 0.02);
      blade.rotation.z = side * (0.1 + i * 0.22);
      leaf.add(blade);
    }
    leaf.position.x = side * 0.12;
    group.add(leaf);
    leaves.push(leaf);
  }

  // 中央の葉。**動かない。**
  // 左右の葉は外へ倒れて開くので、閉じていても中央の上のほうに
  // 隙間が残り、そこから体が覗いた（局所 y = 0.30〜0.44 で 5〜8点）。
  // 出きった動物の足元は局所 0.44 以上なので、この葉は邪魔しない
  const middle = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), standard(p.cover, 0.95));
  middle.name = 'pot.leaf.mid';
  middle.scale.set(HALF_W * 0.5, HALF_H * 0.72, 0.1);
  middle.position.set(0, H * 0.16, FRONT_Z - 0.03);
  group.add(middle);

  return {
    group,
    coverTopY: HALF_H,
    // 鉢の底まで。動物の足は鉢の中に隠れる
    coverBottomY: -H * 0.55 - H * 0.43,
    // **葉が実際に覆っている幅にする。**
    // `W - 0.2` は鉢の口の幅で、葉はそこまで届いていない。
    // 隠れ場所を大きくした（2026-09-07）とき、そのぶん動物も大きくなって
    // 葉の外へ体がはみ出した（そと の はち で 6点、きょうりゅう の たまご で 2点）
    mouthWidth: W * 0.76,
    animalZ: ANIMAL_Z,
    hintZ: HINT_Z,
    setOpen(t) {
      for (let i = 0; i < leaves.length; i++) {
        const side = i === 0 ? -1 : 1;
        leaves[i].position.x = side * (0.12 + W * 0.3 * t);
        leaves[i].rotation.z = side * 0.7 * t;
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

/* --- たまご（§6 の「残るもの」）------------------------------------------- */

/**
 * たまご。**上半分が横に倒れて開く。**
 *
 * ==========================================================================
 * 2026-09-07 に人間が決めた形。
 * はじめは「引っ込んだあとに小さな卵が残る」だけにしていたが、実機で
 * 「卵が小さく残っているが何にも意味がない。卵になった場合は隠れ場所ごと
 * 無くして卵を新たな隠れ場所として設定するほうがいい」と言われた。
 *
 * **縦に開かないこと。** きのほらを上下の唇が開く形にしたとき、
 * 上の唇が上がりきっても出てきた動物に重なって、はりねずみが一度も
 * 見えなかった（CLAUDE.md の実測）。ここでは上半分を**横に倒す**。
 *
 * **球だけで作らないこと。** 球は上下で横幅がすぼまるので、
 * 縁のあたりに菱形の隙間が残る。平らな板を1枚重ねて塞ぐ。
 * ==========================================================================
 */
function createEgg(p: Palette): SpotShape {
  const group = new THREE.Group();

  const RX = HALF_W * 0.94;
  /** 割れ目（ここが縁。ほかの隠れ場所と同じ高さに合わせる） */
  const CRACK_Y = HALF_H;
  /** 下半分の深さ。ほかの隠れ場所と同じくらいの「部屋」を作る */
  const LOWER = 1.575;
  const RZ = D * 0.36;

  // 殻の下半分。**これが前板を兼ねる。**
  //
  // はじめは「奥に沈めた楕円体 ＋ 四角い前板」で作ったが、実機で
  // 「たまごの前にドアがあって変わらず見づらい」と言われた（2026-09-07）。
  // 四角い板の角が、殻とは別のものに見えていた。
  //
  // **横に広く、奥行きは薄く。** 下半球を縁に合わせて置くと、
  // いちばん太いところ（赤道）が縁に来るので、横は開口部を覆いきり、
  // 奥行きは薄いので出てきた動物の前に張り出さない
  // （厚い版では殻が動物に掛かって、見えている割合が 68% まで落ちた）。
  // 前面の z は、ほかの隠れ場所の前板と同じ 0.22 にそろえてある
  const lower = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    standard(p.body, 0.9)
  );
  lower.name = 'egg.lower';
  lower.scale.set(RX, LOWER, RZ);
  lower.position.set(0, CRACK_Y, FRONT_Z - RZ);
  group.add(lower);

  // 背板。奥からの抜けを塞ぐ。
  //
  // **四角い板にしないこと。** 殻からはみ出した角が「たまごの後ろに
  // 板が置いてある」ように見えた（2026-09-07 に実機で指摘）。
  // 殻と同じ形（下半分の楕円）を、ひとまわり小さく作って隠す
  const back = new THREE.Mesh(
    new THREE.CircleGeometry(1, 20, Math.PI, Math.PI),
    standard(p.body, 0.95)
  );
  back.name = 'egg.back';
  back.scale.set(RX * 0.98, LOWER * 0.98, 1);
  back.position.set(0, CRACK_Y, -HALF_D - 0.1);
  group.add(back);

  // まだら。無地だと石に見えた。**殻の表面に沿って置く**
  for (const [x, y, r] of [
    [-0.3, -0.22, 0.12],
    [0.24, -0.6, 0.1],
    [0.06, -0.95, 0.08],
  ] as const) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), standard(p.accent, 0.95));
    dot.name = 'egg.dot';
    dot.scale.z = 0.2;
    dot.position.set(x, CRACK_Y + y, FRONT_Z - 0.01);
    group.add(dot);
  }

  // 上半分（ふた）。**横に倒れて開く**
  const capPivot = new THREE.Group();
  capPivot.position.set(-RX * 0.87, CRACK_Y, 0.0);
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    standard(p.cover, 0.9)
  );
  cap.name = 'egg.cap';
  // **胴と同じ幅にする。** 広いと「たまご」ではなく「きのこ」に見えた
  cap.scale.set(RX * 0.87, H * 0.6, RZ);
  cap.position.set(RX * 0.87, 0, 0);
  capPivot.add(cap);
  group.add(capPivot);

  return {
    group,
    coverTopY: CRACK_Y,
    coverBottomY: CRACK_Y - LOWER,
    mouthWidth: RX * 1.72,
    animalZ: ANIMAL_Z,
    hintZ: HINT_Z,
    setOpen(t) {
      // 左の縁を軸に、外へ倒す。**上へは逃がさない**（動物に重なる）。
      // 1.35rad ＋ 0.34 では、出てきた動物にふたが掛かって
      // 体の見えている割合が 54% まで落ちた（判定は 55%）
      capPivot.rotation.z = t * 1.9;
      capPivot.position.x = -RX * 0.87 - t * 0.52;
      capPivot.position.y = CRACK_Y + t * 0.06;
    },
    setWobble(r) {
      group.rotation.z = r;
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}
