/**
 * 見た目の数値スコア（`docs/visual-gate.md` の V1〜V6）
 *
 *   npm run visual:score                       capture/visual/current を採点
 *   npm run visual:score -- --dir baseline     別のフォルダを採点
 *   npm run visual:score -- --vs baseline      baseline と比べて悪化を出す
 *
 * ==========================================================================
 * **CI の合否ではない**（§10-2）。`npm run verify` からは呼ばない。
 *
 * 隠れ場所の画素は「消して撮った差」で切り出す（`visual-shot.mjs`）。
 * 位置と半径から矩形を推し量ると隣とぶつかるし、背景を巻き込む。
 *
 * PNG の読み込みはヘッドレス Chromium にやらせている
 * （画像デコーダを依存に足さないため。`make-cutouts.mjs` と同じ作り）。
 * ==========================================================================
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 基準（`docs/visual-gate.md`）。**自分で緩めないこと** */
const GATE = {
  v1: { min: 8.0, label: '輪郭の明度差 p10' },
  v2: { min: 8.0, label: '内部 L* の四分位範囲' },
  v3: { max: 0.35, label: '最頻 L* 帯の占有率' },
  v4: { absMax: 12, label: '背景画との彩度差' },
  v5: { min: 3.0, label: '接地の暗さ' },
  v6: { max: 0.15, label: '消える輪郭の割合' },
};
/** 面積がこれ未満の島は数えない（アンチエイリアスの取りこぼし） */
const MIN_AREA = 500;

/* --- ここから下はページの中で走る ---------------------------------------- */

async function scoreInPage({ fullUrl, solidUrl, bgUrl }) {
  const load = async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  };

  const full = await load(fullUrl);
  const solid = await load(solidUrl);
  const bg = await load(bgUrl);
  const { w, h } = solid;
  const n = w * h;

  // sRGB → Lab（D65）
  const srgbToLin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const f = (t) => (t > 0.008856451679 ? Math.cbrt(t) : 7.787037 * t + 16 / 116);
  const toLab = (src) => {
    const L = new Float32Array(n);
    const C = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = srgbToLin(src[i * 4]);
      const g = srgbToLin(src[i * 4 + 1]);
      const b = srgbToLin(src[i * 4 + 2]);
      const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
      const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
      L[i] = 116 * fy - 16;
      const a2 = 500 * (fx - fy);
      const b2 = 200 * (fy - fz);
      C[i] = Math.hypot(a2, b2);
    }
    return { L, C };
  };

  const labFull = toLab(full.data);
  const labSolid = toLab(solid.data);
  const labBg = toLab(bg.data);

  // 隠れ場所の画素 = 影を消した1枚と、隠れ場所ごと消した1枚の差
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d =
      Math.abs(solid.data[i * 4] - bg.data[i * 4]) +
      Math.abs(solid.data[i * 4 + 1] - bg.data[i * 4 + 1]) +
      Math.abs(solid.data[i * 4 + 2] - bg.data[i * 4 + 2]);
    mask[i] = d > 24 ? 1 : 0;
  }

  // 島に分ける（隠れ場所1つ = 1島）
  const label = new Int32Array(n).fill(-1);
  const comps = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = comps.length;
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    const px = [];
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (top > 0) {
      const p = stack[--top];
      px.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] < 0) { label[p - w] = id; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) { label[p + w] = id; stack[top++] = p + w; }
    }
    comps.push({ px, minX, maxX, minY, maxY });
  }

  // 侵食（アンチエイリアスの縁を内部の統計から外す）
  const erode = (src, times) => {
    let a = src;
    for (let t = 0; t < times; t++) {
      const b = new Uint8Array(n);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (a[i] && a[i - 1] && a[i + 1] && a[i - w] && a[i + w]) b[i] = 1;
        }
      }
      a = b;
    }
    return a;
  };
  const inner = erode(mask, 3);

  const quantile = (arr, q) => {
    if (arr.length === 0) return 0;
    const a = Float64Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
  };

  // 背景画そのものの平均彩度（V4 の比較相手）
  let bgC = 0;
  for (let i = 0; i < n; i++) bgC += labBg.C[i];
  bgC /= n;

  const results = [];
  for (const comp of comps) {
    if (comp.px.length < 500) continue;

    // --- V2 / V3: 内部の L* の分布
    const insideL = [];
    let sumC = 0;
    for (const p of comp.px) {
      if (!inner[p]) continue;
      insideL.push(labSolid.L[p]);
      sumC += labSolid.C[p];
    }
    if (insideL.length < 200) continue;
    const v2 = quantile(insideL, 0.75) - quantile(insideL, 0.25);
    const bins = new Map();
    for (const L of insideL) {
      const k = Math.floor(L / 2);
      bins.set(k, (bins.get(k) ?? 0) + 1);
    }
    const v3 = Math.max(...bins.values()) / insideL.length;
    const v4 = sumC / insideL.length - bgC;

    // --- V1 / V6: 輪郭の明度差
    // 内側は侵食した縁、外側はそこから外向きに6画素の背景
    const dxs = [1, -1, 0, 0];
    const dys = [0, 0, 1, -1];
    const deltas = [];
    for (const p of comp.px) {
      if (!inner[p]) continue;
      const x = p % w;
      const y = (p - x) / w;
      // 4方向のうち、いちばん近く外へ抜ける向き
      let best = -1;
      let bestD = 99;
      for (let d = 0; d < 4; d++) {
        for (let k = 1; k <= 10; k++) {
          const nx = x + dxs[d] * k;
          const ny = y + dys[d] * k;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
          if (!mask[ny * w + nx]) {
            if (k < bestD) { bestD = k; best = d; }
            break;
          }
        }
      }
      if (best < 0 || bestD > 6) continue;
      const ox = x + dxs[best] * (bestD + 4);
      const oy = y + dys[best] * (bestD + 4);
      if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
      // **外側は「画面に出ている絵」から取る**（`labBg` ではなく `labFull`）。
      // 落ち影やハローは背景を暗くするので、そこも含めたものが
      // 実際に目に入る明度差になる。背景だけの1枚は切り出しにしか使わない
      deltas.push(Math.abs(labSolid.L[p] - labFull.L[oy * w + ox]));
    }
    const v1 = quantile(deltas, 0.1);
    const v6 = deltas.length ? deltas.filter((d) => d < 6).length / deltas.length : 1;

    // --- V5: 接地。島の下端の下 2〜16 画素で、影がどれだけ暗くするか
    const bottomOf = new Int32Array(w).fill(-1);
    for (const p of comp.px) {
      const x = p % w;
      const y = (p - x) / w;
      if (y > bottomOf[x]) bottomOf[x] = y;
    }
    let dark = 0;
    let darkN = 0;
    for (let x = comp.minX; x <= comp.maxX; x++) {
      const b0 = bottomOf[x];
      if (b0 < 0) continue;
      for (let k = 2; k <= 16; k++) {
        const y = b0 + k;
        if (y >= h) break;
        const i = y * w + x;
        if (mask[i]) continue;
        dark += labSolid.L[i] - labFull.L[i];
        darkN++;
      }
    }
    const v5 = darkN > 0 ? dark / darkN : 0;

    results.push({
      area: comp.px.length,
      cx: Math.round((comp.minX + comp.maxX) / 2),
      cy: Math.round((comp.minY + comp.maxY) / 2),
      v1: +v1.toFixed(2),
      v2: +v2.toFixed(2),
      v3: +v3.toFixed(3),
      v4: +v4.toFixed(2),
      v5: +v5.toFixed(2),
      v6: +v6.toFixed(3),
    });
  }
  return { bgChroma: +bgC.toFixed(2), spots: results };
}

/* --- ここから下は node ---------------------------------------------------- */

function parseArgs(argv) {
  const out = { dir: 'current', vs: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--vs') out.vs = argv[++i];
  }
  return out;
}

/** V の値が基準を満たすか */
function passes(key, value) {
  const g = GATE[key];
  if (g.min !== undefined) return value >= g.min;
  if (g.max !== undefined) return value <= g.max;
  return Math.abs(value) <= g.absMax;
}
/** 基準からどれだけ足りないか（0 なら満たしている）。場面の並べ替えに使う */
function shortfall(key, value) {
  const g = GATE[key];
  if (g.min !== undefined) return Math.max(0, g.min - value);
  if (g.max !== undefined) return Math.max(0, value - g.max);
  return Math.max(0, Math.abs(value) - g.absMax);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(ROOT, 'capture/visual', args.dir);
  const shot = JSON.parse(await readFile(resolve(dir, 'shot.json'), 'utf8'));

  const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    ...(existsSync(executablePath) ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>score</title>');

  const out = {};
  try {
    for (const id of shot.scenes) {
      const url = async (suffix) =>
        `data:image/png;base64,${(await readFile(resolve(dir, `${id}.${suffix}`))).toString('base64')}`;
      const r = await page.evaluate(scoreInPage, {
        fullUrl: await url('png'),
        solidUrl: await url('solid.png'),
        bgUrl: await url('bg.png'),
      });
      // 島に、いちばん近い隠れ場所の名前を付ける（報告を読めるようにするだけ）
      const known = shot.spots?.[id] ?? [];
      for (const s of r.spots) {
        let best = null;
        let bestD = Infinity;
        for (const k of known) {
          const d = Math.hypot(k.x - s.cx, k.y - s.cy);
          if (d < bestD) { bestD = d; best = k.id; }
        }
        s.spot = best ?? '?';
      }
      out[id] = r;
    }
  } finally {
    await browser.close();
  }

  const prev = args.vs
    ? JSON.parse(await readFile(resolve(ROOT, 'capture/visual', args.vs, 'score.json'), 'utf8'))
    : null;

  const keys = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'];
  console.log(`\n${'場面'.padEnd(10)}${'隠れ場所'.padEnd(10)}` + keys.map((k) => k.toUpperCase().padStart(8)).join(''));
  let worstShort = 0;
  const failures = [];
  for (const id of shot.scenes) {
    for (const s of out[id].spots) {
      const cells = keys.map((k) => {
        const ok = passes(k, s[k]);
        worstShort = Math.max(worstShort, shortfall(k, s[k]));
        if (!ok) failures.push(`${id}/${s.spot} ${k.toUpperCase()}=${s[k]}（${GATE[k].label}）`);
        return `${ok ? ' ' : '!'}${String(s[k]).padStart(7)}`;
      });
      console.log(`${id.padEnd(10)}${String(s.spot).padEnd(10)}` + cells.join(''));
    }
  }

  const regressions = [];
  if (prev) {
    console.log('\nbaseline との差（! は悪化）');
    for (const id of shot.scenes) {
      const before = prev[id]?.spots ?? [];
      for (const s of out[id].spots) {
        const b = before.find((x) => x.spot === s.spot);
        if (!b) continue;
        const cells = keys.map((k) => {
          const d = s[k] - b[k];
          // 悪化 = 基準から遠ざかった向き
          // 悪化 = 基準から遠ざかった向き。**基準を満たしたまま動いたぶんは数えない**
          // （満たしている項目の中での上下は、見た目の良し悪しを表していない）
          const worse = shortfall(k, s[k]) > shortfall(k, b[k]) + 1e-9;
          if (worse) {
            regressions.push(
              `${id}/${s.spot} ${k.toUpperCase()} ${b[k]} → ${s[k]}（${GATE[k].label}）`
            );
          }
          return `${worse ? '!' : ' '}${(d >= 0 ? '+' : '') + d.toFixed(2).padStart(6)}`;
        });
        console.log(`${id.padEnd(10)}${String(s.spot).padEnd(10)}` + cells.join(''));
      }
    }
  }

  await writeFile(resolve(dir, 'score.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  if (prev) {
    console.log(`\n悪化した項目: ${regressions.length} 件`);
    for (const r of regressions) console.log(`  ${r}`);
  }
  console.log(`\n基準を外れた項目: ${failures.length} 件`);
  for (const f of failures) console.log(`  ${f}`);
  console.log(`→ capture/visual/${args.dir}/score.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
