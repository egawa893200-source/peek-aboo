/**
 * 動物の手続き生成（設計書 §9 / 不変条件7）
 *
 * `public/` が空でも動くように、球・円錐・箱だけで作る。
 * .glb に差し替えるのは Phase 9（§8-5「先に手続き生成で全部動かしてから」）。
 *
 * ==========================================================================
 * **輪郭で見分けがつくこと**が、色より優先（§5-2）。
 * みずのなかでは体型を指定しなかったせいで、チョウチョウウオもメダカも
 * 同じ魚になった。
 *
 * **`id` で分岐を書かないこと。** 5体のうちは switch で足りていたが、
 * 17体になった時点で分岐が「顔」「頭の上」「尾」の3箇所に散り、
 * 新しい動物を足したときに1箇所だけ入れ忘れる形になった。
 * いまは `AnimalConfig` の
 *
 *   bodyPlan … 体の作り（けもの／とり／さかな／たこ／かに／むし／かえる）
 *   headTop  … 頭の上（三角の耳・垂れ耳・丸い耳・長い耳・房・角・とさか・触角）
 *   snout    … 顔の前（鼻づら・とがった鼻・くちばし・平たい鼻・大きな口）
 *   tail     … 後ろ（細い・ふさふさ・丸い・尾羽・くるり）
 *   coat     … 表面（とげ・もこもこ・しま・ぶち）
 *
 * だけで形が決まる。**データを見れば輪郭が分かる**のが狙い。
 * ==========================================================================
 *
 * 約束:
 *  - 原点は**足元**（y = 0 が体の底）。`height` は頭の上まで含めた高さ
 *  - +z が正面。ただし `fish` だけは横向き（正面から見た魚は魚に見えない）
 *  - `hint` は隠れているときに縁から出す部分（§4-2）。
 *    **体とは別の枝**にしてあるので、体を完全に隠したままヒントだけ出せる。
 *    顔が見えていたら「ばあ！」が驚きにならない
 *  - **目は必ず付ける**（§9）。1歳半に効くのは顔と目が見えていることだけ
 */

import * as THREE from 'three';

import type { AnimalConfig, BodyPlan, HeadTop, HintPart, Snout, TailShape } from '../types';
import { disposeObject3D } from './SpotShapes';

/**
 * 隠れているとき、体長の何割を縁から出すか（§4-2 は 15〜25%）。
 *
 * **ここは「生やす長さ」で、画面に出る量ではない。**
 * `AnimalSystem.HIDDEN_SINK`（0.06）ぶん体ごと沈めるので、
 * 実際に縁から出るのはそのぶん短くなる。体の高さで割った実測値は
 * 0.20〜0.24 に収まり、§4-2 の 15〜25% の範囲に入る。
 * **上げすぎないこと。** ヒントの先端（鼻先・足）は少しはみ出すので、
 * 0.30 にすると小さい動物で 25% を超える。
 */
export const HINT_EXPOSURE = 0.27;

export interface ProceduralAnimal {
  readonly group: THREE.Group;
  /** 足元から頭の上まで（`hint` は含まない） */
  readonly height: number;
  /** いちばん広いところの幅。隠れ場所の `mouthWidth` と比べる（§4-2） */
  readonly width: number;
  /** 体の厚み。隠れ場所の前板とぶつからないことを確かめる */
  readonly depth: number;
  /** 視線を向ける先（§4-4「出きったらカメラの方を向く」） */
  readonly head: THREE.Object3D;
  /**
   * 視線をどれだけ効かせるか 0..1。
   * さかな・かに・たこは**横向き／真上向き**に作ってあるので、
   * カメラを正面から見せると輪郭が崩れる。浅くしか向かせない。
   */
  readonly gazeStrength: number;
  /** 隠れているときに縁から出る部分（§4-2） */
  readonly hint: THREE.Object3D;
  /** `hint` の高さ。`height` の HINT_EXPOSURE 倍にしてある */
  readonly hintHeight: number;
  /** 登場の山で一瞬だけ明るくする（§4-4）。加算ではなく emissive を上げる */
  setGlow(amount: number): void;
  dispose(): void;
}

/**
 * 球の分割数。
 *
 * 16×12 だと1体あたり 384三角形 ×12パーツ ＝ 4,600三角形になり、
 * 4体で 18,000 を超えた。12×8（192三角形）に落としても
 * **輪郭は目で見て変わらない**（球はもともと丸いので、
 * シルエットに効くのは分割数ではなく縦横比のほう）。
 */
const SEG_W = 12;
const SEG_H = 8;

/** 動物1体ぶんのマテリアル。パーツごとに作らず、ここから配る */
interface Palette {
  skin: THREE.MeshStandardMaterial;
  belly: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  /** 足・くちばし・とさかなど、体色と分けたい暖色。**暗い色で作らないこと** */
  warm: THREE.MeshStandardMaterial;
  glint: THREE.MeshBasicMaterial;
}

function standard(color: THREE.ColorRepresentation, roughness = 0.8): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.0 });
}

function ball(mat: THREE.Material, r = 1): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, SEG_W, SEG_H), mat);
}

function cone(mat: THREE.Material, r: number, h: number, seg = 8): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat);
}

function tube(mat: THREE.Material, r: number, h: number, seg = 8): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
}

/** 平たい板。ひれ・羽・尾羽に使う */
function fin(mat: THREE.Material, w: number, h: number, d = 0.03): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

/**
 * 動物を1体作る。
 *
 * **`bodyPlan` などを指定していない `AnimalConfig` でも落とさない**（不変条件7）。
 * その場合はけものとして、耳も鼻も尾も無い塊になる。
 * 見分けはつかないが、アプリは動く。
 */
export function createProceduralAnimal(cfg: AnimalConfig): ProceduralAnimal {
  const group = new THREE.Group();

  const bodyH = cfg.bodyHeight ?? 0.9;
  const bodyW = cfg.bodyWidth ?? 0.66;
  // 厚みは幅より少し薄く。隠れ場所の前板（z = 0.22）と
  // 動物の置き場（z = -0.20）の間は 0.42 しかないので、ここを超えると突き抜ける
  const bodyD = Math.min(bodyW * 0.92, 0.4);

  const p: Palette = {
    skin: standard(cfg.color),
    belly: standard(cfg.bellyColor),
    dark: standard('#20242c', 0.45),
    // **暗い色で作らないこと。** 背景（#12203a）とほぼ同じ明るさだと、
    // 遮蔽が無いのに画面上では見えない（ことりの足で実際にそうなった）
    warm: standard('#f2a93b', 0.55),
    glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };

  const plan: BodyPlan = cfg.bodyPlan ?? 'mammal';
  const built = buildBody(plan, cfg, p, bodyH, bodyW, bodyD);

  // --- ヒント（§4-2） -----------------------------------------------------
  // 体のてっぺんに生やす。体は縁の下に沈めたまま、ここだけを縁の上に出す。
  group.add(built.root);

  // **底を必ず y = 0 に揃える。**
  // 「原点は足元」は約束にしていたが、体の作りごとに手で合わせていたので
  // かに（+0.082）・さかな（+0.046）・たこ（-0.027）でずれていた。
  // ずれたぶんだけ隠れ場所の縁から頭が出る（かにで実測 0.043）。
  // 各 build 関数に気をつけさせるのではなく、ここで機械的に揃える
  _box.setFromObject(built.root);
  if (Number.isFinite(_box.min.y)) built.root.position.y -= _box.min.y;

  const totalH = measure(built.root, bodyH, 'y');
  const hintHeight = totalH * HINT_EXPOSURE;
  const hint = createHint(cfg.hintPart, hintHeight, p);
  hint.position.y = totalH;
  group.add(hint);

  const glowTargets = [p.skin, p.belly];
  const emissive = new THREE.Color(0xfff0cc);

  return {
    group,
    height: totalH,
    width: Math.max(bodyW, measure(built.root, bodyW, 'x')),
    depth: bodyD,
    head: built.head,
    gazeStrength: built.gazeStrength,
    hint,
    hintHeight,
    setGlow(amount) {
      // **加算の光を足さない。** みずのなかでは、生き物に載せた加算のリムライト
      // （最大 +1.7）が体色を白く消していた。emissive を体色そのものに寄せて
      // 少しだけ持ち上げるなら、色相と彩度は残る。
      const a = Math.max(0, Math.min(1, amount)) * 0.35;
      for (const m of glowTargets) {
        m.emissive.copy(emissive);
        m.emissiveIntensity = a;
      }
    },
    dispose() {
      disposeObject3D(group);
    },
  };
}

interface Built {
  root: THREE.Group;
  head: THREE.Object3D;
  gazeStrength: number;
}

function buildBody(
  plan: BodyPlan,
  cfg: AnimalConfig,
  p: Palette,
  h: number,
  w: number,
  d: number
): Built {
  switch (plan) {
    case 'bird':
      return buildBird(cfg, p, h, w, d);
    case 'fish':
      return buildFish(cfg, p, h, w, d);
    case 'octopus':
      return buildOctopus(cfg, p, h, w, d);
    case 'crab':
      return buildCrab(cfg, p, h, w, d);
    case 'insect':
      return buildInsect(cfg, p, h, w, d);
    case 'frog':
      return buildFrog(cfg, p, h, w, d);
    default:
      return buildMammal(cfg, p, h, w, d);
  }
}

/* --- 目 ------------------------------------------------------------------- */

/**
 * 目を2つ付ける。**必ず付ける**（§9）。
 * ハイライトまでが1組。黒い点だけだと「目」に見えない。
 */
function addEyes(parent: THREE.Object3D, p: Palette, r: number, spread: number, z: number): void {
  for (const sx of [-1, 1]) {
    const eye = ball(p.dark, r);
    eye.position.set(sx * spread, 0, z);
    parent.add(eye);
    const hi = ball(p.glint, r * 0.42);
    hi.position.set(sx * spread + r * 0.28, r * 0.3, z + r * 0.14);
    parent.add(hi);
  }
}

/* --- けもの ---------------------------------------------------------------- */

function buildMammal(cfg: AnimalConfig, p: Palette, h: number, w: number, d: number): Built {
  const root = new THREE.Group();
  // 胴は下 55%、頭は上 45%。頭を大きめに取るのは、
  // 1歳半が見ているのが顔だけだから（§4-4）
  const torsoH = h * 0.55;
  const headR = h * 0.26;

  const torso = ball(p.skin);
  torso.scale.set(w / 2, torsoH / 2, d / 2);
  torso.position.y = torsoH / 2;
  root.add(torso);

  const belly = ball(p.belly);
  belly.scale.set(w * 0.34, torsoH * 0.36, d * 0.34);
  belly.position.set(0, torsoH * 0.42, d * 0.22);
  root.add(belly);

  addCoat(cfg, root, p, w, torsoH, d);

  const head = new THREE.Group();
  head.position.y = torsoH * 0.92 + headR * 0.72;
  root.add(head);

  const skull = ball(p.skin, headR);
  skull.scale.set(1, 1, 0.94);
  head.add(skull);
  addEyes(head, p, headR * 0.19, headR * 0.42, headR * 0.82);
  addSnout(cfg.snout ?? 'none', head, p, headR);
  addHeadTop(cfg.headTop ?? 'none', head, p, headR);
  addTail(cfg.tail ?? 'none', root, p, w, d, torsoH);

  return { root, head, gazeStrength: 1 };
}

/* --- とり ------------------------------------------------------------------ */

function buildBird(cfg: AnimalConfig, p: Palette, h: number, w: number, d: number): Built {
  const root = new THREE.Group();
  const torsoH = h * 0.62;
  const headR = h * 0.24;

  const torso = ball(p.skin);
  torso.scale.set(w / 2, torsoH / 2, d / 2);
  torso.position.y = torsoH / 2;
  root.add(torso);

  // お腹。とりは腹が白いものが多く、そこがいちばん目に入る
  const belly = ball(p.belly);
  belly.scale.set(w * 0.36, torsoH * 0.4, d * 0.34);
  belly.position.set(0, torsoH * 0.42, d * 0.24);
  root.add(belly);

  // 翼。潰した球を横に貼る
  for (const sx of [-1, 1]) {
    const wing = ball(p.skin, w * 0.3);
    wing.scale.set(0.3, 1.05, 0.75);
    wing.position.set(sx * w * 0.46, torsoH * 0.52, 0);
    root.add(wing);
  }

  const head = new THREE.Group();
  // 首を作らない。首があると「とり」ではなく「けもの」に見える
  head.position.y = torsoH * 0.9 + headR * 0.5;
  root.add(head);
  const skull = ball(p.skin, headR);
  skull.scale.set(1, 0.94, 0.94);
  head.add(skull);
  addEyes(head, p, headR * 0.19, headR * 0.44, headR * 0.8);
  addSnout(cfg.snout ?? 'beak', head, p, headR);
  addHeadTop(cfg.headTop ?? 'none', head, p, headR);
  addTail(cfg.tail ?? 'feather', root, p, w, d, torsoH);

  return { root, head, gazeStrength: 1 };
}

/* --- さかな ---------------------------------------------------------------- */

/**
 * さかな。**横向きに作る。**
 *
 * 正面から見た魚は「丸い点」で、魚に見えない。
 * 体を x 方向に長く取り、頭を +x、尾を -x に置いて、
 * 目は手前（+z）に付ける。カメラからは横顔として読める。
 */
function buildFish(cfg: AnimalConfig, p: Palette, h: number, w: number, d: number): Built {
  const root = new THREE.Group();
  const bodyLen = w * 1.5;
  const bodyH = h * 0.72;

  const body = ball(p.skin);
  body.scale.set(bodyLen / 2, bodyH / 2, d / 2.4);
  body.position.y = h * 0.46;
  root.add(body);

  // 尾びれ。**縦に立てる。** 寝かせるとイルカに見える
  const tail = fin(p.skin, bodyLen * 0.34, bodyH * 0.95, 0.035);
  tail.position.set(-bodyLen * 0.52, h * 0.46, 0);
  tail.rotation.z = 0.25;
  root.add(tail);

  // 背びれ
  const dorsal = fin(p.skin, bodyLen * 0.36, bodyH * 0.34, 0.03);
  dorsal.position.set(-bodyLen * 0.04, h * 0.46 + bodyH * 0.5, 0);
  root.add(dorsal);

  // 胸びれ。手前側だけ付ける（奥は見えない）
  const pect = fin(p.belly, bodyLen * 0.2, bodyH * 0.26, 0.03);
  pect.position.set(bodyLen * 0.1, h * 0.4, d * 0.2);
  pect.rotation.z = -0.5;
  root.add(pect);

  if ((cfg.coat ?? 'plain') === 'banded') {
    // しま。クマノミの白い帯。**輪郭ではなく模様だが、これが無いと
    // 「オレンジの魚」で終わってしまう**ので2本だけ入れる
    for (const x of [0.18, -0.2]) {
      const band = ball(p.belly);
      band.scale.set(bodyLen * 0.055, bodyH * 0.5, d / 2.3);
      band.position.set(bodyLen * x, h * 0.46, 0);
      root.add(band);
    }
  }

  // 頭は体の前寄りの小さな節。ここに目を付ける
  const head = new THREE.Group();
  head.position.set(bodyLen * 0.34, h * 0.5, 0);
  root.add(head);
  const eyeR = bodyH * 0.1;
  const eye = ball(p.dark, eyeR);
  eye.position.set(0, 0, d * 0.2);
  head.add(eye);
  const hi = ball(p.glint, eyeR * 0.42);
  hi.position.set(eyeR * 0.3, eyeR * 0.3, d * 0.2 + eyeR * 0.5);
  head.add(hi);

  // 口。小さい黒い線
  const mouth = fin(p.dark, bodyLen * 0.06, bodyH * 0.03, 0.02);
  mouth.position.set(bodyLen * 0.12, -bodyH * 0.16, d * 0.16);
  head.add(mouth);

  // 横向きに作ってあるので、カメラを向かせすぎると横顔が崩れる
  return { root, head, gazeStrength: 0.25 };
}

/* --- たこ ------------------------------------------------------------------ */

function buildOctopus(_cfg: AnimalConfig, p: Palette, h: number, w: number, d: number): Built {
  const root = new THREE.Group();
  const headR = w * 0.5;
  const headY = h * 0.62;

  // 丸い頭。**縦に伸ばす。** 真球だと「ボール」で、たこに見えない
  const dome = ball(p.skin, headR);
  dome.scale.set(1, 1.25, 0.9);
  dome.position.y = headY;
  root.add(dome);

  // 足。8本は多すぎて潰れるので6本。手前に広げる。
  //
  // **横への広げ方は参照画像から決めた**（M1 / 2026-09-06）。
  // 0.7 / 0.95 だと正面の縦横比が 0.71 で、参照の 1.00 に対して縦長すぎた。
  // 1.3 / 1.8 で 1.08 になり、IoU が 0.659 → 0.687 に上がった。
  // **さらに広げても上がらない**（1.55/2.1 で縦横比 1.24・IoU 0.678）。
  // 残りは腕の太さと曲がり方の違いで、比率では詰められない
  const legs = 6;
  for (let i = 0; i < legs; i++) {
    const a = -0.9 + (1.8 * i) / (legs - 1);
    const leg = cone(p.skin, w * 0.1, h * 0.5, 6);
    leg.position.set(Math.sin(a) * headR * 1.3, h * 0.24, Math.cos(a) * d * 0.3);
    leg.rotation.set(0.25, 0, -Math.sin(a) * 0.5);
    // 先を細く、根元を太く見せる
    leg.scale.set(1, 1, 1);
    root.add(leg);
    const tip = ball(p.belly, w * 0.055);
    tip.position.set(Math.sin(a) * headR * 1.8, h * 0.045, Math.cos(a) * d * 0.34);
    root.add(tip);
  }

  const head = new THREE.Group();
  head.position.y = headY;
  root.add(head);
  addEyes(head, p, headR * 0.2, headR * 0.4, headR * 0.78);

  return { root, head, gazeStrength: 0.5 };
}

/* --- かに ------------------------------------------------------------------ */

function buildCrab(_cfg: AnimalConfig, p: Palette, h: number, w: number, d: number): Built {
  const root = new THREE.Group();
  const bodyY = h * 0.42;

  // 平たく広い甲羅。**横に広げる。** これがかにの全部
  const shell = ball(p.skin);
  shell.scale.set(w * 0.62, h * 0.28, d * 0.4);
  shell.position.y = bodyY;
  root.add(shell);

  // はさみ。上に構える
  for (const sx of [-1, 1]) {
    const arm = tube(p.skin, w * 0.07, w * 0.3, 6);
    arm.position.set(sx * w * 0.58, bodyY + h * 0.06, d * 0.1);
    arm.rotation.z = sx * -0.6;
    root.add(arm);
    const claw = ball(p.warm, w * 0.16);
    claw.scale.set(1, 1.25, 0.7);
    claw.position.set(sx * w * 0.74, bodyY + h * 0.28, d * 0.12);
    root.add(claw);
  }

  // 脚。左右3本ずつの短い棒
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const leg = tube(p.skin, w * 0.035, w * 0.26, 6);
      leg.position.set(sx * w * 0.5, bodyY - h * 0.16, -d * 0.1 + i * d * 0.16);
      leg.rotation.z = sx * -1.1;
      root.add(leg);
    }
  }

  // 目の柄。**かにと分かる決め手**
  const head = new THREE.Group();
  head.position.y = bodyY + h * 0.16;
  root.add(head);
  for (const sx of [-1, 1]) {
    const stalk = tube(p.skin, w * 0.035, h * 0.18, 6);
    stalk.position.set(sx * w * 0.16, h * 0.09, d * 0.1);
    head.add(stalk);
    const eye = ball(p.dark, w * 0.07);
    eye.position.set(sx * w * 0.16, h * 0.2, d * 0.1);
    head.add(eye);
    const hi = ball(p.glint, w * 0.028);
    hi.position.set(sx * w * 0.16 + w * 0.02, h * 0.22, d * 0.14);
    head.add(hi);
  }

  return { root, head, gazeStrength: 0.3 };
}

/* --- むし ------------------------------------------------------------------ */

function buildInsect(cfg: AnimalConfig, p: Palette, h: number, w: number, _d: number): Built {
  const root = new THREE.Group();
  const bodyH = h * 0.55;

  // 胴は細い棒。**羽が主役なので、体は目立たせない**
  const body = ball(p.dark);
  body.scale.set(w * 0.08, bodyH * 0.5, w * 0.08);
  body.position.y = bodyH * 0.55;
  root.add(body);

  // 羽。上下2枚ずつ。上を大きく、下を小さく
  for (const sx of [-1, 1]) {
    const upper = ball(p.skin);
    upper.scale.set(w * 0.42, h * 0.3, 0.02);
    upper.position.set(sx * w * 0.36, bodyH * 0.82, 0.02);
    upper.rotation.z = sx * -0.25;
    root.add(upper);
    const lower = ball(p.belly);
    lower.scale.set(w * 0.3, h * 0.2, 0.02);
    lower.position.set(sx * w * 0.3, bodyH * 0.42, 0);
    lower.rotation.z = sx * -0.1;
    root.add(lower);
  }

  const head = new THREE.Group();
  head.position.y = bodyH * 1.02;
  root.add(head);
  const skull = ball(p.dark, w * 0.11);
  head.add(skull);
  addEyes(head, p, w * 0.045, w * 0.06, w * 0.09);
  addHeadTop(cfg.headTop ?? 'antennae', head, p, w * 0.11);

  return { root, head, gazeStrength: 0.6 };
}

/* --- かえる ---------------------------------------------------------------- */

function buildFrog(cfg: AnimalConfig, p: Palette, h: number, w: number, d: number): Built {
  const root = new THREE.Group();
  const bodyH = h * 0.6;

  // 平たく座った体。**横に広い**のがかえる
  const body = ball(p.skin);
  body.scale.set(w * 0.56, bodyH * 0.46, d * 0.5);
  body.position.y = bodyH * 0.42;
  root.add(body);

  const belly = ball(p.belly);
  belly.scale.set(w * 0.36, bodyH * 0.26, d * 0.3);
  belly.position.set(0, bodyH * 0.3, d * 0.28);
  root.add(belly);

  // 前足。体の前に2本
  for (const sx of [-1, 1]) {
    const arm = tube(p.skin, w * 0.06, bodyH * 0.36, 6);
    arm.position.set(sx * w * 0.36, bodyH * 0.18, d * 0.28);
    root.add(arm);
  }

  // 目は**頭の上に飛び出す**。かえるはここが全て
  const head = new THREE.Group();
  head.position.y = bodyH * 0.72;
  root.add(head);
  const skull = ball(p.skin, w * 0.3);
  skull.scale.set(1, 0.66, 0.9);
  head.add(skull);
  for (const sx of [-1, 1]) {
    const bump = ball(p.skin, w * 0.13);
    bump.position.set(sx * w * 0.15, w * 0.16, 0);
    head.add(bump);
    const eye = ball(p.dark, w * 0.075);
    eye.position.set(sx * w * 0.15, w * 0.2, w * 0.05);
    head.add(eye);
    const hi = ball(p.glint, w * 0.03);
    hi.position.set(sx * w * 0.15 + w * 0.03, w * 0.24, w * 0.09);
    head.add(hi);
  }
  // 大きな口
  const mouth = fin(p.dark, w * 0.34, h * 0.015, 0.02);
  mouth.position.set(0, -w * 0.1, w * 0.27);
  head.add(mouth);
  addTail(cfg.tail ?? 'none', root, p, w, d, bodyH);

  return { root, head, gazeStrength: 0.8 };
}

/* --- 部品 ------------------------------------------------------------------ */

function addSnout(kind: Snout, head: THREE.Group, p: Palette, r: number): void {
  switch (kind) {
    case 'muzzle': {
      // 突き出た鼻づら（いぬ・うし）
      const muzzle = ball(p.belly, r * 0.42);
      muzzle.scale.set(0.95, 0.74, 1.3);
      muzzle.position.set(0, -r * 0.2, r * 0.86);
      head.add(muzzle);
      const nose = ball(p.dark, r * 0.15);
      nose.position.set(0, -r * 0.1, r * 1.3);
      head.add(nose);
      break;
    }
    case 'point': {
      // とがった鼻（ねずみ・はりねずみ・りす）
      const snout = cone(p.belly, r * 0.3, r * 0.66);
      snout.rotation.x = Math.PI / 2;
      snout.position.set(0, -r * 0.18, r * 1.02);
      head.add(snout);
      const nose = ball(p.dark, r * 0.1);
      nose.position.set(0, -r * 0.18, r * 1.34);
      head.add(nose);
      break;
    }
    case 'beak': {
      const beak = cone(p.warm, r * 0.24, r * 0.7);
      beak.rotation.x = Math.PI / 2;
      beak.position.set(0, -r * 0.06, r * 1.05);
      head.add(beak);
      break;
    }
    case 'flat': {
      // ぶたの鼻。**円柱を正面に貼る。** これだけでぶたに見える
      const disc = tube(p.warm, r * 0.3, r * 0.22, 10);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(0, -r * 0.2, r * 0.92);
      head.add(disc);
      for (const sx of [-1, 1]) {
        const hole = ball(p.dark, r * 0.06);
        hole.position.set(sx * r * 0.11, -r * 0.2, r * 1.02);
        head.add(hole);
      }
      break;
    }
    case 'wide': {
      // 大きな口（ひつじ・かえる以外の草食）
      const jaw = ball(p.belly, r * 0.44);
      jaw.scale.set(1.05, 0.6, 0.9);
      jaw.position.set(0, -r * 0.44, r * 0.66);
      head.add(jaw);
      break;
    }
    default: {
      // 小さい鼻だけ（ねこ・うさぎ）。鼻づらを付けると、いぬと混ざる
      const nose = cone(standard('#e8879a', 0.6), r * 0.12, r * 0.16);
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, -r * 0.12, r * 0.98);
      head.add(nose);
      break;
    }
  }
}

function addHeadTop(kind: HeadTop, head: THREE.Group, p: Palette, r: number): void {
  switch (kind) {
    case 'triangleEars':
      for (const sx of [-1, 1]) {
        const ear = cone(p.skin, r * 0.34, r * 0.72);
        ear.position.set(sx * r * 0.56, r * 0.86, 0);
        ear.rotation.z = sx * -0.22;
        head.add(ear);
      }
      break;
    case 'floppyEars':
      for (const sx of [-1, 1]) {
        const ear = ball(p.belly, r * 0.4);
        ear.scale.set(0.42, 1.15, 0.7);
        ear.position.set(sx * r * 0.86, r * 0.05, -r * 0.05);
        ear.rotation.z = sx * 0.24;
        head.add(ear);
      }
      break;
    case 'roundEars':
      // 体に対して大きすぎる丸い耳（ねずみ）。控えめにすると、ねこと混ざる
      for (const sx of [-1, 1]) {
        const ear = ball(p.belly, r * 0.55);
        ear.scale.set(1, 1, 0.22);
        ear.position.set(sx * r * 0.82, r * 0.72, -r * 0.06);
        head.add(ear);
      }
      break;
    case 'longEars':
      // 立った長い耳（うさぎ）。これがうさぎの全部
      for (const sx of [-1, 1]) {
        const ear = ball(p.skin, r * 0.5);
        ear.scale.set(0.34, 1.95, 0.3);
        ear.position.set(sx * r * 0.36, r * 1.55, -r * 0.04);
        ear.rotation.z = sx * -0.16;
        head.add(ear);
        const inner = ball(p.belly, r * 0.5);
        inner.scale.set(0.2, 1.6, 0.18);
        inner.position.set(sx * r * 0.36, r * 1.55, r * 0.08);
        inner.rotation.z = sx * -0.16;
        head.add(inner);
      }
      break;
    case 'tuftEars':
      // 房のある耳（りす）。三角の先に毛束が立つ
      for (const sx of [-1, 1]) {
        const ear = cone(p.skin, r * 0.26, r * 0.6);
        ear.position.set(sx * r * 0.5, r * 0.84, 0);
        ear.rotation.z = sx * -0.2;
        head.add(ear);
        const tuft = cone(p.belly, r * 0.12, r * 0.34);
        tuft.position.set(sx * r * 0.56, r * 1.24, 0);
        tuft.rotation.z = sx * -0.35;
        head.add(tuft);
      }
      break;
    case 'horns':
      // うしの角と耳。角は横に、耳はその下に
      for (const sx of [-1, 1]) {
        const horn = cone(p.belly, r * 0.12, r * 0.44);
        horn.position.set(sx * r * 0.6, r * 0.86, -r * 0.1);
        horn.rotation.z = sx * -1.0;
        head.add(horn);
        const ear = ball(p.skin, r * 0.3);
        ear.scale.set(0.9, 0.44, 0.5);
        ear.position.set(sx * r * 0.92, r * 0.42, -r * 0.05);
        head.add(ear);
      }
      break;
    case 'comb': {
      // にわとりのとさか。**赤く、上にギザギザ**
      const red = standard('#d8433f', 0.6);
      for (let i = 0; i < 3; i++) {
        const bit = ball(red, r * (0.2 - Math.abs(i - 1) * 0.05));
        bit.scale.set(0.7, 1.2, 0.35);
        bit.position.set(0, r * 1.02, (i - 1) * r * 0.26);
        head.add(bit);
      }
      // 肉垂れ
      const wattle = ball(red, r * 0.12);
      wattle.scale.set(0.8, 1.3, 0.6);
      wattle.position.set(0, -r * 0.62, r * 0.6);
      head.add(wattle);
      break;
    }
    case 'antennae':
      for (const sx of [-1, 1]) {
        const ant = tube(p.dark, r * 0.06, r * 1.6, 5);
        ant.position.set(sx * r * 0.3, r * 0.85, 0);
        ant.rotation.z = sx * -0.4;
        head.add(ant);
        const knob = ball(p.dark, r * 0.14);
        knob.position.set(sx * r * 0.62, r * 1.6, 0);
        head.add(knob);
      }
      break;
    default:
      // 耳が無いことが特徴の動物もいる（ことり）。何も足さない
      break;
  }
}

function addTail(
  kind: TailShape,
  root: THREE.Group,
  p: Palette,
  w: number,
  d: number,
  torsoH: number
): void {
  switch (kind) {
    case 'thin': {
      const tail = cone(p.skin, w * 0.055, w * 1.0);
      tail.position.set(w * 0.28, torsoH * 0.7, -d * 0.55);
      tail.rotation.set(-0.7, 0, -0.5);
      root.add(tail);
      break;
    }
    case 'bushy': {
      // りすの尾。**背中より高く立てる。** これがりすの決め手
      for (let i = 0; i < 3; i++) {
        const puff = ball(p.skin, w * 0.24);
        puff.scale.set(0.7, 1, 0.55);
        puff.position.set(0, torsoH * (0.8 + i * 0.42), -d * (0.6 - i * 0.1));
        puff.rotation.x = 0.3 - i * 0.25;
        root.add(puff);
      }
      break;
    }
    case 'puff': {
      const tail = ball(p.belly, w * 0.16);
      tail.position.set(0, torsoH * 0.34, -d * 0.6);
      root.add(tail);
      break;
    }
    case 'feather': {
      const tail = fin(p.skin, w * 0.5, 0.05, d * 0.9);
      tail.position.set(0, torsoH * 0.42, -d * 0.66);
      tail.rotation.x = -0.35;
      root.add(tail);
      break;
    }
    case 'curl': {
      // ぶたのくるりとした尾。小さい玉を3つ並べて渦に見せる
      for (let i = 0; i < 3; i++) {
        const bit = ball(p.belly, w * 0.05);
        const a = i * 1.6;
        bit.position.set(Math.sin(a) * w * 0.09, torsoH * 0.6 + i * w * 0.06, -d * 0.6);
        root.add(bit);
      }
      break;
    }
    default:
      break;
  }
}

/** 体の表面。輪郭を変えるものだけ（模様は入れない） */
function addCoat(
  cfg: AnimalConfig,
  root: THREE.Group,
  p: Palette,
  w: number,
  torsoH: number,
  d: number
): void {
  switch (cfg.coat ?? 'plain') {
    case 'spiky':
      // はりねずみのとげ。背中に円錐を並べる。
      // **耳を出さないぶん、ここが唯一の突起**なので数と長さを稼ぐ
      for (let i = 0; i < 11; i++) {
        const a = -1.25 + (2.5 * i) / 10;
        const spine = cone(p.dark, w * 0.06, w * 0.42, 5);
        spine.position.set(
          Math.sin(a) * w * 0.42,
          torsoH * 0.72 + Math.cos(a) * torsoH * 0.2,
          -d * 0.12
        );
        spine.rotation.z = -a * 0.9;
        root.add(spine);
      }
      break;
    case 'fluffy':
      // ひつじのもこもこ。球を重ねて輪郭をぼこぼこにする
      for (let i = 0; i < 7; i++) {
        const a = -1.4 + (2.8 * i) / 6;
        const puff = ball(p.belly, w * 0.19);
        puff.position.set(
          Math.sin(a) * w * 0.44,
          torsoH * 0.6 + Math.cos(a) * torsoH * 0.36,
          d * 0.08
        );
        root.add(puff);
      }
      break;
    case 'spotted':
      // うしのぶち。輪郭は変わらないが、これが無いと「茶色い動物」で終わる
      for (const [x, y, s] of [
        [-0.24, 0.62, 0.16],
        [0.26, 0.4, 0.13],
        [0.05, 0.78, 0.1],
      ] as const) {
        const spot = ball(p.dark, w * s);
        spot.scale.set(1, 0.8, 0.35);
        spot.position.set(w * x, torsoH * y, d * 0.34);
        root.add(spot);
      }
      break;
    default:
      break;
  }
}

/* --- ヒント --------------------------------------------------------------- */

/**
 * 隠れているときに縁から出す部分（§4-2）。
 *
 * **顔は絶対に出さない。** 出すのは尻尾・耳・鼻先・足・ひれの5種類だけで、
 * 1つの場面の中では全部違う形にしてある
 * （どの場所に誰が居るかを形で覚えられるように）。
 */
function createHint(part: HintPart, height: number, p: Palette): THREE.Object3D {
  const node = new THREE.Group();
  switch (part) {
    case 'ear': {
      const ear = ball(p.skin, height * 0.55);
      ear.scale.set(0.5, 0.95, 0.6);
      ear.position.y = height * 0.5;
      node.add(ear);
      break;
    }
    case 'nose': {
      const snout = cone(p.skin, height * 0.36, height * 0.9);
      snout.position.y = height * 0.45;
      node.add(snout);
      const tip = ball(p.dark, height * 0.16);
      tip.position.y = height * 0.92;
      node.add(tip);
      break;
    }
    case 'foot': {
      const leg = tube(p.warm, height * 0.11, height * 0.8);
      leg.position.y = height * 0.4;
      node.add(leg);
      // 指3本。棒だけだと何か分からない
      for (const a of [-0.5, 0, 0.5]) {
        const toe = tube(p.warm, height * 0.07, height * 0.34, 6);
        toe.position.set(Math.sin(a) * height * 0.16, height * 0.88, Math.cos(a) * height * 0.1);
        toe.rotation.z = a * 0.6;
        node.add(toe);
      }
      break;
    }
    case 'fin': {
      // ひれ。平たい三角を立てる
      const blade = fin(p.skin, height * 0.7, height * 0.95, height * 0.08);
      blade.position.y = height * 0.48;
      blade.rotation.z = 0.18;
      node.add(blade);
      const edge = fin(p.belly, height * 0.5, height * 0.16, height * 0.09);
      edge.position.y = height * 0.86;
      node.add(edge);
      break;
    }
    default: {
      // 尻尾。まっすぐだと棒に見えるので、2段に折って先を曲げる
      const lower = cone(p.skin, height * 0.13, height * 0.62);
      lower.position.y = height * 0.31;
      node.add(lower);
      const upper = cone(p.skin, height * 0.1, height * 0.5);
      upper.position.set(height * 0.14, height * 0.78, 0);
      upper.rotation.z = -0.55;
      node.add(upper);
      break;
    }
  }
  return node;
}

/* --- 実測 ----------------------------------------------------------------- */

const _box = new THREE.Box3();

/**
 * 組み上がった体の大きさを実測する。
 *
 * **`bodyHeight` をそのまま返さない。** 耳や尻尾を足すと実際の大きさは変わるので、
 * 決め打ちにすると「縁から出す量」が体ごとにずれる。
 * ここを実測にしてあるおかげで、耳を大きくしても隠れ方は壊れない。
 */
function measure(obj: THREE.Object3D, fallback: number, axis: 'x' | 'y'): number {
  _box.setFromObject(obj);
  const v = axis === 'y' ? _box.max.y - _box.min.y : _box.max.x - _box.min.x;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
