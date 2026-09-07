/**
 * 参照画像と突き合わせるための静止ポーズ撮影（`docs/match-gate.md` §3-1）
 *
 * 使い方:
 *   npm run shot -- --pose reference            manifest（無ければ全動物）を撮る
 *   npm run shot -- --pose reference --animal neko --view side
 *   npm run shot -- --pose reference --verify   2回撮ってバイト単位で一致するか見る
 *
 * ==========================================================================
 * **これは合否を出さない。** 撮るだけ。判定は `docs/match-gate.md` に従って
 * 別に行う。ここで数値を解釈しないこと。
 *
 * `--verify` が通るまで見た目を一切いじらないこと。撮影がゆらいでいる状態で
 * 数値を追いかけると、変化が実装のものか撮影のゆらぎか分からない。
 * ==========================================================================
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5178;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWS = ['side', 'front', 'three-quarter'];

function parseArgs(argv) {
  const out = { pose: null, animals: [], views: [], verify: false, outDir: 'capture/pose' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pose') out.pose = argv[++i];
    else if (a === '--animal') out.animals.push(argv[++i]);
    else if (a === '--view') out.views.push(argv[++i]);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--verify') out.verify = true;
  }
  return out;
}

async function waitForServer(url, timeoutMs = 120_000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // まだ上がっていない
    }
    if (Date.now() - started > timeoutMs) throw new Error(`dev サーバが上がりません: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function startViteServer() {
  const child = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}

/**
 * 撮る対象を決める。
 * **`reference/manifest.json` があれば、そこにある動物だけ。**
 * 無いあいだは全動物を撮る（撮影系そのものを検証するため）。
 */
async function resolveTargets(page, args) {
  if (args.animals.length > 0) return args.animals;

  const manifestPath = resolve(ROOT, 'reference/manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const list = (manifest.animals ?? [])
      // **pending はアプリにまだ居ない動物**。撮ろうとしても中身が無い
      .filter((a) => !a.pending)
      .slice()
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((a) => a.id);
    console.log(`reference/manifest.json の ${list.length} 体を撮ります`);
    return list;
  }

  await page.goto(`${BASE}/capture.html`, { waitUntil: 'load' });
  const all = await page.evaluate(() => window.__captureAnimals ?? []);
  console.log(`reference/manifest.json がありません。全 ${all.length} 体を撮ります`);
  return all;
}

async function shootOne(page, animal, view) {
  await page.goto(`${BASE}/capture.html?animal=${encodeURIComponent(animal)}&view=${view}`, {
    waitUntil: 'load',
  });
  const res = await page.waitForFunction(
    () => window.__capture ?? (window.__captureError ? { error: window.__captureError } : null),
    undefined,
    { timeout: 30_000 },
  );
  const value = await res.jsonValue();
  if (value.error) throw new Error(`${animal}/${view}: ${value.error}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.pose !== 'reference') {
    console.error('使い方: npm run shot -- --pose reference [--animal <id>] [--view <side|front|three-quarter>] [--verify]');
    process.exit(2);
  }
  const views = args.views.length > 0 ? args.views : VIEWS;
  for (const v of views) {
    if (!VIEWS.includes(v)) throw new Error(`知らない向きです: ${v}`);
  }

  const server = startViteServer();
  let browser;
  try {
    await waitForServer(`${BASE}/capture.html`);

    const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
    browser = await chromium.launch({
      ...(existsSync(executablePath) ? { executablePath } : {}),
      args: [
        // CI にも開発コンテナにも GPU が無いのでソフトウェア描画で動かす
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
      ],
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });

    const targets = await resolveTargets(page, args);
    const outDir = resolve(ROOT, args.outDir);
    await mkdir(outDir, { recursive: true });

    const index = [];
    const passes = args.verify ? 2 : 1;
    const hashes = [new Map(), new Map()];

    for (let pass = 0; pass < passes; pass++) {
      for (const animal of targets) {
        for (const view of views) {
          const shot = await shootOne(page, animal, view);
          const b64 = shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1);
          const png = Buffer.from(b64, 'base64');
          const sha = createHash('sha256').update(png).digest('hex');
          hashes[pass].set(`${animal}/${view}`, sha);

          if (pass === 0) {
            await writeFile(resolve(outDir, `${animal}-${view}.png`), png);
            index.push({
              animal,
              view,
              file: `${animal}-${view}.png`,
              sha256: sha,
              bytes: png.length,
              size: shot.size,
              worldHeight: Number(shot.worldHeight.toFixed(4)),
              worldWidth: Number(shot.worldWidth.toFixed(4)),
              worldDepth: Number(shot.worldDepth.toFixed(4)),
              pixelWidth: Number(shot.pixelWidth.toFixed(1)),
              pixelHeight: Number(shot.pixelHeight.toFixed(1)),
              triangles: shot.triangles,
            });
          }
        }
      }
      if (passes === 2) console.log(`pass ${pass + 1}/2 完了（${hashes[pass].size} 枚）`);
    }

    await writeFile(resolve(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    console.log(`${index.length} 枚を ${args.outDir}/ に書きました`);

    if (args.verify) {
      const diffs = [];
      for (const [k, v] of hashes[0]) {
        if (hashes[1].get(k) !== v) diffs.push(k);
      }
      if (diffs.length > 0) {
        console.error(`\n**撮影が決定論的ではありません。** ${diffs.length} 枚が2回で違いました:`);
        for (const d of diffs.slice(0, 20)) console.error(`  ${d}`);
        console.error('\nこの状態で見た目をいじらないこと（docs/match-gate.md §3-1）。');
        process.exitCode = 1;
      } else {
        console.log(`検証: ${hashes[0].size} 枚すべてが2回でバイト単位一致しました`);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
