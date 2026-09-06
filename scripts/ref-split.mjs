/**
 * 参照画像を「正面図」と「側面図」に割り、白背景を落とす（docs/match-gate.md §1）
 *
 *   npm run ref-split
 *
 * ==========================================================================
 * 受け取った画像は、プロンプトで指定した形と3箇所ちがっていた。
 * **どれも自動処理を静かに壊すので、ここで潰しておく。**
 *
 *  ① 拡張子は .png だが中身は JPEG。**非可逆なので白背景がちょうど 255 にならない。**
 *     完全一致で抜くとフチにゴミが残る。閾値で抜き、境目は柔らかくする
 *  ② **正面図と側面図の足元を貫く地面の線が引かれている。**
 *     消さずに連結成分を取ると、2体が1つの塊になって割れない
 *  ③ **左上に「No.1 Cow」の文字がある。** これは番号照合のために
 *     こちらが指示したもの。マスクに入れない
 *
 * さらに、側面図の向きが画像ごとにばらばら（うしは左、うさぎは右）。
 * **自動判定はしない。** 16枚を人間が見て `reference/manifest.json` の
 * `sideFacing` に書き、ここはそれに従って反転するだけにする。
 *
 * 画像の復号と PNG の書き出しはヘッドレス Chromium にやらせている。
 * JPEG デコーダを依存に足さないため（CLAUDE.md「新しい依存を安易に増やさない」）。
 * ==========================================================================
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = resolve(ROOT, 'reference/raw');
const OUT_DIR = resolve(ROOT, 'reference/animals');

/**
 * ページの中で走る本体。**Node の変数を掴まないこと**（そのまま文字列で送られる）。
 */
async function splitInPage({ dataUrl, cfg }) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const src = ctx.getImageData(0, 0, W, H).data;

  const N = W * H;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = 0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2];
  }

  // ① JPEG なので「白」は 255 ちょうどにならない。閾値で抜く
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) fg[i] = lum[i] < cfg.bgLo ? 1 : 0;

  // ② 地面の線を消す。**穴を埋める前にやる。**
  //    逆順にすると、脚と地面の線で囲まれた「脚のあいだ」が閉じた穴になって
  //    塗りつぶされる（実際にやって、うし・たこ・かにの足元に白い塊が残った）。
  //
  //    **ここは4回作り直した。落ちた条件を全部残しておく。**
  //      ・一続きの長さ > 幅の 0.5    → ちょうちょの羽（幅の 0.58）を30行消した
  //      ・一続きの長さ > 幅の 0.72   → ひつじの線は淡くて1行しか拾えず、
  //                                     残った行が2体をつないだまま
  //      ・拾った行を上下へ広げる     → ねずみの胴（行の合計 0.71）を16行巻き込んだ
  //      ・画素ごとに「縦に薄い」で消す → うさぎとねずみで線が消え切らなかった
  //
  //    **効いた条件は「行の合計が幅の 0.55 を超える行が、8行以下しか続かない」。**
  //    線は横に長く、そして**薄い**。胴も羽も横に長いが、何十行も続く。
  //    長さではなく合計で見るのは、線がアンチエイリアスとJPEGで
  //    ところどころ切れていて「一続き」では拾えないため
  //    （ひつじの y=729 は一続き 0.35 だが、行の合計は 0.86 あった）。
  const rowCount = new Int32Array(H);
  const scanFrom = Math.floor(H * 0.45);
  for (let y = scanFrom; y < H; y++) {
    let cnt = 0;
    for (let x = 0; x < W; x++) if (fg[y * W + x]) cnt++;
    rowCount[y] = cnt;
  }
  const groundRows = [];
  let bandStart = -1;
  for (let y = scanFrom; y <= H; y++) {
    const wide = y < H && rowCount[y] > W * cfg.groundCountRatio;
    if (wide && bandStart < 0) bandStart = y;
    if (!wide && bandStart >= 0) {
      // **厚い帯は線ではない。** 胴・羽・甲羅はここで落ちる
      if (y - bandStart <= cfg.groundMaxRows && bandStart > scanFrom) {
        // **消すのではなく、帯の1つ上の行で埋め直す。**
        // ただ消すと足の裏が開き、そこから外の白が体の中へ漏れて、
        // 白い動物（うし・ひつじ・ぺんぎん）の中身が抜ける。
        // 脚はほぼ垂直なので、上の行を下ろせば脚は脚のまま、
        // 脚のあいだは背景のままになる
        for (let yy = bandStart; yy < y; yy++) {
          groundRows.push(yy);
          for (let x = 0; x < W; x++) fg[yy * W + x] = fg[(bandStart - 1) * W + x];
        }
      }
      bandStart = -1;
    }
  }

  // ③ 穴を埋める。**これが無いと白い動物が輪になる。**
  //    前景は「白でないところ」なので、うしの白い胴・ひつじの羊毛・
  //    ぺんぎんの腹は背景と同じ明るさになり、輪郭線だけのドーナツになる。
  //    縁から届かない背景＝内側の穴として塗りつぶす。
  const outside = new Uint8Array(N);
  const stack = new Int32Array(N);
  let top = 0;
  for (let x = 0; x < W; x++) {
    for (const y of [0, H - 1]) {
      const i = y * W + x;
      if (!fg[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; }
    }
  }
  for (let y = 0; y < H; y++) {
    for (const x of [0, W - 1]) {
      const i = y * W + x;
      if (!fg[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; }
    }
  }
  while (top > 0) {
    const p = stack[--top];
    const px = p % W;
    const py = (p - px) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (fg[q] || outside[q]) continue;
      outside[q] = 1;
      stack[top++] = q;
    }
  }
  let filled = 0;
  for (let i = 0; i < N; i++) {
    if (!fg[i] && !outside[i]) { fg[i] = 1; filled++; }
  }

  // ④ 連結成分
  const label = new Int32Array(N).fill(-1);
  const comps = [];
  function labelComponents() {
    label.fill(-1);
    comps.length = 0;
  for (let s = 0; s < N; s++) {
    if (!fg[s] || label[s] !== -1) continue;
    const id = comps.length;
    top = 0;
    stack[top++] = s;
    label[s] = id;
    let area = 0;
    let sumX = 0;
    let minX = W, maxX = -1, minY = H, maxY = -1;
    while (top > 0) {
      const p = stack[--top];
      const px = p % W;
      const py = (p - px) / W;
      area++;
      sumX += px;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (!fg[q] || label[q] !== -1) continue;
          label[q] = id;
          stack[top++] = q;
        }
      }
    }
    comps.push({ id, area, cx: sumX / area, minX, maxX, minY, maxY });
  }
  }
  labelComponents();

  /**
   * 動物どうしが**絵の上で触れている**ときの逃げ道。
   *
   * ねずみは、側面図のしっぽの先が正面図の足に届いていて、
   * 2体が1つの塊になった。切り抜きの不具合ではなく元の絵がそうなっている。
   * 真ん中あたりで前景がいちばん薄い5列を切る。しっぽの先を数画素失うだけで、
   * シルエットの一致（M1）には効かない。
   */
  function cutThinnestColumns() {
    const colCount = new Int32Array(W);
    for (let i = 0; i < N; i++) if (fg[i]) colCount[i % W]++;
    const band = cfg.tieCutColumns;
    let bestX = -1;
    let best = Infinity;
    for (let x = Math.floor(W * 0.3); x + band <= Math.ceil(W * 0.7); x++) {
      let sum = 0;
      for (let k = 0; k < band; k++) sum += colCount[x + k];
      if (sum < best) { best = sum; bestX = x; }
    }
    if (bestX < 0) return null;
    for (let y = 0; y < H; y++) {
      for (let k = 0; k < band; k++) fg[y * W + bestX + k] = 0;
    }
    labelComponents();
    return { x: bestX, removedPixels: best };
  }

  const dropped = [];
  const kept = [];
  for (const c of comps) {
    // 上の帯に**まるごと**収まっている塊は「No.1 Cow」の文字。
    // うさぎの耳も上まで届くが、耳は体と同じ塊なので maxY が大きく残る
    const isLabel = c.maxY < H * cfg.labelBandRatio;
    const tooSmall = c.area < N * cfg.minAreaRatio;
    if (isLabel || tooSmall) dropped.push({ area: c.area, reason: isLabel ? 'label' : 'small' });
    else kept.push(c);
  }
  let tieCut = null;
  if (kept.length < 2) {
    tieCut = cutThinnestColumns();
    if (tieCut) {
      dropped.length = 0;
      kept.length = 0;
      for (const c of comps) {
        const isLabel = c.maxY < H * cfg.labelBandRatio;
        const tooSmall = c.area < N * cfg.minAreaRatio;
        if (isLabel || tooSmall) dropped.push({ area: c.area, reason: isLabel ? 'label' : 'small' });
        else kept.push(c);
      }
    }
  }
  if (kept.length < 2) {
    return { error: `動物の塊が ${kept.length} 個しか残りませんでした` };
  }

  // ⑤ 左右に分ける。
  //    **列の投影では割れない。** いぬ・ねずみ・ひつじ・かには
  //    正面図と側面図が横に重なっていて、空の列が1本も無い（実測: 空白 0px）。
  //    塊の重心 x を、面積で重みを付けた1次元 k-means（k=2）で2群に分ける。
  let ca = Math.min(...kept.map((c) => c.cx));
  let cb = Math.max(...kept.map((c) => c.cx));
  let side = new Int8Array(kept.length);
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (let i = 0; i < kept.length; i++) {
      const s2 = Math.abs(kept[i].cx - ca) <= Math.abs(kept[i].cx - cb) ? 0 : 1;
      if (s2 !== side[i]) { side[i] = s2; changed = true; }
    }
    let sa = 0, wa = 0, sb = 0, wb = 0;
    for (let i = 0; i < kept.length; i++) {
      if (side[i] === 0) { sa += kept[i].cx * kept[i].area; wa += kept[i].area; }
      else { sb += kept[i].cx * kept[i].area; wb += kept[i].area; }
    }
    if (wa === 0 || wb === 0) return { error: '左右に分けられませんでした（片側が空）' };
    ca = sa / wa;
    cb = sb / wb;
    if (!changed && iter > 0) break;
  }
  // プロンプトでは「左＝正面図、右＝側面図」
  const leftGroup = ca <= cb ? 0 : 1;

  const groupOf = new Int32Array(comps.length).fill(-1);
  for (let i = 0; i < kept.length; i++) groupOf[kept[i].id] = side[i] === leftGroup ? 0 : 1;

  function cut(group, mirror) {
    const mask = new Uint8Array(N);
    let minX = W, maxX = -1, minY = H, maxY = -1;
    for (let i = 0; i < N; i++) {
      if (!fg[i] || groupOf[label[i]] !== group) continue;
      mask[i] = 1;
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < minX) return null;

    // アルファを残す範囲を少しふくらませる。輪郭線の外側の
    // アンチエイリアスの帯が、そのままだと落ちてしまうため
    const grow = cfg.growPx;
    const near = new Uint8Array(N);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!mask[y * W + x]) continue;
        for (let dy = -grow; dy <= grow; dy++) {
          for (let dx = -grow; dx <= grow; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            near[ny * W + nx] = 1;
          }
        }
      }
    }

    const m = cfg.marginPx;
    const cx0 = Math.max(0, minX - m), cx1 = Math.min(W, maxX + 1 + m);
    const cy0 = Math.max(0, minY - m), cy1 = Math.min(H, maxY + 1 + m);
    const cw = cx1 - cx0, ch = cy1 - cy0;

    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    const octx = out.getContext('2d');
    const dst = octx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = (cy0 + y) * W + (cx0 + x);
        const di = (y * cw + x) * 4;
        let a = 0;
        if (near[si]) {
          // 穴を埋めた画素は中身なので不透明。それ以外は明るさから滑らかに
          a = fg[si] && groupOf[label[si]] === group
            ? 1
            : Math.max(0, Math.min(1, (cfg.bgHi - lum[si]) / (cfg.bgHi - cfg.bgLo)));
        }
        dst.data[di] = src[si * 4];
        dst.data[di + 1] = src[si * 4 + 1];
        dst.data[di + 2] = src[si * 4 + 2];
        dst.data[di + 3] = Math.round(a * 255);
      }
    }
    octx.putImageData(dst, 0, 0);

    const meta = { width: cw, height: ch, bboxWidth: maxX - minX + 1, bboxHeight: maxY - minY + 1 };
    if (!mirror) return { dataUrl: out.toDataURL('image/png'), ...meta };

    // 左右反転。**シルエットを比べるだけなので情報は失われない**
    const flip = document.createElement('canvas');
    flip.width = cw;
    flip.height = ch;
    const fctx = flip.getContext('2d');
    fctx.translate(cw, 0);
    fctx.scale(-1, 1);
    fctx.drawImage(out, 0, 0);
    return { dataUrl: flip.toDataURL('image/png'), ...meta };
  }

  return {
    width: W,
    height: H,
    filledHolePixels: filled,
    groundRows: groundRows.length,
    tieCut,
    keptComponents: kept.length,
    dropped,
    front: cut(0, false),
    side: cut(1, cfg.mirrorSide),
  };
}


/**
 * 目で確認するための一覧。
 *
 * **切り抜きは自動でやらせ、目で確認する**（計画書 §1）。
 * 16体を1枚ずつ開くのは現実的でないので、1枚にまとめて出す。
 * 市松模様の上に載せているのは、**アルファが抜けているかを見るため**
 * （白地に白い動物を置くと、抜けていなくても抜けて見える）。
 */
async function buildSheetInPage({ items, cell, cols }) {
  const rows = Math.ceil(items.length / cols);
  const pad = 22;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * (cell + pad);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < items.length; i++) {
    const cx = (i % cols) * cell;
    const cy = Math.floor(i / cols) * (cell + pad);

    // 市松模様
    const q = 12;
    for (let y = 0; y < cell; y += q) {
      for (let x = 0; x < cell; x += q) {
        ctx.fillStyle = ((x / q + y / q) % 2 === 0) ? '#e9edf2' : '#f8fafc';
        ctx.fillRect(cx + x, cy + pad + y, q, q);
      }
    }

    const img = new Image();
    img.src = items[i].dataUrl;
    await img.decode();
    const k = Math.min((cell - 8) / img.naturalWidth, (cell - 8) / img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.drawImage(img, cx + (cell - w) / 2, cy + pad + (cell - h) / 2, w, h);

    ctx.fillStyle = '#111827';
    ctx.font = '600 15px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(items[i].label, cx + 6, cy + 3);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(cx + 0.5, cy + pad + 0.5, cell - 1, cell - 1);
  }
  return canvas.toDataURL('image/png');
}

const CFG = {
  /** これより暗ければ確実に前景。JPEG のざらつきを避けて 255 から離す */
  bgLo: 235,
  /** これより明るければ確実に背景。あいだはアルファで滑らかにつなぐ */
  bgHi: 250,
  /** 行の前景の合計が幅のこの割合を超えたら、地面の線の候補 */
  groundCountRatio: 0.55,
  /** 候補がこれより厚ければ線ではない（線は薄い。胴も羽も何十行も続く） */
  groundMaxRows: 8,
  /** 2体が触れているときに切る列の幅 */
  tieCutColumns: 5,
  /** 上のこの帯に**まるごと**収まる塊は「No.1 Cow」の文字 */
  labelBandRatio: 0.12,
  /** 画素数のこの割合に満たない塊は捨てる */
  minAreaRatio: 0.0002,
  /** アルファを残す範囲を前景から何 px ふくらませるか */
  growPx: 2,
  /** 切り出しの余白 */
  marginPx: 8,
  mirrorSide: false,
};

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.error(`${RAW_DIR} がありません。reference/README.md を見てください`);
    process.exit(2);
  }
  const files = (await readdir(RAW_DIR)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`${RAW_DIR} に画像がありません`);
    process.exit(2);
  }

  // 側面図の向き。**自動判定しない**（人間が16枚を見て manifest に書く）
  const manifestPath = resolve(ROOT, 'reference/manifest.json');
  const facing = new Map();
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const a of manifest.animals ?? []) {
      if (a.sideFacing) facing.set(a.id, a.sideFacing);
    }
  }

  const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    ...(existsSync(executablePath) ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>ref-split</title>');

  const report = [];
  try {
    for (const file of files) {
      // 01-ushi.jpg → ushi
      const id = basename(file, extname(file)).replace(/^\d+-/, '');
      const bytes = await readFile(resolve(RAW_DIR, file));
      const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      const sideFacing = facing.get(id) ?? 'right';

      const res = await page.evaluate(splitInPage, {
        dataUrl,
        cfg: { ...CFG, mirrorSide: sideFacing === 'left' },
      });
      if (res.error) {
        console.error(`${id}: ${res.error}`);
        process.exitCode = 1;
        continue;
      }

      const dir = resolve(OUT_DIR, id);
      await mkdir(dir, { recursive: true });
      for (const view of ['front', 'side']) {
        const half = res[view];
        if (!half) {
          console.error(`${id}: ${view} が空です`);
          process.exitCode = 1;
          continue;
        }
        const b64 = half.dataUrl.slice(half.dataUrl.indexOf(',') + 1);
        await writeFile(resolve(dir, `${view}.png`), Buffer.from(b64, 'base64'));
      }

      report.push({
        id,
        source: file,
        size: `${res.width}x${res.height}`,
        filledHolePixels: res.filledHolePixels,
        groundRows: res.groundRows,
        keptComponents: res.keptComponents,
        tieCut: res.tieCut,
        droppedComponents: res.dropped.length,
        sideFacing,
        mirrored: sideFacing === 'left',
        front: res.front ? `${res.front.bboxWidth}x${res.front.bboxHeight}` : null,
        side: res.side ? `${res.side.bboxWidth}x${res.side.bboxHeight}` : null,
      });
      const flag =
        (sideFacing === 'left' ? ' (左向き→反転)' : '') +
        (res.tieCut ? ` **2体が触れていたので x=${res.tieCut.x} で切った**` : '');
      console.log(
        `${id.padEnd(12)} 穴埋め${String(res.filledHolePixels).padStart(7)}px ` +
          `地面${String(res.groundRows).padStart(2)}行 塊${String(res.keptComponents).padStart(2)}(捨${res.dropped.length}) ` +
          `正面 ${report.at(-1).front} / 側面 ${report.at(-1).side}${flag}`,
      );
    }
    await writeFile(resolve(OUT_DIR, 'split-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n${report.length} 体を reference/animals/ に書きました`);

    // 目で確認するための一覧
    for (const view of ['front', 'side']) {
      const items = [];
      for (const r of report) {
        const png = await readFile(resolve(OUT_DIR, r.id, `${view}.png`));
        items.push({
          label: r.mirrored ? `${r.id} (反転)` : r.id,
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        });
      }
      const sheet = await page.evaluate(buildSheetInPage, { items, cell: 256, cols: 4 });
      const b64 = sheet.slice(sheet.indexOf(',') + 1);
      await writeFile(resolve(OUT_DIR, `contact-${view}.png`), Buffer.from(b64, 'base64'));
    }
    console.log('一覧: reference/animals/contact-front.png / contact-side.png');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
