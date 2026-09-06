/**
 * サプライズ「ばあっ！」（§6-3 / 2026-09-06 に人間が決めた形）
 *
 * ==========================================================================
 * タップして動物が出た山（§4-3）で、**たまに画面の下から大きな動物が
 * ひょっこり出てくる**。画面の高さの 2/3 を占める大きさで、
 * 「ばあっ！」と言って、また下へ引っ込む。
 *
 * **設計書 §6-3 との違い（人間が決めた）。**
 * §6-3 は「10回に1回・20回に1回・30回に1回」で、
 * 「頻度は低く保つ。毎回起きると普通になり、驚きが消える」と書いてある。
 * ここは **3回に1回**（`SURPRISE_CHANCE`）にしてある。
 * 飽きが早ければ、この定数だけを下げること。
 *
 * 守っていること:
 *  - **画面の入力を塞がない。** three の板なので、DOM のタップは
 *    そのまま下の隠れ場所に届く（不変条件1）
 *  - **出ているあいだに押しても、いつもどおり動物が出る**（不変条件2）。
 *    ここは何も止めない
 *  - **連続で出さない。** 直前に出ていたら必ず外す。加えて最短間隔を置く。
 *    3回に1回でも、2回続くと「大きいのが普通」になってしまう
 *  - **明滅させない**（不変条件6）。動くのは位置だけで、色は変えない
 *  - `prefers-reduced-motion` のときは動きを浅く、短くする
 *  - 乱数は**独立した種**から引く（three の `generateUUID()` が
 *    `Math.random()` を1オブジェクトにつき4回消費するので、
 *    共有の乱数列に相乗りすると、モデルを1つ足しただけで抽選が変わる）
 * ==========================================================================
 */

import * as THREE from 'three';

import { disposeObject3D } from './SpotShapes';

/**
 * 抽選の当たり。**これは「実際に出る割合」ではない。**
 *
 * 出た次の回を必ず外す（2連続で出さない）ので、長い目で見た割合は
 * `p / (1 + p)` に寄る。人間が決めたのは「**見た目で3回に1回**」なので、
 * そこから逆算して p = 0.5 にしてある（0.5 / 1.5 = 1/3）。
 * 1/3 をそのまま入れたときの実測は 3.7〜4.0回に1回だった。
 *
 * **設計書 §6-3 は 1/10〜1/30 で「頻度は低く保つ」としている。**
 * ここはそれより高い。飽きが早ければ、この定数だけを下げること。
 */
export const SURPRISE_CHANCE = 0.5;

/**
 * 画面の高さの何割を占めるか。**人間が決めた**（2026-09-06 に 2/3 → 3/4）。
 *
 * 横に広い動物（かに・ちょうちょ）は、これより先に**幅**で頭打ちになる
 * （画面幅の 0.92 まで）。その場合は高さがこの割合に届かない
 */
const SCREEN_FRACTION = 0.75;

/** カメラからの距離。手前すぎると歪む。奥すぎると隠れ場所とぶつかる */
const DISTANCE = 3.0;

/* --- §6-3 のタイミング。**動かすときはここだけ見ればよい** ----------------- */

/** 下から上がりきるまで */
const RISE_SEC = 0.32;
/** 上で止まっている時間 */
const HOLD_SEC = 1.05;
/** 下へ戻るまで */
const FALL_SEC = 0.42;
/** 「ばあっ！」を言う時刻（上がりきった直後） */
const VOICE_AT_SEC = 0.3;
/** ひと通り */
export const SURPRISE_TOTAL_SEC = RISE_SEC + HOLD_SEC + FALL_SEC;

/** 連続で出さないための最短間隔。連打しても大きいのが並ばない */
const MIN_GAP_SEC = 2.6;

/** 上がりきったところで少しだけ跳ねる量（§4-4 のオーバーシュートと同じ考え） */
const OVERSHOOT = 0.06;

/** `Math.random()` を使わないための、独立した乱数（みずのなかの実測） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SurpriseEvent = (animalId: string) => void;

export interface SurpriseOptions {
  seed?: number;
  reducedMotion?: boolean;
  chance?: number;
}

export class Surprise {
  /** カメラの子にする。**カメラ空間なので、画面のどこに出るかが素直に決まる** */
  readonly group = new THREE.Group();

  private readonly rng: () => number;
  private readonly reducedMotion: boolean;
  private readonly chance: number;
  private readonly voiceFns: SurpriseEvent[] = [];

  private textures: ReadonlyMap<string, THREE.Texture> = new Map();
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshBasicMaterial | null = null;

  /** 走っている最中の経過秒。null なら止まっている */
  private t: number | null = null;
  private animalId = '';
  private voiced = false;
  private clock = 0;
  private lastEndAt = -Infinity;
  private justFired = false;

  /** 出した回数と、抽選した回数。**テストはここを見る** */
  private fired = 0;
  private rolled = 0;

  constructor(options: SurpriseOptions = {}) {
    this.rng = mulberry32(options.seed ?? ((Date.now() ^ 0x85ebca6b) >>> 0));
    this.reducedMotion = options.reducedMotion ?? false;
    this.chance = options.chance ?? SURPRISE_CHANCE;
    this.group.name = 'surprise';
  }

  /** 場面が変わったら差し替える。**絵が無い動物は出さない**（不変条件7） */
  setTextures(textures: ReadonlyMap<string, THREE.Texture>): void {
    this.textures = textures;
  }

  onVoice(fn: SurpriseEvent): void {
    this.voiceFns.push(fn);
  }

  /**
   * 抽選して、当たれば出す。**当たらなくても何も止めない。**
   *
   * @returns 出したら `true`
   */
  maybeTrigger(animalId: string): boolean {
    this.rolled++;
    // **連続で出さない。** 直前に出ていたら必ず外す
    if (this.justFired) {
      this.justFired = false;
      return false;
    }
    if (this.t !== null) return false;
    if (this.clock - this.lastEndAt < MIN_GAP_SEC) return false;
    if (!this.textures.has(animalId)) return false;
    if (this.rng() >= this.chance) return false;

    this.animalId = animalId;
    this.t = 0;
    this.voiced = false;
    this.fired++;
    this.justFired = true;
    return true;
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.clock += dt;
    if (this.t === null) {
      this.group.visible = false;
      return;
    }

    // 大きさは毎回決め直す。**画面の向きが変わると視野が変わる**
    // （縦持ちで fov 66、横持ちで 55。`Renderer` が入れ替える）
    if (this.t === 0) this.build(camera);
    if (!this.mesh) {
      this.t = null;
      return;
    }

    this.t += dt;
    const t = this.t;

    if (!this.voiced && t >= VOICE_AT_SEC) {
      this.voiced = true;
      for (const fn of this.voiceFns) fn(this.animalId);
    }

    const lift = this.liftAt(t);
    const h = this.mesh.userData.planeHeight as number;
    const viewBottom = -(this.mesh.userData.viewHeight as number) / 2;
    // 隠れているとき: 画面の下に完全に外れている
    const hiddenY = viewBottom - h / 2 - 0.02;
    // 出きったとき: 下辺が画面の下辺にそろう
    const outY = viewBottom + h / 2;
    this.mesh.position.y = hiddenY + (outY - hiddenY) * lift;
    this.group.visible = true;

    if (t >= SURPRISE_TOTAL_SEC) {
      this.t = null;
      this.lastEndAt = this.clock;
      this.group.visible = false;
    }
  }

  /** 0..1。**色は変えない。動くのは位置だけ**（不変条件6） */
  private liftAt(t: number): number {
    const over = this.reducedMotion ? 0 : OVERSHOOT;
    if (t < RISE_SEC) {
      const p = t / RISE_SEC;
      const eased = 1 - (1 - p) * (1 - p) * (1 - p);
      return eased * (1 + over) - over * eased * eased;
    }
    if (t < RISE_SEC + HOLD_SEC) return 1;
    const p = Math.min(1, (t - RISE_SEC - HOLD_SEC) / FALL_SEC);
    return 1 - p * p;
  }

  private build(camera: THREE.PerspectiveCamera): void {
    this.clear();
    const texture = this.textures.get(this.animalId);
    if (!texture) return;

    // カメラから DISTANCE 離れたところで、画面に写るワールドの高さと幅
    const viewHeight = 2 * DISTANCE * Math.tan((camera.fov * Math.PI) / 360);
    const viewWidth = viewHeight * camera.aspect;

    const image = texture.image as { width?: number; height?: number } | null;
    const aspect = (image?.width ?? 1) / (image?.height ?? 1);
    let planeHeight = viewHeight * SCREEN_FRACTION;
    let planeWidth = planeHeight * aspect;
    // 横に広い動物（かに・ちょうちょ）が画面からはみ出さないようにする
    if (planeWidth > viewWidth * 0.92) {
      planeWidth = viewWidth * 0.92;
      planeHeight = planeWidth / aspect;
    }

    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      alphaTest: 0.5,
      transparent: false,
      side: THREE.DoubleSide,
      // 参照画像の色をそのまま出す（`CutoutAnimal` と同じ理由）
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeWidth, planeHeight), this.material);
    this.mesh.position.z = -DISTANCE;
    this.mesh.userData.planeHeight = planeHeight;
    this.mesh.userData.viewHeight = viewHeight;
    // いちばん手前。隠れ場所より前に出す
    this.mesh.renderOrder = 10;
    this.group.add(this.mesh);
  }

  private clear(): void {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    // **テクスチャは `AssetLoader` が持っている。** ここで捨てない
    disposeObject3D(this.mesh, { keepTextures: true });
    this.mesh = null;
    this.material = null;
  }

  isRunning(): boolean {
    return this.t !== null;
  }

  getFiredCount(): number {
    return this.fired;
  }

  getRolledCount(): number {
    return this.rolled;
  }

  dispose(): void {
    this.clear();
    this.voiceFns.length = 0;
    this.t = null;
  }
}
