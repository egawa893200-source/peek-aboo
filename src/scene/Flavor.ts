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
import type { SpotHitTester, SpotRuntime } from '../peekaboo/SpotSystem';
import type { CrossingKind, LeftoverKind, SceneFlavor, SpotState, SwayKind } from '../types';

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

/** 隠れ場所にとまる割合。**毎回とまらせない**（とまるから意味がある） */
export const LAND_CHANCE = 0.5;
/** とまっている時間。短いと「ぶつかった」に見える */
export const PERCH_SEC = 1.6;
/** とまる高さ。**ふたの上に出す。** 中に入ると隠れ場所に食われて見えない */
const PERCH_LIFT = 1.0;

/* --- あぶく（うみ）------------------------------------------------------- */

/** 同時に上がっている数。多いと目が散る */
export const BUBBLE_COUNT = 7;
/** 下から上まで昇る時間 */
const BUBBLE_RISE_SEC = 9;
const BUBBLE_BOTTOM_Y = -4.2;
const BUBBLE_TOP_Y = 4.6;
/** 隠れ場所より奥。**手前に置くと動物に丸がかぶる** */
const BUBBLE_Z = -0.55;
/** 押したときに割れる距離（CSS px）。隠れ場所の判定より小さくする */
export const BUBBLE_POP_PX = 70;
/** 割れてから次に出るまで */
const BUBBLE_RESPAWN_SEC = 1.2;

/* --- みんなで鳴く（のうじょう）-------------------------------------------- */

/** 呼び込みの間隔。**短いと「勝手に動く画面」になって、押す気が失せる** */
export const CHORUS_EVERY_SEC = 16;
/** 1箇所ずつずらす時間 */
const CHORUS_STEP_SEC = 0.45;
/** 1箇所が鳴きはじめてから収まるまで */
const CHORUS_OPEN_SEC = 0.7;

/* --- 足あと（のはら）----------------------------------------------------- */

/** 残る数。これを超えたら古いものから消す */
export const FOOTPRINT_MAX = 12;
/** 消えるまで。**長いと画面が足あとだらけになる** */
const FOOTPRINT_FADE_SEC = 3.2;
/** 隠れ場所より奥。地面に落ちた跡なので下のほう */
const FOOTPRINT_Z = -0.5;
/**
 * 足あとを置く高さ。
 *
 * **跳ねた高さに置いてはいけない**（2026-09-07 の実測）。
 * うさぎの居る高さに落とすと、5つのくさむらのどれかが必ず前に来て、
 * **4つ置いても画面には1つも見えなかった**（赤く塗って撮って分かった）。
 * くさむらの下端（いちばん下の段で およそ -2.0）より下、
 * ゆれる草（-3.4）より上に、横一列で残す。
 * **どこを通ったかは左右で読める**ので、高さは揃っていてよい。
 */
const FOOTPRINT_Y = -2.6;

/* --- 残るもの（花・卵）---------------------------------------------------- */

/** 引っ込んだあと残る割合。**毎回残すと「置き物」になって気づかれない** */
export const LEFTOVER_CHANCE = 0.5;
/** 出てくるまで（にょきっと伸びる） */
const LEFTOVER_GROW_SEC = 0.6;
/** 隠れ場所より奥、ふたの下。**上に置くと動物にかぶる** */
const LEFTOVER_Z = -0.25;
const LEFTOVER_DROP = 1.0;

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

/**
 * みんなで鳴くときの1声。`pitch` は声の高さの倍率。
 * **場所ごとに変える。** 同じ高さで4回鳴くと、1匹が4回鳴いたように聞こえる
 */
export type FlavorCallEvent = (spot: SpotRuntime, pitch: number) => void;

/** あぶく1つぶん */
interface BubbleRuntime {
  mesh: THREE.Mesh;
  /** 0〜1。1 で画面の上に抜ける */
  t: number;
  speed: number;
  x: number;
  /** 横に漂う幅 */
  drift: number;
  /** 割れてから次に出るまでの残り秒。0 なら上がっている */
  wait: number;
  /** 当たり判定に使うワールド座標。**毎フレーム作り直さない**（§10-3） */
  world: THREE.Vector3;
}

/** 足あと1つぶん */
interface FootprintRuntime {
  mesh: THREE.Mesh;
  /** 残り秒 */
  life: number;
}

/** 残るもの（花・卵）1つぶん */
interface LeftoverRuntime {
  group: THREE.Object3D;
  /** 生えてからの秒 */
  t: number;
}

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
  /** この回でとまる隠れ場所。null なら素通り */
  private landAt: SpotRuntime | null = null;
  /** とまっているあいだの残り秒 */
  private perchLeft = 0;
  private landings = 0;

  /** あぶく（うみ）。使い回す。**毎フレーム new をしない** */
  private bubbles: BubbleRuntime[] = [];
  private popped = 0;

  /** みんなで鳴く（のうじょう）。次の呼び込みまでの秒 */
  private chorusWait = CHORUS_EVERY_SEC * 0.6;
  /** 走っている呼び込みの経過秒。null なら鳴いていない */
  private chorusT: number | null = null;
  private chorusRuns = 0;
  private readonly callFns: FlavorCallEvent[] = [];
  /** 鳴らし待ちの声。`[時刻, 場所, 高さ]` を昇順で持つ */
  private readonly callAt: { at: number; spot: SpotRuntime; pitch: number }[] = [];

  /** 足あと（のはら）。古いものから消す */
  private footprints: FootprintRuntime[] = [];

  /** 残るもの（花・卵）。隠れ場所ごとに1つまで */
  private readonly leftovers = new Map<string, LeftoverRuntime>();
  private leftoverCount = 0;
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
    if (this.flavor.bubbles) this.bubbles = this.buildBubbles();
    for (const b of this.bubbles) this.group.add(b.mesh);
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
    this.updateBubbles(dt);
    this.updateChorus(dt);
    this.updateFootprints(dt);
    this.updateLeftovers(dt);
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

      // 引っ込みきったら、その場所に花／卵が残る（§6 の〈中〉）
      if (prev === 'hiding' && s.state === 'hidden' && this.flavor.leftover) {
        if (this.rng() < LEFTOVER_CHANCE) this.addLeftover(s, this.flavor.leftover);
      }
      // 隠れているあいだだけ残す。**押したら消える**（次のばあの邪魔をしない）
      if (prev === 'hidden' && s.state !== 'hidden') this.removeLeftover(s);
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

  /* --- あぶく（うみ）------------------------------------------------------ */

  /**
   * あぶくを作る。**手続き生成だけ**（不変条件7）。
   *
   * 透ける板1枚。`transparent` は重なると順番が怪しくなるが、
   * 隠れ場所より奥に固めてあるので、混ざる相手が同じあぶくしかない。
   */
  private buildBubbles(): BubbleRuntime[] {
    const out: BubbleRuntime[] = [];
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const r = 0.06 + this.rng() * 0.1;
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(r, 12),
        new THREE.MeshBasicMaterial({
          color: 0xdff2ff,
          transparent: true,
          opacity: 0.34,
          depthWrite: false,
          toneMapped: false,
        })
      );
      // **作った時点で奥に置いておく。** 原点のままだと、最初の更新までの
      // 1フレームだけ「飾りが隠れ場所より手前」になる
      mesh.position.set(0, BUBBLE_BOTTOM_Y, BUBBLE_Z);
      out.push({
        mesh,
        // 最初からばらけて並べる。**そろって上がると噴水に見える**
        t: this.rng(),
        speed: 0.7 + this.rng() * 0.6,
        x: (this.rng() * 2 - 1) * 2.5,
        drift: 0.1 + this.rng() * 0.25,
        wait: 0,
        world: new THREE.Vector3(),
      });
    }
    return out;
  }

  private updateBubbles(dt: number): void {
    for (const b of this.bubbles) {
      if (b.wait > 0) {
        b.wait -= dt;
        if (b.wait > 0) continue;
        this.resetBubble(b);
      }
      b.t += (dt / BUBBLE_RISE_SEC) * b.speed;
      if (b.t >= 1) this.resetBubble(b);

      const y = BUBBLE_BOTTOM_Y + (BUBBLE_TOP_Y - BUBBLE_BOTTOM_Y) * b.t;
      const x = b.x + Math.sin(b.t * Math.PI * 3 + b.x) * b.drift * this.depth;
      b.mesh.position.set(x, y, BUBBLE_Z);
      b.world.set(x, y, BUBBLE_Z);
      b.mesh.visible = true;
    }
  }

  private resetBubble(b: BubbleRuntime): void {
    b.t = 0;
    b.x = (this.rng() * 2 - 1) * 2.5;
    b.speed = 0.7 + this.rng() * 0.6;
  }

  /**
   * 押されたところにあぶくがあれば割る。割ったら true。
   *
   * **判定は 3D のレイではなく画面座標で**（§7-3。隠れ場所と同じ考え方）。
   * 隠れ場所の判定（およそ 100px）より小さくしてあるので、
   * **あぶくのせいで隠れ場所が押せなくなることはない**（App は先に隠れ場所を見る）。
   */
  tap(screenX: number, screenY: number, tester: SpotHitTester): boolean {
    let best: BubbleRuntime | null = null;
    let bestDist = BUBBLE_POP_PX;
    for (const b of this.bubbles) {
      if (b.wait > 0) continue;
      const d = tester.distancePx(b.world, screenX, screenY);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    if (!best) return false;
    best.wait = BUBBLE_RESPAWN_SEC;
    best.mesh.visible = false;
    this.popped++;
    return true;
  }

  /* --- みんなで鳴く（のうじょう）------------------------------------------ */

  /** 1声ぶんのイベント。`App` が音に繋ぐ */
  onCall(fn: FlavorCallEvent): void {
    this.callFns.push(fn);
  }

  /**
   * ときどき、隠れ場所が順に鳴く（みんなで鳴く）。
   *
   * ==========================================================================
   * **ふたは開けない。揺らすだけ。** ここも実測で決めた（2026-09-07）。
   * はじめは `extraOpen` を 0.3 まで開ける版で作ったが、
   * 開けられる量は隠れ場所によって桁が違った（15×15 の格子で測った、
   * 体が見えはじめない上限）:
   *
   *   おうち  はこ 1.00 / カーテン **0.05** / ふとん 0.85 / とびら 0.45
   *   のうじょう  こや 0.40 / **わら 0.10** / さく 1.00 / おけ 1.00
   *   どうぶつえん  たかき **0.05**  ／ うみ  かいそう 0.10
   *
   * のうじょうの わら に合わせると 0.05 しか開かず、画面では動いて見えない。
   * §4-6 の「こっちだよ」と同じ**揺れ**（`callShake`）なら、ふたを開けずに
   * 「ここに居るよ」を返せる。**開ける演出は空の隠れ場所にだけ許される**
   * （§4-6 と §4-5 の到着はどちらも中身が居ない場所）。
   * ==========================================================================
   *
   * **全部が隠れているときだけ。** 誰かが出ている最中に割り込むと、
   * 「押したから出た」のか「勝手に動いた」のかが分からなくなる（§4-1）。
   */
  private updateChorus(dt: number): void {
    if (!this.flavor.chorus) return;

    if (this.chorusT === null) {
      this.chorusWait -= dt;
      if (this.chorusWait > 0) return;
      // 1つでも動いていたら見送る。**待ち時間は積み直さない**（次のフレームでまた見る）
      for (const s of this.spots) if (s.state !== 'hidden' || s.extraOpen > 0) return;
      this.chorusT = 0;
      this.chorusRuns++;
      this.chorusWait = CHORUS_EVERY_SEC;
      for (let i = 0; i < this.spots.length; i++) {
        // 声は場所ごとに高さを変える。同じ高さだと1匹が4回鳴いたように聞こえる
        const pitch = 0.92 + (i / Math.max(1, this.spots.length - 1)) * 0.16;
        this.callAt.push({ at: i * CHORUS_STEP_SEC, spot: this.spots[i], pitch });
      }
    }

    const t = (this.chorusT += dt);
    while (this.callAt.length > 0 && this.callAt[0].at <= t) {
      const next = this.callAt.shift();
      if (!next) continue;
      // 押されて出ている場所は飛ばす（§4-1 が動かしている最中）
      if (next.spot.state !== 'hidden') continue;
      next.spot.callShake = 1;
      for (const fn of this.callFns) fn(next.spot, next.pitch);
    }

    if (t > (this.spots.length - 1) * CHORUS_STEP_SEC + CHORUS_OPEN_SEC) {
      this.chorusT = null;
      this.callAt.length = 0;
    }
  }

  /* --- 足あと（のはら）---------------------------------------------------- */

  /**
   * 足あとを1つ落とす。`SceneRoot` が `ChaseSystem.onHop` から呼ぶ。
   *
   * **どこを通ったかが目で追える**ようにするためのもの。
   * 跳ねた先ではなく、**跳ねた場所**に置く
   */
  dropFootprint(x: number): void {
    if (!this.flavor.footprints) return;
    // **暗い色にしない。** 0x2a2a1c で撮ったら、草むらと同じ暗さで
    // 1つも見えなかった（実測 2026-09-07。数は 4 と出ているのに画面に無い）。
    // 踏んで土が出た跡として、明るい砂色にする
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.11, 8),
      new THREE.MeshBasicMaterial({
        color: 0xc8b088,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        toneMapped: false,
      })
    );
    mesh.position.set(x, FOOTPRINT_Y, FOOTPRINT_Z);
    mesh.scale.set(1.4, 0.7, 1);
    this.group.add(mesh);
    this.footprints.push({ mesh, life: FOOTPRINT_FADE_SEC });
    // 増え続けないように、古いものから捨てる（不変条件8）
    while (this.footprints.length > FOOTPRINT_MAX) {
      const old = this.footprints.shift();
      if (old) disposeObject3D(old.mesh);
    }
  }

  private updateFootprints(dt: number): void {
    for (let i = this.footprints.length - 1; i >= 0; i--) {
      const f = this.footprints[i];
      f.life -= dt;
      const mat = f.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, (f.life / FOOTPRINT_FADE_SEC) * 0.55);
      if (f.life <= 0) {
        disposeObject3D(f.mesh);
        this.footprints.splice(i, 1);
      }
    }
  }

  /* --- 残るもの（花・卵）-------------------------------------------------- */

  private addLeftover(spot: SpotRuntime, kind: LeftoverKind): void {
    if (this.leftovers.has(spot.config.id)) return;
    const group = kind === 'flower' ? this.buildFlower() : this.buildEgg();
    // **ふたの下、少しずらして置く。** 真ん中に置くと、次に出てくる動物に重なる
    group.position.set(
      spot.worldPosition.x + (this.rng() < 0.5 ? -0.62 : 0.62),
      spot.worldPosition.y - LEFTOVER_DROP,
      LEFTOVER_Z
    );
    group.scale.setScalar(0.001);
    this.group.add(group);
    this.leftovers.set(spot.config.id, { group, t: 0 });
    this.leftoverCount++;
  }

  private removeLeftover(spot: SpotRuntime): void {
    const left = this.leftovers.get(spot.config.id);
    if (!left) return;
    this.leftovers.delete(spot.config.id);
    disposeObject3D(left.group);
  }

  private updateLeftovers(dt: number): void {
    for (const left of this.leftovers.values()) {
      left.t += dt;
      // にょきっと伸びる。1.0 を少し越えてから戻る（§4-4 と同じ弾み）
      const u = Math.min(1, left.t / LEFTOVER_GROW_SEC);
      const pop = 1 + Math.sin(u * Math.PI) * 0.18 * this.depth;
      left.group.scale.setScalar(Math.max(0.001, u * pop));
      left.group.rotation.z = Math.sin(this.clock * 0.8 + left.group.position.x) * 0.06 * this.depth;
    }
  }

  /** 花。花びら5枚＋まんなか。三角形は 12枚 */
  private buildFlower(): THREE.Object3D {
    const group = new THREE.Group();
    const hue = 0.92 + this.rng() * 0.12;
    const petalMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hue % 1, 0.62, 0.62),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    for (let i = 0; i < 5; i++) {
      const petal = new THREE.Mesh(new THREE.CircleGeometry(0.11, 8), petalMat.clone());
      const a = (i / 5) * Math.PI * 2;
      petal.position.set(Math.cos(a) * 0.12, 0.38 + Math.sin(a) * 0.12, 0);
      group.add(petal);
    }
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(0.06, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd45e, toneMapped: false })
    );
    core.position.set(0, 0.38, 0.01);
    group.add(core);
    const stem = new THREE.Mesh(
      new THREE.PlaneGeometry(0.045, 0.38),
      new THREE.MeshBasicMaterial({ color: 0x2f5d2a, side: THREE.DoubleSide, toneMapped: false })
    );
    stem.position.set(0, 0.19, -0.01);
    group.add(stem);
    petalMat.dispose();
    return group;
  }

  /** 卵。丸を縦に伸ばしただけ。**割れる演出は入れていない**（押すと消える） */
  private buildEgg(): THREE.Object3D {
    const group = new THREE.Group();
    const egg = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 14),
      new THREE.MeshBasicMaterial({ color: 0xf3e6c8, toneMapped: false })
    );
    egg.scale.set(0.82, 1.15, 1);
    egg.position.y = 0.23;
    group.add(egg);
    // まだら。無地だと石に見えた
    for (let i = 0; i < 3; i++) {
      const spot = new THREE.Mesh(
        new THREE.CircleGeometry(0.03, 6),
        new THREE.MeshBasicMaterial({ color: 0xc9a97a, toneMapped: false })
      );
      const a = this.rng() * Math.PI * 2;
      spot.position.set(Math.cos(a) * 0.09, 0.23 + Math.sin(a) * 0.12, 0.01);
      group.add(spot);
    }
    return group;
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
      // 出発。高さと向き、とまる場所を引き直す
      this.crossT = 0;
      this.crossFromLeft = !this.crossFromLeft;
      this.crossY = 0.1 + this.rng() * 1.8;
      this.crossings++;
      this.landAt = null;
      this.perchLeft = 0;
      if (this.flavor.crossingLands && this.spots.length > 0 && this.rng() < LAND_CHANCE) {
        this.landAt = this.spots[Math.floor(this.rng() * this.spots.length) % this.spots.length];
      }
      obj.visible = true;
    }

    // とまっている最中。**時間を進めない**（ここで止まっている）
    if (this.perchLeft > 0 && this.landAt) {
      this.perchLeft -= dt;
      if (this.perchLeft > 0) {
        obj.position.set(
          this.landAt.worldPosition.x,
          this.landAt.worldPosition.y + PERCH_LIFT + Math.sin(this.clock * 2.2) * 0.04 * this.depth,
          CROSS_Z
        );
        this.flapWings();
        return;
      }
      // **とまり終わったら行き先を消す。**
      // 残したままにすると「もう通り過ぎている」判定が毎フレーム真になり、
      // 1回の横断で何十回もとまり直した（実測: 1回の横断で 28回）
      this.landAt = null;
    }

    this.crossT += dt;
    const u = this.crossT / CROSS_SEC;
    if (u >= 1) {
      obj.visible = false;
      this.crossWait = CROSS_GAP_SEC;
      this.landAt = null;
      return;
    }

    const from = this.crossFromLeft ? -CROSS_X : CROSS_X;
    const x = from + (this.crossFromLeft ? 2 : -2) * CROSS_X * u;
    obj.position.set(
      x,
      this.crossY + Math.sin(u * Math.PI * 4) * 0.35 * this.depth,
      CROSS_Z
    );

    // とまる場所を通り過ぎる瞬間に、そこへ降りる。
    // **降りたら、その場所を揺らして「ここだよ」と教える**（§4-2 のヒントと同じ揺れ）
    if (this.landAt && this.perchLeft <= 0) {
      const passed = this.crossFromLeft ? x >= this.landAt.worldPosition.x : x <= this.landAt.worldPosition.x;
      if (passed) {
        this.perchLeft = PERCH_SEC;
        this.landings++;
        this.landAt.callShake = 1;
      }
    }

    // 進む向きを向く。**裏返さない**（板1枚なので裏を向くと消える）
    obj.scale.x = this.crossFromLeft ? 1 : -1;

    this.flapWings();
  }

  /** ちょうちょの羽ばたき。魚は尾を振る（どちらも `crossWings` に入れてある） */
  private flapWings(): void {
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

  /** とまった回数（§6 の〈中〉） */
  getLandingCount(): number {
    return this.landings;
  }

  /** いま、とまっている隠れ場所の id。とまっていなければ null */
  getPerchedSpotId(): string | null {
    return this.perchLeft > 0 && this.landAt ? this.landAt.config.id : null;
  }

  /** あぶくの数と、割った回数 */
  getBubbles(): { count: number; popped: number } {
    return { count: this.bubbles.length, popped: this.popped };
  }

  /** みんなで鳴いた回数と、いま鳴いている最中かどうか */
  getChorus(): { runs: number; running: boolean } {
    return { runs: this.chorusRuns, running: this.chorusT !== null };
  }

  /** 画面に残っている足あとの数 */
  getFootprintCount(): number {
    return this.footprints.length;
  }

  /** いま残っている花／卵の数と、これまでに出した数 */
  getLeftovers(): { alive: number; total: number } {
    return { alive: this.leftovers.size, total: this.leftoverCount };
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
    for (const b of this.bubbles) disposeObject3D(b.mesh);
    this.bubbles = [];
    for (const f of this.footprints) disposeObject3D(f.mesh);
    this.footprints = [];
    for (const l of this.leftovers.values()) disposeObject3D(l.group);
    this.leftovers.clear();
    this.callAt.length = 0;
    this.callFns.length = 0;
    this.crossWings = [];
    if (this.crossing) {
      disposeObject3D(this.crossing);
      this.crossing = null;
    }
    disposeObject3D(this.group);
    this.footstepFns.length = 0;
  }
}
