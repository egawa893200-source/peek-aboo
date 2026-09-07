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

/**
 * 下地の明るさ。
 *
 * ==========================================================================
 * **白から描き始めない**（2026-09-07 に実測して直した）。
 * 白の上に白を重ねても何も変わらないので、模様が「暗くする側」しか効かず、
 * 板ごとの明暗を ±5% 振っているつもりが実際は −5%〜0% しか出ていなかった。
 * はこ の内部の L\* の四分位範囲が 3.59 から動かなかった原因がこれ。
 *
 * 中間の灰から描くと、明るくする側も効いて幅が倍になる。
 * 全体が暗くなるぶんは `mean` を測って呼ぶ側が打ち消すので、
 * 下地を暗くしても場面は暗くならない。
 * ==========================================================================
 */
const BASE = '#c6c6c6';

/** 符号つきの重ね塗り。`+` で明るく、`-` で暗く */
function tone(amount: number): string {
  return amount >= 0
    ? `rgba(255,255,255,${amount.toFixed(3)})`
    : `rgba(0,0,0,${(-amount).toFixed(3)})`;
}

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
  // **細かく刻まないこと。** 1タイル（0.85）に4枚だと板1枚が画面 26px になり、
  // 継ぎ目の明るいふちと合わさって**波板シャッター**に見えた（判定の指摘）。
  // 2枚なら 53px で、木箱の板らしい間隔になる
  const rows = 2;
  const h = SIZE / rows;
  for (let i = 0; i < rows; i++) {
    const y0 = i * h;
    // 板ごとに明るさを変える。同じ板が並ぶと「壁紙」に見える
    ctx.fillStyle = tone((rng() * 2 - 1) * 0.23);
    ctx.fillRect(0, y0, SIZE, h);
    // 板1枚の中の丸み。上が明るく、下が暗い。**ここが明暗の幅をいちばん作る**
    const round = ctx.createLinearGradient(0, y0, 0, y0 + h);
    round.addColorStop(0, 'rgba(255,255,255,0.27)');
    round.addColorStop(0.42, 'rgba(255,255,255,0.05)');
    round.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = round;
    ctx.fillRect(0, y0, SIZE, h);
    // 継ぎ目
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(0, y0 - 1.5, SIZE, 3);
    // **明るいふちを強くしない。** 継ぎ目ごとに光る筋が入ると金属に見える
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
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
    ctx.fillStyle = tone((rng() * 2 - 1) * 0.19);
    ctx.fillRect(x, 0, SIZE / 7, SIZE);
    // 板1枚の中の丸み（縦の板なので左右に振る）
    const round = ctx.createLinearGradient(x, 0, x + SIZE / 7, 0);
    round.addColorStop(0, 'rgba(0,0,0,0.16)');
    round.addColorStop(0.4, 'rgba(255,255,255,0.18)');
    round.addColorStop(1, 'rgba(0,0,0,0.16)');
    ctx.fillStyle = round;
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
  // ==========================================================================
  // **等間隔の山谷にしないこと。**
  // 幅をそろえた襞を並べると、隣り合う襞の暗い端どうしが1本の濃い線になり、
  // 布ではなく**トタン板**に見える（判定で実機の絵を見て指摘された）。
  //
  // 襞の位置も幅も不揃いにして、山（明るい帯）と皺（細い暗い線）を
  // 別々に置く。境目を作らないので、隣とゆるくつながる。
  // ==========================================================================
  const peaks = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < peaks; i++) {
    const x = ((i + rng() * 0.8 - 0.4) * SIZE) / peaks;
    const w = SIZE / peaks * (0.7 + rng() * 0.8);
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${(0.30 + rng() * 0.20).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    for (const dx of [-SIZE, 0, SIZE]) ctx.fillRect(x - w / 2 + dx, 0, w, SIZE);
  }
  // 皺。山のあいだに、細く柔らかい影を落とす
  for (let i = 0; i < peaks + 2; i++) {
    const x = rng() * SIZE;
    const w = 8 + rng() * 26;
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, `rgba(0,0,0,${(0.16 + rng() * 0.16).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-SIZE, 0, SIZE]) ctx.fillRect(x - w / 2 + dx, 0, w, SIZE);
  }
  // 織り目。ごく薄く
  ctx.strokeStyle = 'rgba(0,0,0,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i += 5) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(SIZE, i);
    ctx.stroke();
  }
};

/**
 * 掛け布団。**カーテンと同じ縦の襞にしない。**
 * 掛かっている布は縦に落ちるが、掛け布団はふくらむ。
 * 縦の襞を当てていたら「塗装した波板・樹脂の道具箱」と言われた（判定）。
 */
const quilt: Painter = (ctx, rng) => {
  const cells = 3;
  for (let gy = -1; gy <= cells; gy++) {
    for (let gx = -1; gx <= cells; gx++) {
      const x = ((gx + 0.5 + (rng() - 0.5) * 0.4) * SIZE) / cells;
      const y = ((gy + 0.5 + (rng() - 0.5) * 0.4) * SIZE) / cells;
      const r = (SIZE / cells) * (0.45 + rng() * 0.25);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${(0.24 + rng() * 0.16).toFixed(3)})`);
      g.addColorStop(0.66, 'rgba(255,255,255,0.04)');
      g.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 縫い目。斜めに、ごく薄く
  ctx.strokeStyle = 'rgba(0,0,0,0.055)';
  ctx.lineWidth = 1.2;
  for (let i = -cells; i <= cells * 2; i++) {
    const at = (i * SIZE) / cells;
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at + SIZE, SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(at, SIZE);
    ctx.lineTo(at + SIZE, 0);
    ctx.stroke();
  }
};

/** 石。まだらと、ひび */
const stone: Painter = (ctx, rng) => {
  // **こぶ大の斑点にしないこと。** 板に平面投影しているので、模様は
  // 球の継ぎ目をまたいで直進する。大きい斑点だと
  // 「迷彩柄を印刷した板」に見える（判定の指摘）。細かい粒にすると
  // 石の目に見えて、投影のゆがみも目立たない
  for (let i = 0; i < 46; i++) {
    const dark = rng() < 0.5;
    blob(
      ctx,
      rng() * SIZE,
      rng() * SIZE,
      5 + rng() * 14,
      4 + rng() * 12,
      dark ? `rgba(0,0,0,${(0.06 + rng() * 0.14).toFixed(3)})` : `rgba(255,255,255,${(0.06 + rng() * 0.16).toFixed(3)})`
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
      dark ? `rgba(0,0,0,${(0.08 + rng() * 0.16).toFixed(3)})` : `rgba(255,255,255,${(0.08 + rng() * 0.18).toFixed(3)})`
    );
  }
  // 葉脈のような細い線
  for (let i = 0; i < 26; i++) {
    streak(ctx, rng() * SIZE, 1 + rng(), `rgba(0,0,0,${(0.07 + rng() * 0.08).toFixed(3)})`, 9, rng);
  }
};

/** 水面。横に流れる波 */
const water: Painter = (ctx, rng) => {
  // **横に流れる波だけでは板のまま。**
  // 判定の実測: 幅 180px のあいだ平均 rgb が 2/255 しか動かず
  // 「濃い青の板」に見えていた。斜めに差す光の筋を入れて、
  // 横方向にも明暗を作る
  for (let i = 0; i < 7; i++) {
    const x = rng() * SIZE;
    const w = 14 + rng() * 30;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${(0.22 + rng() * 0.22).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    for (const dx of [-SIZE, 0, SIZE]) {
      ctx.save();
      ctx.translate(dx, 0);
      ctx.transform(1, 0, -0.22, 1, 0, 0);
      ctx.fillRect(x - 40, -SIZE, w, SIZE * 3);
      ctx.restore();
    }
  }
  // 波。うねらせる（まっすぐな帯は「縞の印刷」に見える）
  for (let i = 0; i < 30; i++) {
    const y = rng() * SIZE;
    const h = 3 + rng() * 10;
    const light = rng() < 0.5;
    ctx.strokeStyle = light
      ? `rgba(255,255,255,${(0.16 + rng() * 0.2).toFixed(3)})`
      : `rgba(0,0,0,${(0.12 + rng() * 0.16).toFixed(3)})`;
    ctx.lineWidth = h;
    const amp = 3 + rng() * 7;
    const phase = rng() * Math.PI * 2;
    for (const dy of [-SIZE, 0, SIZE]) {
      ctx.beginPath();
      for (let x = 0; x <= SIZE; x += 8) {
        const py = y + dy + Math.sin(phase + (x / SIZE) * Math.PI * 2) * amp;
        if (x === 0) ctx.moveTo(x, py);
        else ctx.lineTo(x, py);
      }
      ctx.stroke();
    }
  }
};

/** 素焼き。轆轤の輪と、焼きむら */
const clay: Painter = (ctx, rng) => {
  // **等間隔の細い溝を刻まないこと。** 16本／タイルだと溝の間隔が画面 6.6px になり、
  // 「旋盤で挽いたプラスチックの鉢」に見えた（判定の指摘）。
  // 手びねりの素焼きらしく、太さも間隔も不揃いの、ぼやけた輪にする
  for (let i = 0; i < 6; i++) {
    const y = (i * SIZE) / 6 + rng() * 14;
    const h = 3 + rng() * 7;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, `rgba(0,0,0,${(0.07 + rng() * 0.07).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dy of [-SIZE, 0, SIZE]) ctx.fillRect(0, y + dy, SIZE, h);
  }
  // **斑点を置かない**（2026-09-07）。石・葉・殻と同じ楕円の斑点が
  // 全部の隠れ場所に乗って「どれも同じ汚れた板」に見えると判定で言われた。
  // 素焼きは焼きむらなので、輪郭のぼやけた縦の帯にする
  for (let i = 0; i < 9; i++) {
    const x = rng() * SIZE;
    const w = 20 + rng() * 46;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, `rgba(0,0,0,${(0.05 + rng() * 0.06).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-SIZE, 0, SIZE]) ctx.fillRect(x + dx, 0, w, SIZE);
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
  blanket: quilt,
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

  ctx.fillStyle = BASE;
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
