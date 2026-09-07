/**
 * 場の見た目（道D / 2026-09-06）
 *
 * ==========================================================================
 * 実機で見て「フィールドの安っぽさがすごくわかる」と言われた。
 * 原因は3つあって、どれも**素材ではなく設定**だった。
 *
 *  ① 背景が単色 #12203a の1枚板。空も地面も奥行きも無い
 *  ② **接地影が1つも無い**（`shadowMap.enabled = false`）。
 *     隠れ場所が宙に浮いて見える
 *  ③ 環境マップが無いので `metalness` / `roughness` が何も返さない
 *     （みずのなかで実測: 0.08 → 0.16 に上げてもハイライトの面積が
 *      0.0324 → 0.0319 とまったく動かなかった）
 *
 * ここでは ①② を、**素材ファイルを1つも足さずに**直す。
 * どちらも手続き生成のテクスチャなので、`public/` は空のままでよい（不変条件7）。
 *
 * shadowMap は使わない。スマホでいちばん高くつくうえ、
 * この app は光源1つ・カメラ固定なので、**影の形は動かない**。
 * 動かない影を毎フレーム描き直す理由が無い。
 * ==========================================================================
 */

import * as THREE from 'three';

/** 生成するテクスチャの大きさ。グラデーションなので小さくてよい */
const BACKDROP_SIZE = 64;
const SHADOW_SIZE = 128;

/**
 * 背景。上を明るく、下を暗くした縦のグラデーション。
 *
 * **横方向にも少しだけ変える。** 完全な横一様にすると、
 * 画面の端まで同じ帯が続いて「板」に見える。
 */
export function createBackdropTexture(top: string, bottom: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = BACKDROP_SIZE;
  canvas.height = BACKDROP_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);

  const grad = ctx.createLinearGradient(0, 0, 0, BACKDROP_SIZE);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, BACKDROP_SIZE, BACKDROP_SIZE);

  // 中央を少しだけ明るく（周辺減光の逆）。奥行きが出る
  const glow = ctx.createRadialGradient(
    BACKDROP_SIZE / 2,
    BACKDROP_SIZE * 0.42,
    0,
    BACKDROP_SIZE / 2,
    BACKDROP_SIZE * 0.42,
    BACKDROP_SIZE * 0.72
  );
  glow.addColorStop(0, 'rgba(255,255,255,0.13)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, BACKDROP_SIZE, BACKDROP_SIZE);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 接地影。中心が濃く、外へ向かって消える楕円 */
export function createShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SHADOW_SIZE;
  canvas.height = SHADOW_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);

  const r = SHADOW_SIZE / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  // **真っ黒にしない。** 背景より少し暗い程度で足りる。
  // 濃い影は「切り絵を紙に置いた」ように見える
  grad.addColorStop(0, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.16)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SHADOW_SIZE, SHADOW_SIZE);

  return new THREE.CanvasTexture(canvas);
}

/**
 * 隠れ場所の足元に敷く影を1枚作る。
 *
 * `shadowMap` は使わない（上の理由）。板に楕円を貼って、
 * 隠れ場所より少しだけ手前・少しだけ下に置くだけ。
 */
export function createContactShadow(texture: THREE.Texture, width: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  // **地面の影ではなく、背後の落ち影にする。**
  // この場面は隠れ場所が縦に並ぶ 2.5D の配置で、足元に地面が無い。
  // 水平に寝かせた楕円はカメラ（見下ろし 11.8°）から見て潰れて見えず、
  // 実際に1枚も見えなかった。板は立てたまま、少し下・少し奥に置く
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 0.62), mat);
  mesh.name = 'contactShadow';
  mesh.renderOrder = -1;
  return mesh;
}

/* --- 背景の絵（`SceneConfig.backgroundUrl`）------------------------------- */

/**
 * 背景の絵を敷く板の大きさ（ワールド）。
 *
 * ==========================================================================
 * **縦横比を崩さないこと。** 手続き生成のグラデーションは 16×16 の
 * 正方形の板に貼っているが、そこに縦長の絵を貼ると横に潰れる。
 *
 * 画面に入る範囲は実測で決めた（2026-09-07）。縦持ちのカメラは
 * fov 66°・アスペクト 0.49 で、この奥行き（z = -1.55、カメラから 8.75）では
 * **縦 11.36・横 5.57**。8% の余白を足したものを覆えばよい。
 *
 * 絵より板を大きくしない（＝拡大しない）。拡大すると、絵のうち画面に
 * 出る割合が減って、せっかく描いた端が見えなくなる。
 * **横持ちでは板が画面の幅に足りない**が、うしろに従来のグラデーションの
 * 板が残っているので、地の色が出ることはない。
 * ==========================================================================
 */
export function backdropImageSize(aspect: number): { width: number; height: number } {
  const NEED_W = 5.57 * 1.08;
  const NEED_H = 11.36 * 1.08;
  const height = Math.max(NEED_H, NEED_W / Math.max(0.01, aspect));
  return { width: height * aspect, height };
}

/**
 * 背景の絵の板。
 *
 * **光を当てない**（`MeshBasicMaterial` ＋ `toneMapped = false`）。
 * 描いたとおりの色を出すため。動物の絵（道A）とまったく同じ理由で、
 * 上から光を足すと絵の色が変わる（CLAUDE.md「加算で足す光は、体色を消す」）。
 */
export function createBackdropImage(texture: THREE.Texture): THREE.Mesh {
  const image = texture.image as { width?: number; height?: number } | null;
  const aspect = (image?.width ?? 1) / (image?.height ?? 1);
  const { width, height } = backdropImageSize(aspect);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
  );
  mesh.name = 'backdrop.image';
  // グラデーションの板（z = -1.6）のすぐ手前。隠れ場所より奥
  mesh.position.set(0, 0, -1.55);
  mesh.rotation.x = -0.12;
  return mesh;
}
