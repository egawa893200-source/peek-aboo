/**
 * 絵をそのまま貼った動物（道A / 2026-09-06 に人間が決めた）
 *
 * ==========================================================================
 * **なぜ板で足りるのか。**
 *
 * この app のカメラは `PerspectiveCamera(fov 55°／縦持ち 66°)` を
 * `(0, 0.3, 7.2)` に固定していて、隠れ場所は x=±1.15 / y=+1.55・−1.20 にある。
 * 動物がカメラの正面から外れる角度は、いちばん深い隠れ場所でも **17.0°**。
 * 回り込むことも、横から見ることも一度も無い。
 *
 * つまり**立体であることを、この app はほとんど使っていない**。
 * 17° の見込み角で板が縮むのは cos(17°) = 0.956 で、4% しか変わらない。
 *
 * 手続き生成の動物（`ProceduralAnimals.ts`）は参照画像に IoU 0.70 まで
 * 「寄せた」ものだが、こちらは**参照画像そのもの**になる。
 *
 * **素材が無ければ手続き生成に落ちる**（不変条件7）。
 * `public/animals/` を空にしてもアプリは起動する。
 *
 * 守っていること:
 *  - `ProceduralAnimal` と同じ形を返す。`AnimalSystem` は違いを知らない
 *  - **光を当てない**（`MeshBasicMaterial` ＋ `toneMapped = false`）。
 *    参照画像は影も陰影も持たないフラット塗りなので、上から光を足すと
 *    絵の色が変わる。みずのなかの「加算の光が体色を消す」と同じ話
 *  - ヒント（縁から出る部分）は**同じ絵の上側を切って**使う。
 *    別に3Dの尻尾を生やすと、絵と立体が混ざって不揃いに見える
 * ==========================================================================
 */

import * as THREE from 'three';

import type { AnimalConfig } from '../types';
import { HINT_EXPOSURE, type ProceduralAnimal } from './ProceduralAnimals';
import { disposeObject3D } from './SpotShapes';

/**
 * 板の厚み。実際には0だが、`SpotShapes` の前板（z = 0.22）と
 * 動物の置き場（z = −0.20）の間に収まっていることを測る側が使う
 */
const PLANE_DEPTH = 0.04;

/**
 * 板を、置き場（`animalZ`）よりどれだけ手前へ出すか。
 *
 * **これが無いと、出きっても体が前板の裏に隠れる。**
 * 手続き生成の動物は厚み 0.4 を持っていて z = −0.4〜0.0 を占めるので、
 * 前板（z = +0.22）との隙間が詰まっていた。板には厚みが無いので
 * `animalZ`（−0.20）ちょうどに立ち、0.2 ぶん奥に下がる。
 * 見下ろし 11.8° のカメラでは、そのぶん前板に食われる（実測で、
 * ねこは耳しか見えなかった）。前板より手前には出さない。
 */
const FORWARD = 0.26;

/**
 * 透明・不透明の境目。
 * **`transparent: true` にしないこと。** 半透明にすると描画順の問題が出て、
 * 隠れ場所のふたと前後が入れ替わる回ができる。参照画像は輪郭線つきで
 * 境目がはっきりしているので、閾値で切って困らない
 */
const ALPHA_TEST = 0.5;

/** 上側だけを写す板を作る（ヒント用）。テクスチャは複製しない */
function topSlicePlane(w: number, h: number, fraction: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, h * fraction);
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    // v を上端側の `fraction` に押し込む
    uv.setY(i, 1 - fraction + uv.getY(i) * fraction);
  }
  uv.needsUpdate = true;
  // 原点を下端に。`AnimalSystem` は hint.position.y = 体の高さ として置く
  geo.translate(0, (h * fraction) / 2, 0);
  return new THREE.Mesh(geo, mat);
}

export function createCutoutAnimal(cfg: AnimalConfig, texture: THREE.Texture): ProceduralAnimal {
  const group = new THREE.Group();

  texture.colorSpace = THREE.SRGBColorSpace;
  // 絵は等倍以下でしか使わないので、拡大側は滑らかに、縮小側はミップで
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;

  const image = texture.image as { width?: number; height?: number } | null;
  const texW = image?.width ?? 1;
  const texH = image?.height ?? 1;

  const height = cfg.bodyHeight ?? 0.9;
  const width = height * (texW / texH);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    alphaTest: ALPHA_TEST,
    transparent: false,
    // 反転して使う場面はないが、裏を向いたときに消えるほうが分かりにくい
    side: THREE.DoubleSide,
    // **トーンマッピングを通さない。** 参照画像の色をそのまま出す
    toneMapped: false,
  });

  const bodyGeo = new THREE.PlaneGeometry(width, height);
  // 原点を足元に（`createProceduralAnimal` と同じ約束）
  bodyGeo.translate(0, height / 2, 0);
  const body = new THREE.Mesh(bodyGeo, material);
  body.position.z = FORWARD;
  body.name = `cutout.${cfg.id}`;
  group.add(body);

  // 視線の行き先だけ持たせる。**板は回さない**（回すと絵が潰れる）
  const head = new THREE.Object3D();
  head.position.set(0, height * 0.78, 0);
  group.add(head);

  const hintHeight = height * HINT_EXPOSURE;
  const hint = topSlicePlane(width, height, HINT_EXPOSURE, material);
  hint.name = `cutout.hint.${cfg.id}`;
  // **頭の上に載せること。** ここを書き忘れて足元（y=0）に置いたら、
  // 縁より上に出る部分が無くなり、25体すべてで はみ出しが 0.000 になった。
  // 不変条件3（隠れていても体の一部が見えている）が丸ごと死ぬ。
  // 単体テストは素材を読めないので手続き生成のほうしか見ておらず、
  // **実機で測るまで気づけなかった**
  hint.position.y = height;
  group.add(hint);

  return {
    group,
    height,
    width,
    depth: PLANE_DEPTH,
    head,
    // **カメラを向かせない。** 板を回すと絵が横に潰れる。
    // 正面から最大 17° しか外れないので、向かせる必要もない
    gazeStrength: 0,
    hint,
    hintHeight,
    // **隠れ場所に合わせて大きさを決め直させる。**
    // 絵の縦横比は先に決まっているので、幅と高さの制約から
    // いちばん大きく収まる倍率を `AnimalSystem` が出す
    autoFit: true,
    setGlow(amount) {
      // `MeshBasicMaterial` に emissive は無いので、色を 1 より上げて明るくする。
      // **加算の光を足さない**（体色が飛ぶ。CLAUDE.md の実測）
      const a = Math.max(0, Math.min(1, amount)) * 0.4;
      material.color.setScalar(1 + a);
    },
    dispose() {
      // **テクスチャは `AssetLoader` が持っている。** ここで捨てない
      // （場面を作り直すたびに読み直しになる）
      disposeObject3D(group, { keepTextures: true });
    },
  };
}
