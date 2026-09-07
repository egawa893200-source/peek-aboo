/**
 * 隠れ場所の状態遷移と当たり判定（設計書 §4-1 / §4-3 / §7-3）
 *
 * ==========================================================================
 * **このファイルが不変条件1・2 の要。** 読まずに直さないこと。
 *
 * 「みずのなか」の貝は、開閉の途中でタップされると向きを反転していた。
 * そのため 60Hz で連打すると 0.45秒の開閉が一度も完了せず、
 * **開き量の最大が 0.037**（1回押しなら 1.0）だった。
 * 実機で「触っても反応しない」と報告された。
 *
 * ここでは同じ失敗が**構造的に起きないように**してある。
 *
 *   進み具合 `reveal`（0..1）を状態変数そのものにして、
 *   タップは**状態を変えるだけで `reveal` には触らない**。
 *   `appearing` の間 `reveal` は毎フレーム必ず増える。
 *
 * つまり「タップが来たから最初からやり直す」経路が存在しない。
 * 連打しても `reveal` は単調に増えて必ず 1.0 に届く。
 * `hiding` からの呼び戻しも、`reveal` の値をそのまま引き継いで
 * 上向きに転じるだけなので、途中で 0 に落ちることがない。
 *
 * **時間 `t` から `reveal = f(t)` を引く実装にしないこと。**
 * その形だと「タップで t をどうするか」を必ず決めることになり、
 * t=0 に戻せば貝と同じ不具合、戻さなければ `hiding` から呼び戻せない。
 * ==========================================================================
 */

import * as THREE from 'three';

import type { SceneMode, SpotConfig, SpotState } from '../types';
import { createSpotShape, type SpotShape } from './SpotShapes';

/* --- タイミング（§4-3。実測で決めた値なので、動かすときは設計書も直すこと） --- */

/** ため。押してから動物が動きはじめるまで（§4-3 の 0.15s） */
export const APPEAR_DELAY_SEC = 0.15;
/** 出はじめてから出きるまで（§4-3 の 0.15s → 0.50s） */
export const APPEAR_DUR_SEC = 0.35;
/**
 * 出たまま待つ時間（§4-3。みずのなかの `OUT_IDLE_SEC` 実績値）。
 * 短いと見る前に消える。長いと「隠れている」に戻らず次が押せない。
 */
export const OUT_IDLE_SEC = 1.6;
/** 引っ込みにかける時間（§4-3 の 2.1s → 2.6s） */
export const HIDE_DUR_SEC = 0.5;
/**
 * モードB（`chase`）で出たまま待つ時間（§4-5 の「モードBの idle は 1.2秒」）。
 *
 * モードAより短い。**出ている時間より移動を見せる時間のほうが大事**だから。
 * §4-5 の表では 0.50s に出きって 1.70s に idle が終わるので、ちょうど 1.2秒。
 */
export const CHASE_OUT_IDLE_SEC = 1.2;

/** 登場の山（不変条件4「登場は 0.35秒以内に始まる」の判定に使う） */
export const PEAK_AT_SEC = APPEAR_DELAY_SEC + APPEAR_DUR_SEC;

/** オーバーシュートが 1.0 に戻るまで（§4-4 の 1.15倍 → 1.0） */
const POP_SETTLE_SEC = 0.22;
/** 「ぷるっ」の減衰時間（§4-3 の 0.05s から始まる震え） */
const SHAKE_DECAY_SEC = 0.3;

/* --- 揺れ。**明滅ではなく動き**にしてあるのは不変条件6 のため --------------- */

/** ヒントの揺れ（§4-2 の 0.6Hz） */
const HINT_HZ = 0.6;
const HINT_AMP_RAD = 0.035;
/** 「ぷるっ」。速いが振幅が小さいので、光ではなく動きとして読める */
const SHAKE_HZ = 9;
const SHAKE_AMP_RAD = 0.085;

/* --- 「こっちだよ」の揺れ（§4-6）------------------------------------------
 *
 * 空振りのあとに正解の場所を教える揺れ。**押した実感の「ぷるっ」とは別枠**。
 *
 * 最初は「ぷるっ」と同じ 0.3秒で消していたが、
 * 空振りの演出（ふたが開く → 誰もいない → 正解が揺れる）を見ている途中に
 * 終わってしまい、**どこが揺れたのか分からない**と言われた。
 * 1.6秒かけて、少しゆっくり（5Hz）、振幅も大きめに揺らす。
 *
 * 光ではなく動きなので、不変条件6（明滅は1秒に3回まで）には掛からない。
 * ---------------------------------------------------------------------- */
export const CALL_DECAY_SEC = 1.6;
const CALL_HZ = 5;
const CALL_AMP_RAD = 0.105;

/**
 * 当たり判定どうしのすき間（CSS px）。
 * 0 にすると円が接した1点で両方に当たるので、必ず正の値を残す。
 */
const HIT_GUARD_PX = 1;

/** ふたが「開きはじめた」とみなす開き具合。音を鳴らすきっかけに使う */
const OPEN_EVENT_AT = 0.08;

/**
 * 画面座標での近接判定に必要なものだけ（§7-3）。
 *
 * `ScreenProjector` がそのまま当てはまる。
 * **インタフェースにしてあるのはテストのため。**
 * `ScreenProjector` は `HTMLElement` を要求するので、node の単体テストから
 * 実物を作れない。型を書き写すのではなく、こちら側を狭くしてある。
 */
export interface SpotHitTester {
  project(world: THREE.Vector3, out: { x: number; y: number }): boolean;
  distancePx(world: THREE.Vector3, screenX: number, screenY: number): number;
}

export interface SpotRuntime {
  readonly config: SpotConfig;
  readonly shape: SpotShape;
  readonly group: THREE.Group;
  /** 当たり判定に使うワールド座標。毎フレーム作り直さない（§10-3） */
  readonly worldPosition: THREE.Vector3;
  state: SpotState;
  /** 出ている量 0..1。**この値が状態機械の本体**（冒頭のコメントを読むこと） */
  reveal: number;
  /** §4-4 のオーバーシュート 0..1 */
  pulse: number;
  /** ため の残り秒 */
  delay: number;
  /** `out` でいる残り秒 */
  idle: number;
  /** 「ぷるっ」の残量 0..1。押した実感（§4-3 の 0.00s） */
  shake: number;
  /**
   * 「こっちだよ」の残量 0..1（§4-6）。
   * **`shake` とは別に持つ。** 押した実感は短く、正解を教える揺れは長い。
   * 1つにまとめると、どちらかの長さを諦めることになる。
   */
  callShake: number;
  /** この隠れ場所が受けたタップの総数 */
  taps: number;
  /**
   * 揺れ用の時計（秒）。場所ごとに違う値から始めて、4つが同時に揺れないようにする。
   * `Loop` の `elapsed` を使わないのは、場面を作り直したときに位相が飛ばないようにするため。
   */
  clock: number;
  /** いま出ている動物。§6-2（Phase 7）で毎回変える */
  animalIndex: number;
  /**
   * 中に動物が居るか。
   *
   * モードB（§4-5）では4箇所のうち1箇所だけが `true` になる。
   * **`false` でも当たり判定は外さない**（不変条件3b）。中身が居ないからと
   * 判定を外すと、モードBでいちばん多い操作が無反応になる。
   * 押されたときは状態を変えず、`onEmpty` を投げて §4-6 の演出に回す。
   */
  occupied: boolean;
  /**
   * `reveal` とは別に、外から開ける量 0..1。
   *
   * §4-6（空の場所のふたが開く）と、§4-5 の到着〜もぐるで使う。
   * **`setOpen` を呼ぶのは `SpotSystem` だけ**にしてある。
   * 2箇所から呼ぶと、片方が毎フレーム上書きして「開かない」が起きる。
   */
  extraOpen: number;
  /** 前フレームのふたの開き具合。開きはじめを1回だけ拾うために持つ */
  openPrev: number;
}

export type SpotEvent = (spot: SpotRuntime) => void;

const _pt = { x: 0, y: 0 };

export class SpotSystem {
  readonly runtimes: SpotRuntime[] = [];
  readonly group = new THREE.Group();

  /** 投影結果の置き場。タップのたびに使い回す（§10-3） */
  private readonly sx: Float64Array;
  private readonly sy: Float64Array;
  private readonly onScreen: Uint8Array;

  private readonly voiceFns: SpotEvent[] = [];
  private readonly peakFns: SpotEvent[] = [];
  private readonly emptyFns: SpotEvent[] = [];
  private readonly tapFns: SpotEvent[] = [];
  private readonly openFns: SpotEvent[] = [];
  private readonly hiddenFns: SpotEvent[] = [];

  /** 応答を返したタップの総数。**タップ総数と必ず一致すること**（不変条件1） */
  private responses = 0;

  /**
   * @param mode 場面の遊び方（§4-5）。`chase` では `out` のあと
   *   `hiding` ではなく `moving` に入り、そこから先は `ChaseSystem` が動かす。
   */
  constructor(
    spots: readonly SpotConfig[],
    readonly mode: SceneMode = 'hideout'
  ) {
    spots.forEach((config, i) => {
      const shape = createSpotShape(config.kind);
      const group = new THREE.Group();
      group.position.fromArray(config.position);
      group.scale.setScalar(config.scale);
      group.add(shape.group);
      this.group.add(group);

      const runtime: SpotRuntime = {
        config,
        shape,
        group,
        worldPosition: new THREE.Vector3().fromArray(config.position),
        state: 'hidden',
        reveal: 0,
        pulse: 0,
        delay: 0,
        idle: 0,
        shake: 0,
        callShake: 0,
        taps: 0,
        // 黄金比でずらす。等間隔にすると4つが周期的に揃って見える
        clock: (i * 0.618) % 1 * 10,
        animalIndex: 0,
        // モードBでは誰が入居しているかを `SceneRoot` が実行時に決める
        occupied: config.animals.length > 0,
        extraOpen: 0,
        openPrev: 0,
      };
      this.runtimes.push(runtime);
      shape.setOpen(0);
    });

    const n = this.runtimes.length;
    this.sx = new Float64Array(n);
    this.sy = new Float64Array(n);
    this.onScreen = new Uint8Array(n);
  }

  /** 「ばあ！」を返すタイミング。押した瞬間か、登場の山か */
  onVoice(fn: SpotEvent): void {
    this.voiceFns.push(fn);
  }

  /** 登場の山（§4-4 の粒子ときらめき） */
  onPeak(fn: SpotEvent): void {
    this.peakFns.push(fn);
  }

  /**
   * **空の隠れ場所が押された**（不変条件3b / §4-6）。
   * `EmptySpot` がここに繋がって「ふたが開く → 誰もいない → 正解を揺らす」を走らせる。
   */
  onEmpty(fn: SpotEvent): void {
    this.emptyFns.push(fn);
  }

  /**
   * 隠れ場所が押された。中身の有無によらず**毎回**呼ばれる。
   * `ChaseSystem` が移動中の反応（不変条件4b）に使う。
   */
  onTapped(fn: SpotEvent): void {
    this.tapFns.push(fn);
  }

  /**
   * ふたが**開きはじめた**（1回だけ）。
   * 中身が居るかどうかによらず鳴らす音（くさむらのワサワサなど）に使う。
   * 開いている間ずっとではなく、閾値を上向きに跨いだ瞬間だけ。
   */
  onOpen(fn: SpotEvent): void {
    this.openFns.push(fn);
  }

  /**
   * 隠れ終わった（`hiding` → `hidden`）。
   *
   * §6-2「同じ隠れ場所から別の動物が出る」を、ここで差し替える。
   * **出ている最中や引っ込む途中に入れ替えないこと。** 目の前で動物が
   * すり替わる。隠れ終わってからなら、次に開けたときに気づく
   */
  onHidden(fn: SpotEvent): void {
    this.hiddenFns.push(fn);
  }

  find(id: string): SpotRuntime | null {
    return this.runtimes.find((r) => r.config.id === id) ?? null;
  }

  getResponseCount(): number {
    return this.responses;
  }

  /* --- 状態遷移（§4-1） -------------------------------------------------- */

  /**
   * タップを受ける。**どの状態でも必ず `true` を返す**（不変条件2）。
   *
   * | 状態 | すること |
   * |---|---|
   * | `hidden` | `appearing` へ。声は 0.35秒後の山で返す（§4-3） |
   * | `appearing` | **状態も `reveal` も触らない。** 声だけ返す |
   * | `out` | `idle` を積み直す（長く出ていてくれる） |
   * | `hiding` | `appearing` へ戻す。`reveal` は引き継ぐので途中から上がる |
   *
   * `appearing` で何も変えないのが肝。ここで `reveal` や `delay` を
   * 触ると、連打したときに登場が完走しなくなる（冒頭のコメント）。
   */
  tap(spot: SpotRuntime): boolean {
    spot.taps++;
    this.responses++;
    // どの状態でも「ぷるっ」は返す。**アピールを止めない**（不変条件2）
    spot.shake = 1;
    this.emit(this.tapFns, spot);

    // **空の隠れ場所（§4-6 / 不変条件3b）。**
    // 状態は変えない。中身が居ないのに `appearing` に入れると、
    // ふたが開いて何も出てこないまま `out` に居座り、次が押せなくなる。
    // 演出は `EmptySpot` が `onEmpty` を受けて走らせる。
    // **ここで早期 return しても「無反応」ではない**ことに注意:
    // 波紋・効果音（App）と「ぷるっ」（上の行）は既に返している。
    if (!spot.occupied) {
      this.emit(this.emptyFns, spot);
      return true;
    }

    switch (spot.state) {
      case 'hidden':
        spot.state = 'appearing';
        spot.delay = APPEAR_DELAY_SEC;
        // 声は山で。ここで鳴らすと「ばあ」ではなくただのボタンになる（§4-3）
        break;
      case 'hiding':
        // 呼び戻し。**ため を挟まない。** もう半分出ているので、
        // ここで 0.15秒待たせると「もう一回！」への反応が鈍く感じる
        spot.state = 'appearing';
        spot.delay = 0;
        this.emit(this.voiceFns, spot);
        break;
      case 'appearing':
        // **状態を変えない。** 声とアピールだけ返す（不変条件2）
        this.emit(this.voiceFns, spot);
        break;
      case 'out':
        spot.idle = this.outIdleSec();
        this.emit(this.voiceFns, spot);
        break;
      default:
        // 'moving' は Phase 3（§4-5）。まだ来ないが、来ても無反応にはしない
        this.emit(this.voiceFns, spot);
        break;
    }
    return true;
  }

  update(dt: number): void {
    for (const s of this.runtimes) {
      this.step(s, dt);
      this.apply(s, dt);
    }
  }

  private step(s: SpotRuntime, dt: number): void {
    switch (s.state) {
      case 'appearing': {
        if (s.delay > 0) {
          s.delay = Math.max(0, s.delay - dt);
          break;
        }
        s.reveal += dt / APPEAR_DUR_SEC;
        if (s.reveal >= 1) {
          s.reveal = 1;
          s.state = 'out';
          s.idle = this.outIdleSec();
          // 山。ここで「ばあ！」と粒子（§4-3 の 0.35s）
          this.emit(this.peakFns, s);
          this.emit(this.voiceFns, s);
        }
        break;
      }
      case 'out': {
        s.idle -= dt;
        if (s.idle <= 0) {
          // モードBは引っ込まずに移動へ（§4-5）。
          // ここから先は `ChaseSystem` が動かす。**この先で `reveal` を
          // 触らないこと**（`moving` の間 SpotSystem は何もしない）
          s.state = this.mode === 'chase' ? 'moving' : 'hiding';
        }
        break;
      }
      case 'hiding': {
        s.reveal -= dt / HIDE_DUR_SEC;
        if (s.reveal <= 0) {
          s.reveal = 0;
          s.state = 'hidden';
          this.emit(this.hiddenFns, s);
        }
        break;
      }
      default:
        break;
    }

    // オーバーシュート。**`appearing` の間は下げない。**
    // 下げる経路を作ると、連打で pulse が振動して「ぶるぶる」に見える
    if (s.state === 'appearing') {
      s.pulse = Math.max(s.pulse, smoothstep(0.55, 1, s.reveal));
    } else {
      s.pulse = Math.max(0, s.pulse - dt / POP_SETTLE_SEC);
    }

    s.shake = Math.max(0, s.shake - dt / SHAKE_DECAY_SEC);
    s.callShake = Math.max(0, s.callShake - dt / CALL_DECAY_SEC);
  }

  /** 出たまま待つ秒数。モードBは短い（§4-5） */
  private outIdleSec(): number {
    return this.mode === 'chase' ? CHASE_OUT_IDLE_SEC : OUT_IDLE_SEC;
  }

  private apply(s: SpotRuntime, dt: number): void {
    // ふたは動物より先に開ききる。動物がふたを押しのけて出るように見えると
    // 「引っかかっている」ように読める。
    // `extraOpen`（§4-6 の空振り、§4-5 の到着）とは**大きいほうを採る**。
    // 足し算にすると 1 を超えて、ふたが裏返るところまで回る
    const open = Math.max(Math.min(1, s.reveal * 1.35), s.extraOpen);
    // 開きはじめを1回だけ拾う。毎フレーム鳴らすと「シャー」と鳴りっぱなしになる
    if (open > OPEN_EVENT_AT && s.openPrev <= OPEN_EVENT_AT) this.emit(this.openFns, s);
    s.openPrev = open;
    s.shape.setOpen(open);

    s.clock += dt;
    const t = s.clock;

    // 隠れているあいだだけ、ゆっくり揺らして「中に居る」ことを伝える（§4-2）
    const hint = s.state === 'hidden' ? Math.sin(t * HINT_HZ * Math.PI * 2) * HINT_AMP_RAD : 0;
    const shake = Math.sin(t * SHAKE_HZ * Math.PI * 2) * SHAKE_AMP_RAD * s.shake;
    // 「こっちだよ」（§4-6）。ゆっくり長く揺れる
    const call = Math.sin(t * CALL_HZ * Math.PI * 2) * CALL_AMP_RAD * s.callShake;
    s.shape.setWobble(hint + shake + call);
  }

  /* --- 当たり判定（§7-3） ------------------------------------------------ */

  /**
   * 押された場所にいちばん近い隠れ場所。無ければ null。
   *
   * **3D のレイではなく画面座標で判定する。** レイだと隠れ場所の裏や
   * 真横から当たりが出ず「押したのに反応しない」が起きる（みずのなかの岩）。
   */
  pick(screenX: number, screenY: number, tester: SpotHitTester): SpotRuntime | null {
    this.projectAll(tester);

    let best: SpotRuntime | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < this.runtimes.length; i++) {
      if (!this.onScreen[i]) continue;
      const s = this.runtimes[i];
      const d = tester.distancePx(s.worldPosition, screenX, screenY);
      if (d > this.radiusAt(i)) continue;
      // 円が重ならないようにしてあるので、ここで2つ当たることは無い。
      // それでも近いほうを採るのは、丸め誤差で境界に乗ったときの保険
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  /**
   * 外したときに、いちばん近い隠れ場所を揺らす（不変条件1
   * 「それ以外でも波紋・音・**近くの動物の反応**が出る」）。
   *
   * 状態は変えない。押した場所と関係ないところが開いたら、
   * 「押したところが反応した」という因果が壊れる。
   */
  nudgeNearest(screenX: number, screenY: number, tester: SpotHitTester): SpotRuntime | null {
    let best: SpotRuntime | null = null;
    let bestDist = Infinity;
    for (const s of this.runtimes) {
      const d = tester.distancePx(s.worldPosition, screenX, screenY);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    if (best) best.shake = Math.max(best.shake, 0.55);
    return best;
  }

  /**
   * 実際に使う当たり半径（CSS px）。
   *
   * ==========================================================================
   * **`SpotConfig.hitRadiusPx` は上限で、そのままは使えない。**
   *
   * 設計書 §7-3 の既定 120px は、2×2 に並べた時点でどの画面でも重なる。
   * 実測（カメラ z=7.2、`data/scenes.ts` の座標。Pixel 7 の行は E2E の実測と一致）:
   *
   *   Pixel 7   412×839  いちばん近い組 204.8px → 120+120 で **35.2px 食い込む**
   *   iPhone 12 390×750  　　　　　　　 183.0px → **57.0px 食い込む**
   *   360×600            　　　　　　　 146.4px → **93.6px 食い込む**
   *   844×390（横持ち）  　　　　　　　 118.7px → **121.3px 食い込む**
   *
   * ワールド座標を固定したまま画面の大きさだけ変わるので、**どんな定数を
   * 選んでも全端末では成立しない**。ここで隣との距離を見て縮める。
   *
   * 下限は設けていない。下限を作ると、それが効いた瞬間に円が重なって
   * 「押したのに隣が反応する」が復活する（みずのなかで貝と岩が画面上 21px しか
   * 離れておらず、岩が先に取っていたのと同じ形）。
   * 縮んで押しにくくなっても、外したタップは波紋・音・近くの揺れを返すので
   * 無反応にはならない（不変条件1）。
   * ==========================================================================
   */
  radiusAt(index: number): number {
    const s = this.runtimes[index];
    if (!this.onScreen[index]) return 0;

    let nearest = Infinity;
    for (let j = 0; j < this.runtimes.length; j++) {
      if (j === index || !this.onScreen[j]) continue;
      const d = Math.hypot(this.sx[index] - this.sx[j], this.sy[index] - this.sy[j]);
      if (d < nearest) nearest = d;
    }
    if (!Number.isFinite(nearest)) return s.config.hitRadiusPx;
    return Math.max(0, Math.min(s.config.hitRadiusPx, nearest / 2 - HIT_GUARD_PX));
  }

  /** 全部の隠れ場所を画面に投影する。結果は `sx` / `sy` / `onScreen` に入る */
  projectAll(tester: SpotHitTester): void {
    for (let i = 0; i < this.runtimes.length; i++) {
      const ok = tester.project(this.runtimes[i].worldPosition, _pt);
      this.onScreen[i] = ok ? 1 : 0;
      this.sx[i] = ok ? _pt.x : NaN;
      this.sy[i] = ok ? _pt.y : NaN;
    }
  }

  /** E2E から実測するためのスナップショット。当たり判定の距離をここから測る */
  snapshot(tester: SpotHitTester): SpotSnapshot[] {
    this.projectAll(tester);
    return this.runtimes.map((s, i) => ({
      id: s.config.id,
      kind: s.config.kind,
      state: s.state,
      reveal: s.reveal,
      taps: s.taps,
      occupied: s.occupied,
      openAmount: Math.max(Math.min(1, s.reveal * 1.35), s.extraOpen),
      shake: s.shake,
      callShake: s.callShake,
      screenX: this.sx[i],
      screenY: this.sy[i],
      configuredRadiusPx: s.config.hitRadiusPx,
      radiusPx: this.radiusAt(i),
    }));
  }

  dispose(): void {
    for (const s of this.runtimes) s.shape.dispose();
    this.runtimes.length = 0;
    this.voiceFns.length = 0;
    this.peakFns.length = 0;
    this.emptyFns.length = 0;
    this.tapFns.length = 0;
    this.openFns.length = 0;
    this.hiddenFns.length = 0;
    this.group.removeFromParent();
  }

  private emit(fns: readonly SpotEvent[], spot: SpotRuntime): void {
    for (const fn of fns) fn(spot);
  }
}

export interface SpotSnapshot {
  id: string;
  kind: string;
  state: SpotState;
  reveal: number;
  taps: number;
  occupied: boolean;
  /** ふたの開き具合 0..1。§4-6 の空振りは `reveal` が 0 のまま、ここだけ動く */
  openAmount: number;
  shake: number;
  /** §4-6「こっちだよ」の揺れの残量。押した実感の `shake` とは別枠 */
  callShake: number;
  screenX: number;
  screenY: number;
  configuredRadiusPx: number;
  radiusPx: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
