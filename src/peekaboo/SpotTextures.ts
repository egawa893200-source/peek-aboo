/**
 * 隠れ場所の表面（手続き生成 / 2026-09-07）
 *
 * ==========================================================================
 * **「チープに見える」の正体は、面に材質が無いこと。**
 *
 * 隠れ場所は無地の `MeshStandardMaterial` を貼った板と箱で、
 * 木にも布にも石にも見えない。背景の絵（人が描いたもの）は木目も布の襞も
 * 持っているので、並べると隠れ場所だけがプラスチックに見える。
 *
 * ここは**素材ファイルを1つも足さずに**直す（不変条件7）。
 * `Backdrop.createBackdropTexture()` と同じで、canvas に描いて
 * `CanvasTexture` にするだけ。`public/` は空のままでよい。
 *
 * **隠れ場所ごとに種を変えて作る。** 同じ形が5つ並ぶ のはら で、
 * まったく同じ模様だと「判で押した」ように見える。
 * 共有してキャッシュしないのは、`disposeObject3D()` が
 * material の抱えるテクスチャを捨てるため（共有すると、1つ捨てたときに
 * 残りが真っ黒になる）。1場面で 4〜5枚・256×256 なので安い。
 *
 * `document` が無い環境（単体テストの node）では **null を返す**。
 * 呼ぶ側は map を貼らずに進む（例外を投げない）。
 * ==========================================================================
 */

import * as THREE from 'three';

import type { SpotKind } from '../types';

/** 生成するテクスチャの一辺。模様は繰り返して貼るので大きくしなくてよい */
const SIZE = 256;

export interface SurfaceTexture {
  texture: THREE.Texture;
  /**
   * 線形空間での平均の明るさ。
   *
   * `map` は `color` に**掛け算**されるので、貼るとその平均のぶんだけ暗くなる。
   * 呼ぶ側が `color` を 1/mean 倍して打ち消す。
   * **これをやらないと、模様を入れただけで場面ぜんぶが暗くなる**
   * （＝背景との明度差 V1 が落ちて、見つけにくくなる）。
   */
  mean: number;
}

/** 種から作る乱数（みずのなかと同じ mulberry32）。**共有の乱数を使わない** */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 端をまたいでも模様が繋がるように、9通りの位置に同じものを描く */
function tiled(ctx: CanvasRenderingContext2D, draw: (dx: number, dy: number) => void): void {
  for (let ix = -1; ix <= 1; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      draw(ix * SIZE, iy * SIZE);
    }
  }
  void ctx;
}

function blob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  style: string
): void {
  ctx.fillStyle = style;
  tiled(ctx, (dx, dy) => {
    ctx.beginPath();
    ctx.ellipse(x + dx, y + dy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** 縦に走る線。木目・布の襞に使う */
function streak(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  style: string,
  wobble: number,
  rng: () => number
): void {
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  const phase = rng() * Math.PI * 2;
  const amp = wobble * (0.5 + rng());
  for (const dx of [-SIZE, 0, SIZE]) {
    ctx.beginPath();
    for (let y = 0; y <= SIZE; y += 8) {
      const px = x + dx + Math.sin(phase + (y / SIZE) * Math.PI * 2) * amp;
      if (y === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
  }
}

type Painter = (ctx: CanvasRenderingContext2D, rng: () => number) => void;

/** 板を横に張った箱。**継ぎ目を強く**（ここが L\* の幅をいちばん作る） */
const plank: Painter = (ctx, rng) => {
  const rows = 4;
  for (let i = 0; i < rows; i++) {
    const y0 = (i * SIZE) / rows;
    // 板ごとに明るさを変える。同じ板が並ぶと「壁紙」に見える
    const tone = 0.94 + rng() * 0.1;
    ctx.fillStyle = `rgba(255,255,255,0)`;
    ctx.fillRect(0, y0, SIZE, SIZE / rows);
    ctx.fillStyle = tone < 1 ? `rgba(0,0,0,${(1 - tone).toFixed(3)})` : `rgba(255,255,255,${(tone - 1).toFixed(3)})`;
    ctx.fillRect(0, y0, SIZE, SIZE / rows);
    // 継ぎ目
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(0, y0 - 1.5, SIZE, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(0, y0 + 1.5, SIZE, 2);
  }
  // 板目
  for (let i = 0; i < 22; i++) {
    const y = rng() * SIZE;
    ctx.strokeStyle = `rgba(0,0,0,${(0.04 + rng() * 0.07).toFixed(3)})`;
    ctx.lineWidth = 0.8 + rng();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(SIZE * 0.3, y + (rng() - 0.5) * 6, SIZE * 0.7, y + (rng() - 0.5) * 6, SIZE, y);
    ctx.stroke();
  }
};

/** 縦の木目。とびら・きのほら */
const wood: Painter = (ctx, rng) => {
  for (let i = 0; i < 7; i++) {
    const x = (i * SIZE) / 7 + rng() * 6;
    const tone = 0.93 + rng() * 0.12;
    ctx.fillStyle =
      tone < 1 ? `rgba(0,0,0,${(1 - tone).toFixed(3)})` : `rgba(255,255,255,${(tone - 1).toFixed(3)})`;
    ctx.fillRect(x, 0, SIZE / 7, SIZE);
    streak(ctx, x, 2.5, 'rgba(0,0,0,0.26)', 2, rng);
  }
  for (let i = 0; i < 34; i++) {
    streak(ctx, rng() * SIZE, 0.7 + rng() * 1.4, `rgba(0,0,0,${(0.05 + rng() * 0.08).toFixed(3)})`, 5, rng);
  }
  // 節。1つだけ。多いと模様に見える
  const kx = rng() * SIZE;
  const ky = rng() * SIZE;
  for (let r = 11; r > 2; r -= 3) {
    ctx.strokeStyle = `rgba(0,0,0,${(0.1 + (11 - r) * 0.02).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    tiled(ctx, (dx, dy) => {
      ctx.beginPath();
      ctx.ellipse(kx + dx, ky + dy, r, r * 1.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
};

/** 布の襞。カーテン・ふとん。**縦のゆるい山谷**で作る */
const fabric: Painter = (ctx, rng) => {
  const folds = 5 + Math.floor(rng() * 3);
  for (let i = 0; i < folds; i++) {
    const x = (i * SIZE) / folds;
    const w = SIZE / folds;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.22)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g;
    for (const dx of [-SIZE, 0, SIZE]) ctx.fillRect(x + dx, 0, w, SIZE);
  }
  // 織り目。ごく薄く
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i += 5) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(SIZE, i);
    ctx.stroke();
  }
};

/** 石。まだらと、ひび */
const stone: Painter = (ctx, rng) => {
  for (let i = 0; i < 40; i++) {
    const dark = rng() < 0.5;
    blob(
      ctx,
      rng() * SIZE,
      rng() * SIZE,
      12 + rng() * 34,
      10 + rng() * 28,
      dark ? `rgba(0,0,0,${(0.05 + rng() * 0.1).toFixed(3)})` : `rgba(255,255,255,${(0.05 + rng() * 0.1).toFixed(3)})`
    );
  }
  for (let i = 0; i < 220; i++) {
    blob(ctx, rng() * SIZE, rng() * SIZE, 1 + rng() * 2, 1 + rng() * 2, `rgba(0,0,0,${(0.06 + rng() * 0.12).toFixed(3)})`);
  }
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1.2 + rng();
    let x = rng() * SIZE;
    let y = rng() * SIZE;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (rng() - 0.5) * 60;
      y += (rng() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};

/** 葉のかたまり。くさむら・しだ・かいそう */
const foliage: Painter = (ctx, rng) => {
  for (let i = 0; i < 70; i++) {
    const dark = rng() < 0.55;
    const r = 9 + rng() * 22;
    blob(
      ctx,
      rng() * SIZE,
      rng() * SIZE,
      r,
      r * (0.5 + rng() * 0.6),
      dark ? `rgba(0,0,0,${(0.07 + rng() * 0.14).toFixed(3)})` : `rgba(255,255,255,${(0.06 + rng() * 0.12).toFixed(3)})`
    );
  }
  // 葉脈のような細い線
  for (let i = 0; i < 26; i++) {
    streak(ctx, rng() * SIZE, 1 + rng(), `rgba(0,0,0,${(0.07 + rng() * 0.08).toFixed(3)})`, 9, rng);
  }
};

/** 水面。横に流れる波 */
const water: Painter = (ctx, rng) => {
  for (let i = 0; i < 26; i++) {
    const y = rng() * SIZE;
    const h = 3 + rng() * 12;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    const light = rng() < 0.5;
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, light ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    for (const dy of [-SIZE, 0, SIZE]) ctx.fillRect(0, y + dy, SIZE, h);
  }
};

/** 素焼き。轆轤の輪と、焼きむら */
const clay: Painter = (ctx, rng) => {
  for (let i = 0; i < 16; i++) {
    const y = (i * SIZE) / 16 + rng() * 3;
    ctx.fillStyle = `rgba(0,0,0,${(0.05 + rng() * 0.06).toFixed(3)})`;
    for (const dy of [-SIZE, 0, SIZE]) ctx.fillRect(0, y + dy, SIZE, 2.5);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (const dy of [-SIZE, 0, SIZE]) ctx.fillRect(0, y + dy + 2.5, SIZE, 2);
  }
  for (let i = 0; i < 26; i++) {
    blob(ctx, rng() * SIZE, rng() * SIZE, 14 + rng() * 30, 10 + rng() * 20, `rgba(0,0,0,${(0.04 + rng() * 0.07).toFixed(3)})`);
  }
};

/** 殻。細かい斑点だけ（たまごは形そのものが主役なので模様を強くしない） */
const shell: Painter = (ctx, rng) => {
  for (let i = 0; i < 180; i++) {
    blob(ctx, rng() * SIZE, rng() * SIZE, 1 + rng() * 3, 1 + rng() * 3, `rgba(0,0,0,${(0.05 + rng() * 0.09).toFixed(3)})`);
  }
  for (let i = 0; i < 14; i++) {
    blob(ctx, rng() * SIZE, rng() * SIZE, 18 + rng() * 26, 16 + rng() * 22, 'rgba(0,0,0,0.035)');
  }
};

const PAINTERS: Record<SpotKind, Painter> = {
  box: plank,
  door: wood,
  hollow: wood,
  curtain: fabric,
  blanket: fabric,
  bush: foliage,
  rock: stone,
  water,
  pot: clay,
  egg: shell,
};

/**
 * 隠れ場所1つぶんの表面を作る。
 *
 * **`document` が無ければ null。** 単体テストは node で走るので、
 * ここで例外を投げるとテストが1つも動かなくなる（不変条件7 と同じ考え）。
 */
export function createSurfaceTexture(kind: SpotKind, seed: number): SurfaceTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  (PAINTERS[kind] ?? plank)(ctx, mulberry32(seed));

  // 線形空間での平均。**sRGB のまま平均を取らない**
  // （掛け算は線形空間で起きるので、sRGB の平均だと補正がずれる）
  let sum = 0;
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  for (let i = 0; i < data.length; i += 4) {
    const s = data[i] / 255;
    sum += s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }
  const mean = Math.max(0.2, sum / (SIZE * SIZE));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return { texture, mean };
}
