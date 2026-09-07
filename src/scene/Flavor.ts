/**
 * 場面ごとの味つけ（2026-09-07。人間が「場面ごとのスペシャル案」として決めた）
 *
 * ==========================================================================
 * **`if (scene.id === 'kyoryu')` と書かないための入れ物。**
 *
 * 動物を17体にしたときに、`switch (cfg.id)` の分岐が「顔」「頭の上」「尾」の
 * 3箇所に散って、新しい動物を足したときに1箇所だけ入れ忘れた（既存5体の耳と尾が
 * 消えた）。場面の演出でも同じことが起きる。だから**演出の実装はここに1つずつ置き、
 * 場面はデータ（`SceneConfig.flavor`）で選ぶだけ**にする。
 * 新しい場面を足しても、ここには何も書き足さない。
 *
 * **このクラスが隠れ場所に対して書き換えてよいのは `group.rotation.z` だけ。**
 * `SpotSystem` は `shape.setOpen()` / `shape.setWobble()`（＝ shape 側の姿勢）
 * しか触らないので、書き手が衝突しない。位置は動かさない:
 * 当たり判定は `worldPosition`（＝設定した座標）を投影して決まるので、
 * 見た目だけ動かすと「押したのに反応しない」に近づく（みずのなかの岩）。
 * 回転は隠れ場所の中心まわりなので、中心はずれない。
 *
 * **常時のゆれ（`sway`）は、隠れ場所ではなく飾りを揺らす。**
 * ここは実測で決めた（2026-09-07）。隠れ場所ごと傾けた版を作って
 * 「隠れているあいだ、体はどこからも覗けない」に掛けたところ、
 * **うみ の かいそう は 0.75° で体が見えた**（15×15 の格子のうち1点）。
 * 傾けられる角度を場所ごとに測ると:
 *
 *   おうち  はこ 9.75° / カーテン 12°超 / ふとん 7.25° / とびら 12°超
 *   うみ    すいめん 12°超 / **かいそう 0.75°** / いわ 12°超 / つぼ 12°超
 *   どうぶつえん  ...  / うえきばち 6.25°
 *   （ほかは 12°まで漏れなし）
 *
 * かいそうに合わせると 0.3° 程度しか振れず、画面では 1px も動かない。
 * **見えない演出のために不変条件3 の余裕を食うのは割に合わない。**
 * だから常時のゆれは、隠れ場所より奥（z < 0）に置いた飾り
 * （草・かいそう）だけを揺らす。**奥にあるので、動物を隠すことが原理的にない。**
 *
 * ため のもぞもぞ（`wobble`）と地ひびき（`quake`）は隠れ場所を回すが、
 * どちらも短く、上の余裕の半分以下に収めてある。
 * **その余裕はテストが見張っている**（「味つけの傾きが、隠れている体を
 * 覗かせない」）ので、新しい場面に付けたときに気づける。
 * ==========================================================================
 */

import * as THREE from 'three';

import { detectReducedMotion } from '../peekaboo/AnimalSystem';
import { disposeObject3D } from '../peekaboo/SpotShapes';
import type { SpotRuntime } from '../peekaboo/SpotSystem';
import type { CrossingKind, SceneFlavor, SpotState, SwayKind } from '../types';

/* --- ゆれ（常時）--------------------------------------------------------- */

/**
 * 風。**左から右へ波が渡る**ように、x 座標ぶん位相をずらす。
 * 全部同じ位相にすると「いっせいに傾く」ので、風ではなく地震に見えた。
 */
const WIND_HZ = 0.19;
export const WIND_AMP_RAD = 0.16;
/** ひとわたり吹いては止む。振幅そのものをゆっくり上下させる */
const WIND_GUST_HZ = 0.07;
/** x 1 あたりの位相の遅れ[rad]。左端と右端で 5rad ほどずれる */
const WIND_PHASE_PER_X = 0.55;

/* --- 飾り（ゆれるもの）--------------------------------------------------- */

/**
 * 草・かいそうを置く高さと本数。
 *
 * **必ず隠れ場所より奥（z < 0）に置く。** 手前に置くと、隠れている動物を
 * 覆って不変条件3 を壊せてしまう。奥なら原理的にそれが起きない。
 */
const PROP_Z = -0.75;
const PROP_Y = -3.4;
/**
 * 画面の端まで並べる。端で途切れると「板を置いた」ように見える。
 *
 * **画面に入る範囲は実測で決めた**（2026-09-07）。縦持ちのカメラは
 * fov 66°・アスペクト 0.49 なので、この奥行き（z = -0.75、カメラから 7.95）で
 * 見えるのは y が ±5.16、**x は ±2.53 しかない**。
 * はじめ ±5.2 に並べたら 7株のうち4株が画面の外で、
 * 三角形が 21 増えるはずのところ 9 しか増えなかった（e2e の実測で気づいた）。
 */
const PROP_SPAN_X = 2.8;
export const PROP_COUNT = 9;

/** 水。方向を持たないので、位相は座標ではなく並び順でずらす */
const WATER_HZ = 0.13;
export const WATER_AMP_RAD = 0.2;
/** 2つめの波。1つの sin だけだと機械の往復に見える */
const WATER_HZ2 = 0.31;
export const WATER_AMP2_RAD = 0.07;

/* --- もぞもぞ（ため のあいだだけ）---------------------------------------- */

/**
 * 押してから動物が出はじめるまでの 0.15秒（§4-3 の ため）に、
 * 隠れ場所が小刻みに動く。「中で誰かが動いている」を先に見せる。
 *
 * **ふた（`shape`）ではなく隠れ場所ごと**動かす。ふたの側は `SpotSystem` の
 * 「ぷるっ」が既に使っていて、同じものを2人で書くことになる。
 */
const WOBBLE_HZ = 5.5;
export const WOBBLE_AMP_RAD = 0.03;

/* --- 地ひびき（きょうりゅう）--------------------------------------------- */

/** 登場の山で、4箇所がいっせいに揺れる。**明滅ではなく動き**（不変条件6） */
const QUAKE_HZ = 7;
export const QUAKE_AMP_RAD = 0.05;
export const QUAKE_SEC = 0.45;

/* --- 足音（きょうりゅう・どうぶつえん）------------------------------------ */

/**
 * ため のあいだに2回。**間隔を詰める**（近づいてくるように聞こえる）。
 * ため は 0.15秒なので、0.00s と 0.09s。
 */
export const FOOTSTEP_AT_SEC = [0, 0.09] as const;

/* --- 横切るもの ----------------------------------------------------------- */

/** 端から端まで渡る時間。急ぐと目で追えない */
export const CROSS_SEC = 7;
/** 渡り終えてから次までの間。短いと「ずっと何か飛んでいる」で気が散る */
export const CROSS_GAP_SEC = 9;
/** 画面外の x。ここから入って、反対の同じところまで抜ける */
export const CROSS_X = 5.6;
/** 隠れ場所（z = 0）より奥、背景（z = -1.6）より手前 */
const CROSS_Z = -0.9;

/** ちょうちょの羽ばたき。速いが、動くのは羽だけなので明滅にはならない */
const FLAP_HZ = 5;

/**
 * この味つけが隠れ場所を傾けうる最大角[rad]。
 *
 * **テストがこの2倍で「体が覗けないこと」を確かめる。**
 * 新しい場面に `wobble` や `quake` を付けたとき、その場面の隠れ場所に
 * 余裕があるかどうかが自動で分かる（うみ の かいそう は 0.75° しか無い）。
 */
export function maxSpotTiltRad(flavor: SceneFlavor | undefined): number {
  if (!flavor) return 0;
  return (flavor.wobble ? WOBBLE_AMP_RAD : 0) + (flavor.quake ? QUAKE_AMP_RAD : 0);
}

/** `Math.random()` を使わないための独立した乱数（みずのなかの実測） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FlavorOptions {
  /** `prefers-reduced-motion`。動きを浅くする（不変条件6） */
  reducedMotion?: boolean;
  /** 横切るものの高さの抽選。E2E から固定する */
  seed?: number;
}

/** 足音のイベント。`App` が音に繋ぐ（ここでは音を鳴らさない） */
export type FlavorEvent = () => void;

export class Flavor {
  /** 横切るものを入れる。`SceneRoot` が場面の group に足して、まとめて捨てる */
  readonly group = new THREE.Group();

  private readonly spots: readonly SpotRuntime[];
  private readonly flavor: SceneFlavor;
  private readonly depth: number;
  private readonly rng: () => number;

  /** 前フレームの状態。遷移（hidden→appearing / appearing→out）を拾う */
  private readonly prevState: SpotState[] = [];

  private clock = 0;
  /** 地ひびきの残り秒。0 なら揺れていない */
  private quakeLeft = 0;
  /** 鳴らし待ちの足音。`[鳴らす時刻]` を昇順で持つ */
  private readonly footstepAt: number[] = [];
  private footsteps = 0;
  private readonly footstepFns: FlavorEvent[] = [];

  /** ゆれる飾り（草・かいそう）。**隠れ場所より奥**（`PROP_Z`） */
  private props: THREE.Object3D[] = [];

  /** 横切るもの。1匹ぶんの見た目と、いま渡っているかどうか */
  private crossing: THREE.Object3D | null = null;
  private crossWings: THREE.Object3D[] = [];
  /** 次に出るまでの待ち時間。負のあいだは渡っている */
  private crossWait = CROSS_GAP_SEC * 0.5;
  private crossT = 0;
  private crossFromLeft = true;
  private crossY = 1;
  private crossings = 0;

  constructor(spots: readonly SpotRuntime[], flavor: SceneFlavor | undefined, options: FlavorOptions = {}) {
    this.spots = spots;
    this.flavor = flavor ?? {};
    // 動きを浅くする。**止めない。** 止めると「何も無い画面」になる
    this.depth = (options.reducedMotion ?? detectReducedMotion()) ? 0.4 : 1;
    this.rng = mulberry32(options.seed ?? 0x9e3779b9);
    for (const s of spots) this.prevState.push(s.state);
    if (this.flavor.sway) {
      this.props = this.buildProps(this.flavor.sway);
      for (const p of this.props) this.group.add(p);
    }
    if (this.flavor.crossing) this.crossing = this.buildCrossing(this.flavor.crossing);
    if (this.crossing) {
      this.crossing.visible = false;
      // **待っているあいだも奥に置いておく。** 原点に置いたままだと、
      // 「飾りは必ず隠れ場所より奥」という保証が待機中だけ崩れる
      this.crossing.position.set(-CROSS_X, 0, CROSS_Z);
      this.group.add(this.crossing);
    }
  }

  onFootstep(fn: FlavorEvent): void {
    this.footstepFns.push(fn);
  }

  /**
   * 1フレーム進める。**`SpotSystem.update()` のあとに呼ぶこと。**
   * 先に呼ぶと、状態の遷移を1フレーム遅れて拾う。
   */
  update(dt: number): void {
    this.clock += dt;
    this.readTransitions(dt);
    this.applySpotTilt();
    this.applyPropSway();
    this.updateCrossing(dt);
  }

  /** 遷移を拾って、足音と地ひびきを仕込む */
  private readTransitions(dt: number): void {
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      const prev = this.prevState[i];
      this.prevState[i] = s.state;
      if (prev === s.state) continue;

      // ため のはじまり。ここから 0.15秒 のあいだに足音を2回
      if (s.state === 'appearing' && this.flavor.footstep && s.delay > 0) {
        for (const at of FOOTSTEP_AT_SEC) this.footstepAt.push(this.clock + at);
      }
      // 登場の山。**出きった瞬間**に地ひびき（§4-3 の 0.50s）
      if (prev === 'appearing' && s.state === 'out' && this.flavor.quake) {
        this.quakeLeft = QUAKE_SEC;
      }
    }

    while (this.footstepAt.length > 0 && this.footstepAt[0] <= this.clock) {
      this.footstepAt.shift();
      this.footsteps++;
      for (const fn of this.footstepFns) fn();
    }
    this.quakeLeft = Math.max(0, this.quakeLeft - dt);
  }

  /**
   * 隠れ場所を回すぶん（もぞもぞ と 地ひびき）。
   *
   * **常時のゆれ（`sway`）はここに入れない。** 飾りのほうを揺らす
   * （冒頭の実測。かいそうは 0.75° で体が見えた）。
   */
  private applySpotTilt(): void {
    const quake =
      this.quakeLeft > 0
        ? Math.sin(this.clock * QUAKE_HZ * Math.PI * 2) *
          QUAKE_AMP_RAD *
          (this.quakeLeft / QUAKE_SEC) *
          this.depth
        : 0;

    for (const s of this.spots) {
      let rot = quake;
      if (this.flavor.wobble && s.state === 'appearing' && s.delay > 0) {
        rot += Math.sin(this.clock * WOBBLE_HZ * Math.PI * 2) * WOBBLE_AMP_RAD * this.depth;
      }
      // **毎フレーム絶対値で書く。** += にすると、揺れが止まったときに
      // 傾いたまま残る
      s.group.rotation.z = rot;
    }
  }

  /** 飾り（草・かいそう）を揺らす */
  private applyPropSway(): void {
    const kind = this.flavor.sway;
    if (!kind) return;
    const t = this.clock;
    for (const prop of this.props) {
      if (kind === 'wind') {
        const gust = 0.55 + 0.45 * Math.sin(t * WIND_GUST_HZ * Math.PI * 2);
        const phase = prop.position.x * WIND_PHASE_PER_X;
        prop.rotation.z =
          Math.sin(t * WIND_HZ * Math.PI * 2 - phase) * WIND_AMP_RAD * gust * this.depth;
      } else {
        const phase = prop.position.x * 0.8;
        prop.rotation.z =
          (Math.sin(t * WATER_HZ * Math.PI * 2 + phase) * WATER_AMP_RAD +
            Math.sin(t * WATER_HZ2 * Math.PI * 2 + phase * 1.7) * WATER_AMP2_RAD) *
          this.depth;
      }
    }
  }

  /**
   * 草・かいそうを作る。
   *
   * 1株＝三角形3枚を**1つのジオメトリにまとめる**（draw call を増やさない）。
   * 株ごとに分けているのは、株ごとに位相をずらして「波が渡る」ようにするため。
   * まとめて1つにすると、全部が同時に傾いて風に見えない。
   */
  private buildProps(kind: SwayKind): THREE.Object3D[] {
    const props: THREE.Object3D[] = [];
    const tall = kind === 'water';
    for (let i = 0; i < PROP_COUNT; i++) {
      // 等間隔にしない。並べると人工物に見える
      const jitter = (this.rng() - 0.5) * 0.9;
      const x = -PROP_SPAN_X + ((2 * PROP_SPAN_X) / (PROP_COUNT - 1)) * i + jitter;
      const h = (tall ? 1.5 : 1.0) * (0.7 + this.rng() * 0.7);
      const w = tall ? 0.16 : 0.22;

      // 三角形3枚。中央が高く、両側が低い
      const pos: number[] = [];
      for (const [lean, scale] of [
        [-0.28, 0.72],
        [0.05, 1],
        [0.32, 0.66],
      ] as const) {
        const th = h * scale;
        const tipX = lean * th;
        pos.push(-w / 2, 0, 0, w / 2, 0, 0, tipX, th, 0);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();

      // **背景として読ませる。** 明るく塗ると、飾りのほうが動物より目立つ。
      // 実測（2026-09-07）: L=0.34 で撮った版は、草が隠れ場所より手前に
      // 見えるほど強かった。背景のグラデーション（`SceneConfig.sky`）の
      // 下端くらいの明るさに落としてある
      const hue = tall ? 0.45 + this.rng() * 0.06 : 0.26 + this.rng() * 0.08;
      const color = new THREE.Color().setHSL(hue, tall ? 0.45 : 0.5, tall ? 0.2 : 0.22);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false })
      );
      // **根元を軸に回す。** 中心で回すと、揺れるたびに根元が浮く
      mesh.position.set(x, PROP_Y, PROP_Z + i * 0.01);
      props.push(mesh);
    }
    return props;
  }

  /* --- 横切るもの --------------------------------------------------------- */

  private updateCrossing(dt: number): void {
    const obj = this.crossing;
    if (!obj) return;

    if (this.crossWait > 0) {
      this.crossWait -= dt;
      if (this.crossWait > 0) return;
      // 出発。高さと向きを引き直す
      this.crossT = 0;
      this.crossFromLeft = !this.crossFromLeft;
      this.crossY = 0.1 + this.rng() * 1.8;
      this.crossings++;
      obj.visible = true;
    }

    this.crossT += dt;
    const u = this.crossT / CROSS_SEC;
    if (u >= 1) {
      obj.visible = false;
      this.crossWait = CROSS_GAP_SEC;
      return;
    }

    const from = this.crossFromLeft ? -CROSS_X : CROSS_X;
    obj.position.set(
      from + (this.crossFromLeft ? 2 : -2) * CROSS_X * u,
      this.crossY + Math.sin(u * Math.PI * 4) * 0.35 * this.depth,
      CROSS_Z
    );
    // 進む向きを向く。**裏返さない**（板1枚なので裏を向くと消える）
    obj.scale.x = this.crossFromLeft ? 1 : -1;

    // ちょうちょの羽ばたき。魚は尾を振る（どちらも `crossWings` に入れてある）
    const flap = Math.sin(this.clock * FLAP_HZ * Math.PI * 2);
    for (let i = 0; i < this.crossWings.length; i++) {
      const w = this.crossWings[i];
      const dir = i % 2 === 0 ? 1 : -1;
      if (this.flavor.crossing === 'butterfly') w.rotation.y = flap * 0.9 * dir * this.depth;
      else w.rotation.z = flap * 0.35 * this.depth;
    }
  }

  /**
   * 横切るものを作る。
   *
   * **手続き生成だけで作る。** 素材が1枚も無くても場面が成り立つこと（不変条件7）。
   * 板を数枚だけ。三角形を増やすと、いちばん重い のはら（8,716）を押し上げる
   */
  private buildCrossing(kind: CrossingKind): THREE.Object3D {
    const group = new THREE.Group();
    this.crossWings = [];

    if (kind === 'butterfly') {
      const body = new THREE.Mesh(
        new THREE.PlaneGeometry(0.05, 0.22),
        new THREE.MeshBasicMaterial({ color: 0x4a3a2a, toneMapped: false })
      );
      group.add(body);
      for (const dir of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.x = dir * 0.02;
        const wing = new THREE.Mesh(
          new THREE.PlaneGeometry(0.2, 0.24),
          new THREE.MeshBasicMaterial({ color: 0xffe27a, toneMapped: false, side: THREE.DoubleSide })
        );
        wing.position.x = dir * 0.11;
        pivot.add(wing);
        group.add(pivot);
        this.crossWings.push(pivot);
      }
      return group;
    }

    // 小魚の群れ。1匹だと寂しく、多いと目が散る
    for (let i = 0; i < 3; i++) {
      const fish = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CircleGeometry(0.11, 10),
        new THREE.MeshBasicMaterial({ color: 0xbfe6ff, toneMapped: false, side: THREE.DoubleSide })
      );
      body.scale.set(1.5, 0.6, 1);
      fish.add(body);
      const tail = new THREE.Group();
      const fin = new THREE.Mesh(
        new THREE.PlaneGeometry(0.1, 0.14),
        new THREE.MeshBasicMaterial({ color: 0x8fd0f0, toneMapped: false, side: THREE.DoubleSide })
      );
      fin.position.x = -0.05;
      tail.position.x = -0.16;
      tail.add(fin);
      fish.add(tail);
      this.crossWings.push(tail);
      fish.position.set(-i * 0.34, (i % 2 === 0 ? 1 : -1) * 0.16, i * 0.02);
      fish.scale.setScalar(1 - i * 0.12);
      group.add(fish);
    }
    return group;
  }

  /* --- 実測用（E2E から見る）--------------------------------------------- */

  getFootstepCount(): number {
    return this.footsteps;
  }

  getCrossingCount(): number {
    return this.crossings;
  }

  isQuaking(): boolean {
    return this.quakeLeft > 0;
  }

  /** いちばん傾いている隠れ場所の角度[rad]。不変条件3 の余裕を食っていないか見る */
  getMaxTiltRad(): number {
    let max = 0;
    for (const s of this.spots) max = Math.max(max, Math.abs(s.group.rotation.z));
    return max;
  }

  /** ゆれる飾りの数。0 なら `sway` を指定していない場面 */
  getPropCount(): number {
    return this.props.length;
  }

  /** いちばん傾いている飾りの角度[rad] */
  getMaxPropTiltRad(): number {
    let max = 0;
    for (const p of this.props) max = Math.max(max, Math.abs(p.rotation.z));
    return max;
  }

  /**
   * 捨てる（不変条件8）。
   *
   * **傾けたぶんを戻してから捨てる。** `SpotSystem` は自分で捨てるが、
   * 戻し忘れると「場面を捨てたのに隠れ場所が傾いたまま」の一瞬が出る
   */
  dispose(): void {
    for (const s of this.spots) s.group.rotation.z = 0;
    for (const p of this.props) disposeObject3D(p);
    this.props = [];
    this.crossWings = [];
    if (this.crossing) {
      disposeObject3D(this.crossing);
      this.crossing = null;
    }
    disposeObject3D(this.group);
    this.footstepFns.length = 0;
  }
}
