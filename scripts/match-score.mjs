/**
 * M1（シルエット一致）の採点 — `docs/match-gate.md`
 *
 *   npm run shot -- --pose reference   （先にアプリ側を撮る）
 *   npm run match-score
 *
 * ==========================================================================
 * **ここは合否を出すだけで、実装を直さない。**
 * 数値は `capture/match-score.json` に残す。自己申告は受け付けない。
 *
 * 測っているのは「**参照画像に寄っているか**」であって
 * 「本物に見えるか」ではない。参照画像の出来が上限になる。
 *
 * 画素比較を合否条件にしてよいのは、`--pose reference` が撮る
 * **静止1枚に限る**（2026-09-06 に人間が決めた例外。CLAUDE.md 参照）。
 * 動いている場面のスクリーンショット比較は従来どおり禁止。
 * ==========================================================================
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF_DIR = resolve(ROOT, 'reference/animals');
const SHOT_DIR = resolve(ROOT, 'capture/pose');
const OUT_DIR = resolve(ROOT, 'capture');

/** `docs/match-gate.md` の合格ライン。**ここを緩めてよいのは人間だけ** */
const M1_PASS = 0.7;

/** 正規化したときの動物の高さ（画素）。大きいほど分解能は上がるが遅くなる */
const NORM_H = 256;
/** 作業キャンバス。横に広い動物（かに・くまのみ）がはみ出さない大きさ */
const CANVAS = 512;
/** 重心を合わせたあと、この範囲だけ平行移動を試す（置き場所ではなく形を測るため） */
const SEARCH = 10;
const STEP = 2;

async function scoreInPage({ refUrl, appUrl, cfg }) {
  /** アルファからマスクを作り、外接矩形の高さを揃えて中央に置く */
  async function normalize(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const probe = document.createElement('canvas');
    probe.width = w;
    probe.height = h;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(img, 0, 0);
    const a = pctx.getImageData(0, 0, w, h).data;

    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (a[(y * w + x) * 4 + 3] < 128) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX) return null;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    // **高さで揃える**（`docs/match-gate.md` M1）。幅で揃えると、
    // うさぎの耳やきりんの首のように縦に長い動物で、体の大きさが変わってしまう
    const k = cfg.normH / bh;
    const S = cfg.canvas;
    const out = document.createElement('canvas');
    out.width = S;
    out.height = S;
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.imageSmoothingEnabled = true;
    octx.drawImage(
      img,
      minX, minY, bw, bh,
      (S - bw * k) / 2, (S - bh * k) / 2, bw * k, bh * k,
    );
    const px = octx.getImageData(0, 0, S, S).data;
    const mask = new Uint8Array(S * S);
    let area = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < S * S; i++) {
      if (px[i * 4 + 3] < 128) continue;
      mask[i] = 1;
      area++;
      sx += i % S;
      sy += (i - (i % S)) / S;
    }
    return {
      mask,
      area,
      cx: sx / area,
      cy: sy / area,
      aspect: bw / bh,
      sourceWidth: bw,
      sourceHeight: bh,
    };
  }

  const ref = await normalize(refUrl);
  const app = await normalize(appUrl);
  if (!ref || !app) return { error: 'マスクが空です' };

  const S = cfg.canvas;
  // まず重心を合わせる。**そのあと少しだけ平行移動を試す。**
  // 置き場所のずれを形の違いとして数えないため
  const dx0 = Math.round(ref.cx - app.cx);
  const dy0 = Math.round(ref.cy - app.cy);

  function iouAt(dx, dy) {
    let inter = 0;
    let union = 0;
    for (let y = 0; y < S; y++) {
      const ay = y - dy;
      for (let x = 0; x < S; x++) {
        const r = ref.mask[y * S + x];
        const ax = x - dx;
        const a = ax >= 0 && ax < S && ay >= 0 && ay < S ? app.mask[ay * S + ax] : 0;
        if (r | a) union++;
        if (r & a) inter++;
      }
    }
    return union === 0 ? 0 : inter / union;
  }

  let best = { iou: -1, dx: dx0, dy: dy0 };
  for (let dy = dy0 - cfg.search; dy <= dy0 + cfg.search; dy += cfg.step) {
    for (let dx = dx0 - cfg.search; dx <= dx0 + cfg.search; dx += cfg.step) {
      const iou = iouAt(dx, dy);
      if (iou > best.iou) best = { iou, dx, dy };
    }
  }

  // 重なりの絵。赤＝参照だけ / 青＝アプリだけ / 濃い灰＝両方
  const view = document.createElement('canvas');
  view.width = S;
  view.height = S;
  const vctx = view.getContext('2d');
  const out = vctx.createImageData(S, S);
  let refOnly = 0;
  let appOnly = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const r = ref.mask[i];
      const ax = x - best.dx;
      const ay = y - best.dy;
      const a = ax >= 0 && ax < S && ay >= 0 && ay < S ? app.mask[ay * S + ax] : 0;
      const d = i * 4;
      let c = [255, 255, 255, 0];
      if (r && a) c = [64, 72, 88, 255];
      else if (r) { c = [222, 90, 84, 255]; refOnly++; }
      else if (a) { c = [72, 130, 214, 255]; appOnly++; }
      out.data[d] = c[0];
      out.data[d + 1] = c[1];
      out.data[d + 2] = c[2];
      out.data[d + 3] = c[3];
    }
  }
  vctx.putImageData(out, 0, 0);

  return {
    iou: best.iou,
    dx: best.dx,
    dy: best.dy,
    refArea: ref.area,
    appArea: app.area,
    areaRatio: app.area / ref.area,
    refAspect: ref.aspect,
    appAspect: app.aspect,
    /** 参照にあってアプリに無い割合。**大きいほど「足りない」** */
    missing: refOnly / ref.area,
    /** アプリにあって参照に無い割合。**大きいほど「はみ出している」** */
    extra: appOnly / ref.area,
    overlay: view.toDataURL('image/png'),
  };
}

async function buildSheetInPage({ items, cell, cols }) {
  const rows = Math.ceil(items.length / cols);
  const pad = 24;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * (cell + pad);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < items.length; i++) {
    const cx = (i % cols) * cell;
    const cy = Math.floor(i / cols) * (cell + pad);
    const img = new Image();
    img.src = items[i].dataUrl;
    await img.decode();
    ctx.drawImage(img, cx + 4, cy + pad + 4, cell - 8, cell - 8);
    ctx.fillStyle = items[i].pass ? '#166534' : '#b91c1c';
    ctx.font = '600 15px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(items[i].label, cx + 6, cy + 4);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(cx + 0.5, cy + pad + 0.5, cell - 1, cell - 1);
  }
  return canvas.toDataURL('image/png');
}

async function main() {
  // `--only <id>` は1体だけ採点して表示する。**json も一覧も書き換えない。**
  // 直しながら数値を見るための入口で、正式な記録は常に全体の実行から採る
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

  const manifest = JSON.parse(await readFile(resolve(ROOT, 'reference/manifest.json'), 'utf8'));
  const animals = (manifest.animals ?? [])
    .filter((a) => !only || a.id === only)
    .slice()
    .sort((a, b) => a.priority - b.priority);
  if (animals.length === 0) {
    console.error('reference/manifest.json に動物がありません');
    process.exit(2);
  }

  const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    ...(existsSync(executablePath) ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>match-score</title>');

  const cfg = { normH: NORM_H, canvas: CANVAS, search: SEARCH, step: STEP };
  const results = [];
  const overlays = { front: [], side: [] };

  try {
    for (const a of animals) {
      const perView = {};
      for (const view of ['front', 'side']) {
        // **アプリの向きを読み替えることがある。**
        // くまのみは魚を横向きに作ってあるので、アプリの front カメラには
        // 魚の横顔が写る。参照の front（真正面）と突き合わせると別物を比べる
        const appView = a.appViewFor?.[view] ?? view;
        const refPath = resolve(REF_DIR, a.id, `${view}.png`);
        const appPath = resolve(SHOT_DIR, `${a.id}-${appView}.png`);
        if (!existsSync(refPath) || !existsSync(appPath)) {
          console.error(`${a.id}/${view}: 画像がありません`);
          process.exitCode = 1;
          continue;
        }
        const refUrl = `data:image/png;base64,${(await readFile(refPath)).toString('base64')}`;
        const appUrl = `data:image/png;base64,${(await readFile(appPath)).toString('base64')}`;
        const r = await page.evaluate(scoreInPage, { refUrl, appUrl, cfg });
        if (r.error) {
          console.error(`${a.id}/${view}: ${r.error}`);
          process.exitCode = 1;
          continue;
        }
        const { overlay, ...numbers } = r;
        perView[view] = { ...numbers, appView };
        overlays[view].push({
          label: `${a.id} ${r.iou.toFixed(3)}`,
          pass: r.iou >= M1_PASS,
          dataUrl: overlay,
        });
      }

      // **合否は正面だけで見る**（2026-09-06、人間が決めた。docs/match-gate.md）。
      // 参照の側面図は4本足で立った獣で、アプリの動物は上半身を起こした形。
      // そのうえ**アプリのカメラは動物を正面からしか見せない**ので、
      // 側面は画面に出ない投影を測っていることになる。
      // 側面は記録するだけで合否に数えない
      const score = perView.front?.iou ?? 0;
      results.push({
        id: a.id,
        priority: a.priority,
        m1: Number(score.toFixed(4)),
        pass: score >= M1_PASS,
        views: Object.fromEntries(
          Object.entries(perView).map(([k, v]) => [
            k,
            {
              iou: Number(v.iou.toFixed(4)),
              missing: Number(v.missing.toFixed(4)),
              extra: Number(v.extra.toFixed(4)),
              areaRatio: Number(v.areaRatio.toFixed(3)),
              refAspect: Number(v.refAspect.toFixed(3)),
              appAspect: Number(v.appAspect.toFixed(3)),
              appView: v.appView,
              offset: [v.dx, v.dy],
            },
          ]),
        ),
      });
    }

    await mkdir(OUT_DIR, { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      metric: 'M1',
      gate: 'front-only',
      note: '参照画像に寄っているかを測っている。本物に見えるかは測っていない',
      passLine: M1_PASS,
      normalizedHeightPx: NORM_H,
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      animals: results,
    };
    if (!only) {
      await writeFile(resolve(OUT_DIR, 'match-score.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    for (const view of only ? [] : ['front', 'side']) {
      const sheet = await page.evaluate(buildSheetInPage, { items: overlays[view], cell: 256, cols: 4 });
      const b64 = sheet.slice(sheet.indexOf(',') + 1);
      await writeFile(resolve(OUT_DIR, `m1-${view}.png`), Buffer.from(b64, 'base64'));
    }

    console.log(`M1 シルエット一致（合格ライン ${M1_PASS}）`);
    console.log('id           正面   足りない はみ出し 縦横比(参照→アプリ)  (側面=参考)');
    for (const r of results) {
      const f = r.views.front;
      const s = r.views.side;
      const worst = (f?.iou ?? 1) <= (s?.iou ?? 1) ? f : s;
      void worst;
      console.log(
        `${r.id.padEnd(12)} ${(f?.iou ?? 0).toFixed(3)}  ${(f?.missing ?? 0).toFixed(3)}  ${(f?.extra ?? 0).toFixed(3)}` +
          `   ${(f?.refAspect ?? 0).toFixed(2)} → ${(f?.appAspect ?? 0).toFixed(2)}` +
          `   ${(s?.iou ?? 0).toFixed(3)}` +
          `  ${r.pass ? '合格' : '**不合格**'}`,
      );
    }
    console.log(`\n合格 ${payload.passed} / ${payload.total}`);
    console.log('数値: capture/match-score.json  重なりの絵: capture/m1-front.png / m1-side.png');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
