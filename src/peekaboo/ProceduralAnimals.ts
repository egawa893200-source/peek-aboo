/**
 * 動物の手続き生成（設計書 §9 / 不変条件7）
 *
 * `public/` が空でも動くように、球と円錐だけで4体を作る。
 * .glb に差し替えるのは Phase 9（§8-5「先に手続き生成で全部動かしてから」）。
 *
 * ------------------------------------------------------------------------
 * **輪郭で見分けがつくこと**が、色より優先（§5-2）。
 * みずのなかでは体型を指定しなかったせいで、チョウチョウウオもメダカも
 * 同じ魚になった。ここでは4体それぞれに
 *
 *   ねこ   … 三角の立ち耳・細く長い尾
 *   いぬ   … 垂れ耳・突き出た鼻・太い尾
 *   ねずみ … 体に対して大きすぎる丸い耳・とがった鼻
 *   ことり … 耳が無い・くちばし・まん丸
 *
 * を付けて、**遠目のシルエットだけで違う**ようにしてある。
 *
 * **目は必ず付ける**（§9）。1歳半に効くのは影でも照り返しでもなく、
 * 顔と目が見えていることだけ（§4-4）。
 * ------------------------------------------------------------------------
 *
 * 約束:
 *  - 原点は**足元**（y = 0 が体の底）。`height` は耳まで含めた高さ
 *  - +z が正面
 *  - `hint` は隠れているときに縁から出す部分（§4-2）。
 *    **体とは別の枝**にしてあるので、体を完全に隠したままヒントだけ出せる。
 *    顔が見えていたら「ばあ！」が驚きにならない
 */

import * as THREE from 'three';

import type { AnimalConfig, HintPart } from '../types';
import { disposeObject3D } from './SpotShapes';

/**
 * 隠れているとき、体長の何割を縁から出すか（§4-2 は 15〜25%）。
 *
 * 帯の下限寄り（0.20）だと、いちばん小さいことり（体高 0.62）のヒントが
 * 画面上 14px ほどにしかならず、暗い背景では見つけにくかった。
 * 0.22 に上げてある。**上げすぎないこと。** ヒントの形（耳・鼻先）は
 * 先端が少しはみ出すので、実測値は 0.22 → 0.238 まで膨らむ。
 * 0.24 にすると鼻先が 0.259 になり、§4-2 の上限 25% を超える。
 */
export const HINT_EXPOSURE = 0.22;

export interface ProceduralAnimal {
  readonly group: THREE.Group;
  /** 足元から耳の先まで（`hint` は含まない） */
  readonly height: number;
  /** いちばん広いところの幅。隠れ場所の `mouthWidth` と比べる（§4-2） */
  readonly width: number;
  /** 体の厚み。隠れ場所の前板とぶつからないことを SceneRoot が確かめる */
  readonly depth: number;
  /** 視線を向ける先（§4-4「出きったらカメラの方を向く」） */
  readonly head: THREE.Object3D;
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

/** 使い回しの球。毎フレームではなく生成時にしか使わないが、形は共通 */
function ball(mat: THREE.Material, r = 1): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, SEG_W, SEG_H), mat);
}

function cone(mat: THREE.Material, r: number, h: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), mat);
}

function standard(color: THREE.ColorRepresentation, roughness = 0.8): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.0 });
}

/**
 * 動物を1体作る。
 *
 * `cfg.bodyHeight` / `bodyWidth` が未指定でも動くが、**指定すること**。
 * 未指定だと4体とも同じ形になる（§5-2 でいちばん時間を無駄にした失敗）。
 */
export function createProceduralAnimal(cfg: AnimalConfig): ProceduralAnimal {
  const group = new THREE.Group();

  const bodyH = cfg.bodyHeight ?? 0.9;
  const bodyW = cfg.bodyWidth ?? 0.66;
  // 厚みは幅より少し薄く。隠れ場所の前板（z = 0.22）と
  // 動物の置き場（z = -0.20）の間は 0.42 しかないので、ここを超えると突き抜ける
  const bodyD = Math.min(bodyW * 0.92, 0.4);

  const skin = standard(cfg.color);
  const belly = standard(cfg.bellyColor);
  const dark = standard('#20242c', 0.45);
  // 足のヒント用。**暗い色で作らないこと。**
  // 最初は `dark` で作っていたが、背景（#12203a）とほぼ同じ明るさで、
  // 遮蔽は無いのに画面上では見えていなかった（レイのテストは通っていた）。
  const warm = standard('#f2a93b', 0.55);
  const glint = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // --- 胴 ---------------------------------------------------------------
  // 胴は下 55%、頭は上 45%。頭を大きめに取るのは、
  // 1歳半が見ているのが顔だけだから（§4-4）
  const torsoH = bodyH * 0.55;
  const headR = bodyH * 0.26;

  const torso = ball(skin);
  torso.scale.set(bodyW / 2, torsoH / 2, bodyD / 2);
  torso.position.y = torsoH / 2;
  group.add(torso);

  const bellyMesh = ball(belly);
  bellyMesh.scale.set(bodyW * 0.34, torsoH * 0.36, bodyD * 0.34);
  bellyMesh.position.set(0, torsoH * 0.42, bodyD * 0.22);
  group.add(bellyMesh);

  // --- 頭 ---------------------------------------------------------------
  const head = new THREE.Group();
  head.position.y = torsoH * 0.92 + headR * 0.72;
  group.add(head);

  const skull = ball(skin, headR);
  // ことりだけ頭を胴に埋める。首があると「鳥」に見えない
  skull.scale.set(1, cfg.id === 'kotori' ? 0.94 : 1, 0.94);
  head.add(skull);

  // 目。**必ず付ける**（§9）
  const eyeR = headR * 0.19;
  for (const sx of [-1, 1]) {
    const eye = ball(dark, eyeR);
    eye.position.set(sx * headR * 0.42, headR * 0.12, headR * 0.82);
    head.add(eye);
    // ハイライト。これが無いと「点」で、目に見えない
    const hi = ball(glint, eyeR * 0.42);
    hi.position.set(sx * headR * 0.42 + eyeR * 0.28, headR * 0.12 + eyeR * 0.3, headR * 0.94);
    head.add(hi);
  }

  addFace(cfg, head, headR, skin, dark, belly, warm);
  addEars(cfg, head, headR, skin, belly);
  addTail(cfg, group, bodyW, bodyD, torsoH, skin);

  // --- ヒント（§4-2） -----------------------------------------------------
  // 体のてっぺんに生やす。体は縁の下に沈めたまま、ここだけを縁の上に出す。
  const totalH = measureHeight(group, bodyH);
  const hintHeight = totalH * HINT_EXPOSURE;
  const hint = createHint(cfg.hintPart, hintHeight, skin, dark, warm);
  hint.position.y = totalH;
  group.add(hint);

  const glowTargets: THREE.MeshStandardMaterial[] = [skin, belly];
  const emissive = new THREE.Color(0xfff0cc);

  return {
    group,
    height: totalH,
    width: Math.max(bodyW, measureWidth(group, bodyW)),
    depth: bodyD,
    head,
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

/* --- 顔まわり ------------------------------------------------------------- */

function addFace(
  cfg: AnimalConfig,
  head: THREE.Group,
  headR: number,
  skin: THREE.Material,
  dark: THREE.Material,
  belly: THREE.Material,
  warm: THREE.Material
): void {
  switch (cfg.id) {
    case 'inu': {
      // 突き出た鼻づら。いぬを他と分ける最大の特徴
      const muzzle = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.42, SEG_W, SEG_H), belly);
      muzzle.scale.set(0.9, 0.72, 1.3);
      muzzle.position.set(0, -headR * 0.2, headR * 0.86);
      head.add(muzzle);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.16, 8, 6), dark);
      nose.position.set(0, -headR * 0.1, headR * 1.32);
      head.add(nose);
      break;
    }
    case 'nezumi': {
      // とがった鼻。円錐を前に倒す
      const snout = cone(belly, headR * 0.3, headR * 0.66);
      snout.rotation.x = Math.PI / 2;
      snout.position.set(0, -headR * 0.18, headR * 1.02);
      head.add(snout);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.1, 8, 6), dark);
      nose.position.set(0, -headR * 0.18, headR * 1.34);
      head.add(nose);
      break;
    }
    case 'kotori': {
      // くちばし。耳が無いぶん、ここが唯一の突起になる
      const beak = cone(warm, headR * 0.24, headR * 0.7);
      beak.rotation.x = Math.PI / 2;
      beak.position.set(0, -headR * 0.06, headR * 1.05);
      head.add(beak);
      break;
    }
    default: {
      // ねこ。小さい鼻だけ。鼻づらを付けると、いぬと混ざる
      const nose = cone(standard('#e8879a', 0.6), headR * 0.12, headR * 0.16);
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, -headR * 0.12, headR * 0.98);
      head.add(nose);
      // ひげ。細い箱3本。丸い頭に直線が入るとシルエットが締まる
      const whisker = new THREE.BoxGeometry(headR * 0.9, 0.012, 0.012);
      for (const sy of [-0.06, 0.02, 0.1]) {
        for (const sx of [-1, 1]) {
          const w = new THREE.Mesh(whisker, dark);
          w.position.set(sx * headR * 0.55, -headR * 0.12 + headR * sy, headR * 0.82);
          w.rotation.z = sx * 0.18;
          head.add(w);
        }
      }
      void skin;
      break;
    }
  }
}

function addEars(
  cfg: AnimalConfig,
  head: THREE.Group,
  headR: number,
  skin: THREE.Material,
  belly: THREE.Material
): void {
  switch (cfg.id) {
    case 'neko': {
      // 立った三角の耳
      for (const sx of [-1, 1]) {
        const ear = cone(skin, headR * 0.34, headR * 0.72);
        ear.position.set(sx * headR * 0.56, headR * 0.86, 0);
        ear.rotation.z = sx * -0.22;
        head.add(ear);
      }
      break;
    }
    case 'inu': {
      // 垂れ耳。潰した球を横に貼る
      for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.4, SEG_W, SEG_H), belly);
        ear.scale.set(0.42, 1.15, 0.7);
        ear.position.set(sx * headR * 0.86, headR * 0.05, -headR * 0.05);
        ear.rotation.z = sx * 0.24;
        head.add(ear);
      }
      break;
    }
    case 'nezumi': {
      // **体に対して大きすぎる丸い耳。** ここを控えめにすると、ねこと混ざる
      for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.55, SEG_W, SEG_H), belly);
        ear.scale.set(1, 1, 0.22);
        ear.position.set(sx * headR * 0.82, headR * 0.72, -headR * 0.06);
        head.add(ear);
      }
      break;
    }
    default:
      // ことりは耳が無い。無いことが特徴なので、何も足さない
      break;
  }
}

function addTail(
  cfg: AnimalConfig,
  group: THREE.Group,
  bodyW: number,
  bodyD: number,
  torsoH: number,
  skin: THREE.Material
): void {
  switch (cfg.id) {
    case 'kotori': {
      // 尾羽。平たい箱を後ろに突き出す
      const tail = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 0.5, 0.05, bodyD * 0.9), skin);
      tail.position.set(0, torsoH * 0.42, -bodyD * 0.66);
      tail.rotation.x = -0.35;
      group.add(tail);
      // 翼。潰した球
      for (const sx of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.SphereGeometry(bodyW * 0.3, SEG_W, SEG_H), skin);
        wing.scale.set(0.3, 1, 0.75);
        wing.position.set(sx * bodyW * 0.46, torsoH * 0.52, 0);
        group.add(wing);
      }
      break;
    }
    case 'inu': {
      const tail = cone(skin, bodyW * 0.11, bodyW * 0.62);
      tail.position.set(0, torsoH * 0.8, -bodyD * 0.62);
      tail.rotation.x = -0.9;
      group.add(tail);
      break;
    }
    default: {
      // ねこ・ねずみは細く長い尾
      const len = cfg.id === 'nezumi' ? bodyW * 1.05 : bodyW * 0.95;
      const tail = cone(skin, bodyW * 0.055, len);
      tail.position.set(bodyW * 0.28, torsoH * 0.7, -bodyD * 0.55);
      tail.rotation.set(-0.7, 0, -0.5);
      group.add(tail);
      break;
    }
  }
}

/* --- ヒント --------------------------------------------------------------- */

/**
 * 隠れているときに縁から出す部分（§4-2）。
 *
 * **顔は絶対に出さない。** 出すのは尻尾・耳・鼻先・足の4種類だけで、
 * 4体それぞれ違う形にしてある（どの場所に誰が居るかを形で覚えられるように）。
 */
function createHint(
  part: HintPart,
  height: number,
  skin: THREE.Material,
  dark: THREE.Material,
  warm: THREE.Material
): THREE.Object3D {
  const node = new THREE.Group();
  switch (part) {
    case 'ear': {
      // 垂れ耳が1枚だけ、ひょいと出ている
      const ear = new THREE.Mesh(new THREE.SphereGeometry(height * 0.55, SEG_W, SEG_H), skin);
      ear.scale.set(0.5, 0.95, 0.6);
      ear.position.y = height * 0.5;
      node.add(ear);
      break;
    }
    case 'nose': {
      const snout = cone(skin, height * 0.36, height * 0.9);
      snout.position.y = height * 0.45;
      node.add(snout);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(height * 0.16, 8, 6), dark);
      tip.position.y = height * 0.92;
      node.add(tip);
      break;
    }
    case 'foot': {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(height * 0.11, height * 0.11, height * 0.8, 8),
        warm
      );
      leg.position.y = height * 0.4;
      node.add(leg);
      // 指3本。棒だけだと何か分からない
      for (const a of [-0.5, 0, 0.5]) {
        const toe = new THREE.Mesh(
          new THREE.CylinderGeometry(height * 0.07, height * 0.07, height * 0.34, 6),
          warm
        );
        toe.position.set(Math.sin(a) * height * 0.16, height * 0.88, Math.cos(a) * height * 0.1);
        toe.rotation.z = a * 0.6;
        node.add(toe);
      }
      break;
    }
    default: {
      // 尻尾。まっすぐだと棒に見えるので、2段に折って先を曲げる
      const lower = cone(skin, height * 0.13, height * 0.62);
      lower.position.y = height * 0.31;
      node.add(lower);
      const upper = cone(skin, height * 0.1, height * 0.5);
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
 * 組み上がった体の高さを実測する。
 *
 * **`bodyHeight` をそのまま返さない。** 耳や尻尾を足すと実際の高さは変わるので、
 * 決め打ちにすると「縁から出す量」が体ごとにずれる。
 * ここを実測にしてあるおかげで、耳を大きくしても隠れ方は壊れない。
 */
function measureHeight(group: THREE.Object3D, fallback: number): number {
  _box.setFromObject(group);
  const h = _box.max.y - _box.min.y;
  return Number.isFinite(h) && h > 0 ? h : fallback;
}

function measureWidth(group: THREE.Object3D, fallback: number): number {
  _box.setFromObject(group);
  const w = _box.max.x - _box.min.x;
  return Number.isFinite(w) && w > 0 ? w : fallback;
}
