/**
 * 参照画像と突き合わせるための静止ポーズ撮影（`docs/match-gate.md` §3-1）
 *
 * ==========================================================================
 * **アプリ本体には入らない。** `capture.html` からだけ読み込まれ、
 * `vite build` の入口（`index.html`）からは辿れないので `dist` にも入らない。
 *
 * ここが守っていること:
 *
 *  - **平行投影で撮る。** 参照画像を平行投影で生成させたので、
 *    透視投影で撮ると同じ動物でも輪郭が一致しない
 *  - **カメラを回す。動物は回さない。** 動物を回すと光の当たり方が向きごとに
 *    変わってしまい、M3（配色）が向きの違いを色の違いとして拾う。
 *    光は `App.ts` と同じ位置に置いたまま、カメラだけを回す
 *  - **枠合わせはカメラ空間の頂点から測る。** ワールドの `Box3` を
 *    カメラ空間に入れ直すと、回した角度ぶん実際より大きい箱になり、
 *    向きによって動物の大きさが変わる
 *  - **背景を描かない（アルファ 0）。** アルファがそのままマスクになるので、
 *    アプリ側に切り抜き（`ref-cut`）が要らない
 *  - **1回だけ描いて止まる。** 時間で動くものを1つも持たない。
 *    これが `--pose reference` を2回撮ってバイト単位で一致させる条件
 *
 * TODO(Step 6 / M5): 接地影を測るときは地面を出す必要がある。
 *   `Renderer.ts` は `shadowMap.enabled = false` なので、
 *   ここで影を出すには別途 shadowMap を有効にした撮影経路を足す。
 *   M1・M2 を通してから作る（先に足すと、形の差か影の差か切り分けられない）。
 * ==========================================================================
 */

import * as THREE from 'three';

import { ANIMALS, findAnimal } from '../data/animals';
import { createProceduralAnimal } from '../peekaboo/ProceduralAnimals';

/** 参照画像と同じ3つの向き */
export type PoseView = 'side' | 'front' | 'three-quarter';

/**
 * 動物の高さが画面に占める割合。
 * 参照画像側も切り抜いたあと同じ割合に正規化してから重ねる（M1）。
 * 1.0 にすると輪郭が枠に触れて、アンチエイリアスの帯が切れる。
 */
const FILL = 0.82;

/** 撮影サイズ。正方形。大きくすると IoU の分解能は上がるが撮影が遅くなる */
const SIZE = 512;

/** カメラの距離。平行投影なので見た目には影響しない。near/far に余裕を持たせるためだけ */
const CAM_DISTANCE = 10;

/**
 * 向き → カメラの方位角（ラジアン）。カメラは
 * `center + (sin az, 0, cos az) * 距離` に立つ。
 *
 * **符号を勘で決めないこと。** 動物は +Z を向いて作られているが、
 * `+PI/2`（カメラを +X に置く）で撮ると**顔が画面の左に来る**。実際に撮って
 * 確かめた。参照画像の側面図は右を向いているので、こちらは負にする。
 */
const AZIMUTH: Record<PoseView, number> = {
  // 正面。動物と正対する
  front: 0,
  // 側面。**動物が画面の右を向く**（参照画像の側面図と同じ向き）
  side: -Math.PI / 2,
  // 斜め。正面と側面の中間で、顔は画面の右を向く
  'three-quarter': -Math.PI / 4,
};

export interface CaptureResult {
  animal: string;
  view: PoseView;
  size: number;
  /** PNG（アルファ付き）の data URL */
  dataUrl: string;
  /** ジオメトリの実寸。M2 はここから出す（画素から推定しない） */
  worldHeight: number;
  worldWidth: number;
  worldDepth: number;
  /** 画面に写っている動物の、画素での境界箱 */
  pixelWidth: number;
  pixelHeight: number;
  triangles: number;
}

declare global {
  interface Window {
    __captureAnimals?: readonly string[];
    __capture?: CaptureResult;
    __captureError?: string;
  }
}

/** 使い捨てのベクトル。毎フレームは走らないが、作法を揃えておく */
const _v = new THREE.Vector3();
/** ワールド空間で測るときに渡す単位行列 */
const _identity = new THREE.Matrix4();

/** 親をたどって、どこかが非表示なら非表示 */
function visibleInTree(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    if (cur === root) return true;
    cur = cur.parent;
  }
  return true;
}

/**
 * **見えているメッシュの頂点だけ**から測った境界箱。`m` を掛けた空間で返す。
 *
 * 罠が2つある。
 *
 * ① `Box3.setFromObject()` は `visible` を見ないので、隠したヒント
 *    （縁から出る部分）まで箱に入る。中心がずれて動物が枠の中で偏る。
 * ② ワールドの箱を回してカメラ空間に入れ直すと、45度では箱の対角が幅として
 *    出る。`three-quarter` だけ動物が小さく写る。**頂点から測り直すこと。**
 */
function visibleBounds(root: THREE.Object3D, m: THREE.Matrix4): THREE.Box3 {
  const box = new THREE.Box3();
  box.makeEmpty();
  root.updateMatrixWorld(true);

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!visibleInTree(obj, root)) return;
    const pos = obj.geometry.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      _v.applyMatrix4(obj.matrixWorld).applyMatrix4(m);
      box.expandByPoint(_v);
    }
  });
  return box;
}

export function capture(animalId: string, view: PoseView): CaptureResult {
  const cfg = findAnimal(animalId);
  if (!cfg) throw new Error(`知らない動物です: ${animalId}`);

  const scene = new THREE.Scene();
  // 背景は描かない。アルファがマスクになる
  scene.background = null;

  // **`App.ts` と同じ光。** ここを変えると M3 が別のものを測る
  const key = new THREE.DirectionalLight(0xfff3e2, 1.6);
  key.position.set(0.4, 1.2, 1.0);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xdceeff, 0x4a4436, 1.1));

  const animal = createProceduralAnimal(cfg);
  // ヒント（隠れているときに縁から出る部分）は参照画像に無い概念なので隠す
  animal.hint.visible = false;
  animal.setGlow(0);
  scene.add(animal.group);
  scene.updateMatrixWorld(true);

  // 動物の中心（ワールド）。カメラはこの周りを回る。
  // **隠したヒントを含めない**ので `setFromObject` は使わない
  const worldBox = visibleBounds(animal.group, _identity);
  const center = worldBox.getCenter(new THREE.Vector3());

  const az = AZIMUTH[view];
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, CAM_DISTANCE * 4);
  camera.position.set(
    center.x + Math.sin(az) * CAM_DISTANCE,
    center.y,
    center.z + Math.cos(az) * CAM_DISTANCE,
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  // 枠合わせ。**カメラ空間の頂点から測る**
  const bounds = visibleBounds(animal.group, camera.matrixWorldInverse);
  const bw = bounds.max.x - bounds.min.x;
  const bh = bounds.max.y - bounds.min.y;
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;

  // **縦と横の広いほうに合わせる。**
  //
  // 高さだけで合わせていたら、**横に広い動物が枠で切れた**。
  // ちょうちょ・かえる・はりねずみ・ひつじの4体が、どれも縦横比 1.219
  // （＝ 512 ÷ (512×0.82)）という同じ値になっていて気づいた。
  // 枠の縁で切られると、いくら形を直しても縦横比がその値から動かない。
  // 高さの画面占有は動物ごとに変わるが、M1 は外接矩形の高さで
  // 正規化し直すので影響しない。
  const half = Math.max(bh, bw) / 2 / FILL;
  const halfH = half;
  const halfW = half; // 正方形
  camera.left = cx - halfW;
  camera.right = cx + halfW;
  camera.top = cy + halfH;
  camera.bottom = cy - halfH;
  camera.updateProjectionMatrix();

  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    // 輪郭のギザギザは IoU に直接効く。撮影は1枚なので惜しまない
    antialias: true,
    alpha: true,
    // **toDataURL で読むので true が要る。** アプリ本体は false のまま
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  // **アプリと同じ色の出し方。** ここがずれると M3 が別物になる
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = false;
  renderer.info.autoReset = false;

  renderer.info.reset();
  renderer.render(scene, camera);
  const triangles = renderer.info.render.triangles;
  const dataUrl = canvas.toDataURL('image/png');

  const pixelPerUnit = SIZE / (halfH * 2);
  const result: CaptureResult = {
    animal: animalId,
    view,
    size: SIZE,
    dataUrl,
    // **ジオメトリの実寸。** M2 はここから出す（画素から推定しない）
    worldHeight: animal.height,
    worldWidth: animal.width,
    worldDepth: animal.depth,
    pixelWidth: bw * pixelPerUnit,
    pixelHeight: bh * pixelPerUnit,
    triangles,
  };

  // 撮り終わったら必ず捨てる（不変条件8）
  scene.remove(animal.group);
  animal.dispose();
  renderer.dispose();

  return result;
}

/** `capture.html` から呼ばれる入口。クエリで動物と向きを指定する */
export function main(): void {
  window.__captureAnimals = ANIMALS.map((a) => a.id);
  const params = new URLSearchParams(window.location.search);
  const animalId = params.get('animal');
  if (!animalId) return; // 一覧を取りたいだけの呼び出し

  const view = (params.get('view') ?? 'side') as PoseView;
  try {
    window.__capture = capture(animalId, view);
  } catch (err) {
    // **例外を画面に出さない**（§2）。呼び出し側が読める場所に置くだけ
    window.__captureError = err instanceof Error ? err.message : String(err);
  }
}

main();
