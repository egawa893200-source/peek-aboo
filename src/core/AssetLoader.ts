/**
 * 素材の読込と、失敗時の手続き生成フォールバック（§7-4 / 不変条件7）
 *
 * public/ が完全に空でもアプリが動くことを最優先にしている。
 *  - テクスチャが無い → Canvas で手続き生成
 *  - GLTF が無い     → null を返し、呼び出し側が ProceduralAnimals にフォールバック
 *
 * 生成したテクスチャはキャッシュして、場面を切り替えても作り直さない。
 *
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/core/AssetLoader.ts`（647行）。
 * 実機で検証済みなので書き直していない。**水槽専用だった部分だけを外した**:
 *  - コースティクス／水面法線／鱗／餌の粒のテクスチャ生成（水の絵に固有）
 *  - `loadVideo()`（このアプリに実写動画のレイヤーは無い。§5-1 の背景は
 *    静止画か手続き生成。動画を使うことにしたら、みずのなかから持ってくる）
 * --------------------------------------------------------------------------
 */

import * as THREE from 'three';

type AnyTexture = THREE.Texture;

/** 手続き生成できるテクスチャの種類 */
export type ProceduralKind = 'particle' | 'noise';

/** ---- 周期的（タイル可能な）値ノイズ -------------------------------------- */

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** period 単位でタイルする値ノイズ。u,v は [0,1) */
function periodicNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const xa = ((x0 % period) + period) % period;
  const ya = ((y0 % period) + period) % period;
  const xb = (xa + 1) % period;
  const yb = (ya + 1) % period;

  const n00 = hash2(xa, ya, seed);
  const n10 = hash2(xb, ya, seed);
  const n01 = hash2(xa, yb, seed);
  const n11 = hash2(xb, yb, seed);

  const nx0 = n00 + (n10 - n00) * fx;
  const nx1 = n01 + (n11 - n01) * fx;
  return nx0 + (nx1 - nx0) * fy;
}

function fbm(u: number, v: number, basePeriod: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += periodicNoise(u, v, period, seed + o * 977) * amp;
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

/** ---- AssetLoader --------------------------------------------------------- */

/**
 * `/models/xxx.glb` のようなルート絶対パスを、公開時の base に合わせて解決する。
 *
 * サブディレクトリ配信（GitHub Pages のように `/<リポジトリ名>/` の下に置く形）だと、
 * `/models/...` のままでは素材を置いた瞬間に 404 になる。
 * しかも素材が無いあいだは全部フォールバックが効いて「一応動く」ため、
 * 気づけないまま黙ってモデルもテクスチャも使われない状態になる。
 * それを避けるため、素材を読む入口はすべてここを通す。
 * Netlify 直下配信なら base は `/` なので何もしない。
 *
 * data: / http: などのスキーム付きと、相対パスはそのまま返す。
 */
export function resolveAssetUrl(url: string): string {
  if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!url.startsWith('/')) return url;
  const base = import.meta.env.BASE_URL || '/';
  if (base === '/') return url;
  return base.replace(/\/$/, '') + url;
}

/**
 * 「指定されているのに読めなかった」素材を開発時だけ知らせる。
 *
 * 素材が1つも無くてもアプリは起動しなければならない（不変条件7）ので、
 * 読み込み失敗は黙ってフォールバックする。ただしそれは
 * **開発者にとっても見えない**という副作用があり、実際
 * tanks.ts が指していた tang.glb / sardine.glb / goldfish_wakin.glb は
 * ファイルが無いまま「モデルがある種」として扱われていた。
 *
 * 本番では何も出さない。console.error ではなく warn を使うのは、
 * App が console.error を記録していて E2E が「エラーが出ていないこと」を
 * 見ているため（素材が無いのはエラーではない）。
 * 同じURLで何度も出さないよう1回だけにする。
 */
const warnedAssets = new Set<string>();
function warnMissingAsset(kind: string, url: string): void {
  if (!import.meta.env.DEV) return;
  if (warnedAssets.has(url)) return;
  warnedAssets.add(url);
  console.warn(
    `[ばあ！] ${kind} "${url}" を読み込めませんでした。手続き生成で代用します。` +
      `scenes.ts の指定と public/ の中身が食い違っていないか確認してください。`
  );
}
export class AssetLoader {
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly cache = new Map<string, AnyTexture>();
  private readonly pending = new Map<string, Promise<AnyTexture>>();
  private disposed = false;

  /**
   * テクスチャを読む。無ければ fallback で手続き生成する。
   * 例外は投げない（幼児向けアプリなのでエラー画面を出さない §2）。
   */
  async loadTexture(
    url: string | null,
    fallbackKey: ProceduralKind,
    fallbackSeed = 0
  ): Promise<AnyTexture> {
    const key = url ?? `${fallbackKey}:${fallbackSeed}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const task = (async (): Promise<AnyTexture> => {
      if (url) {
        try {
          const tex = await this.textureLoader.loadAsync(resolveAssetUrl(url));
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = fallbackKey === 'noise' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
          return this.remember(key, tex);
        } catch {
          // 素材が無いのは想定内。黙って手続き生成に落とす。
        }
      }
      return this.remember(key, this.generate(fallbackKey, fallbackSeed));
    })();

    this.pending.set(key, task);
    const result = await task;
    this.pending.delete(key);
    return result;
  }

  /**
   * 「あれば使う、無ければ何もしない」テクスチャ。
   *
   * loadTexture は必ず手続き生成にフォールバックするので、
   * 「素材が無いなら貼らない」用途には使えない。体表の色マップのように、
   * 代役を立てるより「貼らない」ほうが正しい素材のためのもの。
   */
  async loadOptionalTexture(url: string | null): Promise<THREE.Texture | null> {
    if (!url) return null;
    const key = `optional:${url}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    try {
      const tex = await this.textureLoader.loadAsync(resolveAssetUrl(url));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      return this.remember(key, tex);
    } catch {
      // 素材が無いのは想定内。貼らずに進む（§2 エラー画面を出さない）
      warnMissingAsset('体の模様', url);
      return null;
    }
  }

  /** 同期で手続き生成テクスチャが欲しい場合（初期化時に await したくない箇所用） */
  getProcedural(kind: ProceduralKind, seed = 0): AnyTexture {
    const key = `${kind}:${seed}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    return this.remember(key, this.generate(kind, seed));
  }

  /**
   * GLTF を読む。無ければ null（呼び出し側が ProceduralFish にフォールバック）。
   * GLTFLoader は動的 import にして、素材が無いときはバンドルを読み込まない。
   */
  async loadModel(url: string | null): Promise<THREE.Object3D | null> {
    if (!url) return null;
    try {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(resolveAssetUrl(url));
      return gltf.scene;
    } catch {
      warnMissingAsset('モデル', url);
      return null;
    }
  }

  private remember(key: string, tex: AnyTexture): AnyTexture {
    if (this.disposed) {
      tex.dispose();
      return tex;
    }
    this.cache.set(key, tex);
    return tex;
  }

  private generate(kind: ProceduralKind, seed: number): AnyTexture {
    // Canvas が使えない環境（DOM の無いテスト実行など）では、
    // 効果が無いだけの1×1テクスチャに落とす。例外は投げない（§2）。
    if (!canUseCanvas()) return makeFlatFallback(kind);

    switch (kind) {
      case 'particle':
        return makeParticleTexture();
      case 'noise':
        return makeNoiseTexture(seed);
    }
  }

  /** 生成済みテクスチャを全て破棄（不変条件8） */
  /**
   * テクスチャが占める VRAM の**推定値**（バイト）。
   *
   * three.js は枚数（`renderer.info.memory.textures`）しか持たないので、
   * 画像の幅×高さから見積もる。実測ではない。score.json でも
   * `"estimated": true` を立てて、後から見た人が実測値と誤認しないようにしてある。
   *
   * 見積もりの根拠:
   *   幅 × 高さ × 4バイト（RGBA8）× 1.334（ミップマップの総和 = 1 + 1/4 + 1/16 + …）
   *
   * 含まないもの: ポスト処理のレンダーターゲット（composer が持つ）、
   * three が内部で作る 1x1 の既定テクスチャ、圧縮テクスチャ（使っていない）。
   * つまり「素材由来のテクスチャがどれだけ増えたか」を追うための数字。
   */
  estimateTextureBytes(): { bytes: number; count: number; estimated: true } {
    let bytes = 0;
    let count = 0;
    for (const tex of this.cache.values()) {
      const img = tex.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
      if (!img) continue;
      const w = img.width ?? img.videoWidth ?? 0;
      const h = img.height ?? img.videoHeight ?? 0;
      if (w <= 0 || h <= 0) continue;
      count++;
      // ミップマップを作らない設定のテクスチャもあるが、区別せず一律で見積もる
      // （区別すると three の内部フラグに依存して、版が上がるたびに値が動くため）
      bytes += w * h * 4 * (tex.generateMipmaps ? 4 / 3 : 1);
    }
    return { bytes: Math.round(bytes), count, estimated: true };
  }

  dispose(): void {
    this.disposed = true;
    for (const tex of this.cache.values()) tex.dispose();
    this.cache.clear();
    this.pending.clear();
  }
}

/** ---- 手続き生成テクスチャ ------------------------------------------------ */

/** Canvas に描けるか（DOM の無い環境や、2D コンテキストを取れない環境がある） */
function canUseCanvas(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return document.createElement('canvas').getContext('2d') !== null;
  } catch {
    return false;
  }
}

/**
 * Canvas が使えないときの代役。1×1 の単色で、見た目に影響を与えない値にする。
 *   ノイズ → 中間のグレー（模様が乗らないだけ）
 *   粒子   → 白
 */
function makeFlatFallback(kind: ProceduralKind): THREE.DataTexture {
  const pixel = kind === 'noise' ? [128, 128, 128, 255] : [255, 255, 255, 255];
  const tex = new THREE.DataTexture(new Uint8Array(pixel), 1, 1);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 浮遊物・泡用のソフトな丸スプライト */
export function makeParticleTexture(size = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.03)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 餌の粒（§7-1）。
 *
 * `particle` は中心が明るく外へ向かって消えるだけの光の玉で、**影が無い**。
 * おおきなすいそうの明るい青の実写の上に置くと、輪郭がぼやけて泡と区別が付かず、
 * 実機で「餌が見えるようになったが影が弱くてわかりづらい」と言われた。
 *
 * ここでは「光の玉」ではなく「粒」を描く:
 *  - 光は左上から当たっているものとして、明るい部分を左上へ寄せる
 *  - 外周に**暗い縁**を置く。これが「影」になって、明るい背景の上でも粒として立つ
 *  - アルファは中心付近まで 1 のまま保ち、いちばん外側だけで落とす
 *    （particle のように滑らかに消すと、また輪郭が無くなる）
 */

/**
 * 汎用のタイル可能なノイズ。地面のざらつきや、背景のむらに使う。
 *
 * みずのなかのコースティクス／水面法線の代わりにこれ1枚だけ持つ。
 * 水の絵に固有のものは持ってきていない（必要になってから足す）。
 */
export function makeNoiseTexture(seed = 0, size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size, y / size, 4, seed, 4);
      const v = Math.round(THREE.MathUtils.clamp(n, 0, 1) * 255);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
