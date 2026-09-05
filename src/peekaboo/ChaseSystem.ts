/**
 * 移動モード「おいかけっこ」（設計書 §4-5）
 *
 * ==========================================================================
 * うさぎ1匹が、ばあ！のあと次の隠れ場所へ跳んでいく。
 * **このアプリでいちばん効くのが「移動を見せる」こと**（§1）なので、
 * ここを雑にすると全部が台無しになる。
 *
 * §4-5 のタイミング表（タップを 0.00s とする）:
 *
 *   0.00s  タップ
 *   0.35s  「ばあ！」（§4-3 の山）
 *   0.50s  出きって、こちらを向く
 *   1.70s  idle 終わり。**次の行き先の方を向く**       ← 予告 0.40s
 *   2.10s  ぴょんぴょん開始。4回の弧を描くジャンプ      ← 1.50s
 *   3.60s  到着。こちらを一度見る                       ← 0.30s「見つけてね」
 *   3.90s  もぐる（くさむらが閉じる）                   ← 0.90s
 *   4.80s  hidden。次のタップを待つ
 *
 * 1周 4.80秒。**これ以上長いと、1歳半は待てずに他所を押す。**
 *
 * ここが守っていること:
 *  - **必ず行き先の方を先に向く（0.40秒）。** 予告なしに動き出すと
 *    「消えた」に見えて目で追えない
 *  - **ジャンプは弧を描く。** 直線の平行移動は「滑って移動した」に見えて、
 *    1歳半の目には追いづらい。上下動があると視線が乗る
 *  - **到着してから隠れるまでに 0.30秒の間を置く。** ここでこちらを見る
 *  - **移動中の速度は一定。** 加減速をつけると追いづらいので、
 *    水平方向は線形に進める（イージングを掛けない）
 *
 * **タップは移動に一切触らない**（不変条件4b）。
 * `phaseT` を進めるのは `update(dt)` だけで、`tap()` からは書けない。
 * `SpotSystem` の `reveal` と同じ考え方で、「連打で移動が止まる」経路を
 * 構造として作っていない。
 * ==========================================================================
 */

import * as THREE from 'three';

import type { AnimalSystem } from './AnimalSystem';
import type { SpotRuntime, SpotSystem } from './SpotSystem';

/* --- §4-5 のタイミング表。**動かすときは設計書も直すこと** ----------------- */

/** 行き先を向く予告（§4-5 の 1.70s → 2.10s） */
export const AIM_SEC = 0.4;
/** 跳んでいる時間（§4-5 の 2.10s → 3.60s） */
export const HOP_SEC = 1.5;
/** 到着してこちらを見る間（§4-5 の 3.60s → 3.90s「見つけてね」） */
export const LOOK_SEC = 0.3;
/** もぐって隠れ終わるまで（§4-5 の 3.90s → 4.80s） */
export const BURROW_SEC = 0.9;

/**
 * 弧の回数（§4-5「3〜4回の弧を描くジャンプ」）。
 *
 * **4 に固定してある。** 表の到着時刻 3.60s は 4回 ×0.375秒 でちょうど合う。
 * 3回にすると、同じ 1.50秒で同じ距離を跳ぶので1跳ねが長くなり、
 * §4-5 の「約 0.35s/1跳ね」からも「速度は一定」からも外れる。
 * 回数を変えるなら `HOP_SEC` も一緒に変えること。
 */
export const HOP_COUNT = 4;

/** `moving` に入ってから隠れ終わるまで（§4-5 の 1.70s → 4.80s） */
export const CHASE_MOVE_SEC = AIM_SEC + HOP_SEC + LOOK_SEC + BURROW_SEC;

/**
 * 弧の高さ（ワールド）。
 *
 * 隠れ場所どうしは 2.30〜3.59 離れているので、0.60 だと
 * いちばん短い横移動でも「距離の 1/4 ぶん持ち上がる」ことになり、
 * 弧としてはっきり読める。0.30 まで下げると、横移動では
 * ほぼ直線に見えて「滑って移動した」になった。
 */
const ARC_HEIGHT = 0.6;

/**
 * 隣接とみなす距離の上限（いちばん近い組の何倍まで）。
 *
 * 2×2 では 横 2.30 / 縦 2.75 / 斜め 3.59 なので、1.35倍（＝3.11）で
 * 「横と縦は隣、斜めは遠い」に分かれる。画面上の距離で見ても順番は同じ
 * （Pixel 7 実測で 208 / 247 / 322px）。
 */
const NEAR_RATIO = 1.35;

/**
 * 近いほうを選ぶ確率（§4-5「隣接を 0.6、遠い方を 0.4」）。
 *
 * **群として 60% / 40%。** 候補ごとに 0.6 / 0.4 の重みを付けると、
 * 隣が2つ・斜めが1つなので 0.3 / 0.3 / 0.4 になり、
 * いちばん確率が高いのが斜めになってしまう。
 * それでは「近い方を優先するのは、移動距離が長いと画面を横断して
 * 見失うため」という理由（§4-5）と逆になる。
 */
const NEAR_CHANCE = 0.6;

/** タップに驚いて振り向く時間（不変条件4b） */
const STARTLE_SEC = 0.35;

export type ChasePhase = 'idle' | 'aim' | 'hop' | 'look' | 'burrow';

/* 毎フレーム走るので、使い捨てのベクトルはここに置く（§10-3） */
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _pos = new THREE.Vector3();

/**
 * 乱数。
 *
 * **`Math.random()` を使わないこと。** three は `generateUUID()` で
 * 1オブジェクトにつき `Math.random()` を4回消費する。みずのなかでは
 * モデルを1つ足しただけで乱数列がずれ、**触っていない水槽の測定値**が
 * 0.980 → 0.173 に動いた（CLAUDE.md）。
 * 遊びの乱数は共有のシードではなく、独立したシードから引く。
 * ここを独立させてあるおかげで、行き先の抽選を単体テストで再現できる。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChaseOptions {
  /** 乱数の種。テストから固定する。省略時は起動ごとに変わる */
  seed?: number;
  /** 最初にうさぎが住む隠れ場所。省略時は先頭 */
  startSpotId?: string;
}

export class ChaseSystem {
  phase: ChasePhase = 'idle';
  /** いまの段階に入ってからの経過秒 */
  private phaseT = 0;

  /** うさぎが居る（または向かっている）隠れ場所 */
  private current: SpotRuntime;
  /** 移動先。`aim` に入った時点で決まる */
  private destination: SpotRuntime | null = null;
  /** ひとつ前に居た場所。行ったり来たりを避けるのに使う（§4-5） */
  private previous: SpotRuntime | null = null;

  private readonly rng: () => number;
  /** 驚いて振り向いている残り秒（不変条件4b） */
  private startle = 0;

  /** 行き先の履歴。E2E とテストが「即戻りが 0 回」を数える */
  private readonly history: string[] = [];
  /** 完走した移動の回数 */
  private laps = 0;
  /** 移動中に受けたタップの数（不変条件4b の確認用） */
  private tapsWhileMoving = 0;

  constructor(
    private readonly spots: SpotSystem,
    private readonly animals: AnimalSystem,
    options: ChaseOptions = {}
  ) {
    this.rng = mulberry32(options.seed ?? ((Date.now() ^ 0x9e3779b9) >>> 0));
    const start =
      (options.startSpotId ? spots.find(options.startSpotId) : null) ?? spots.runtimes[0];
    this.current = start;
    this.history.push(start.config.id);

    // うさぎが住むのは1箇所だけ。残りは空（§4-5）。
    // **空でも当たり判定は外さない**（不変条件3b）。SpotSystem がそう作ってある
    for (const s of spots.runtimes) s.occupied = s === start;

    // タップは移動に触れない。振り向くだけ（不変条件4b）
    spots.onTapped(() => this.onTapped());
  }

  /** うさぎが居る、または向かっている隠れ場所。§4-6 のヒントはここを揺らす */
  getAnswerSpot(): SpotRuntime {
    return this.destination ?? this.current;
  }

  getPhase(): ChasePhase {
    return this.phase;
  }

  getHistory(): readonly string[] {
    return this.history;
  }

  getLaps(): number {
    return this.laps;
  }

  getTapsWhileMoving(): number {
    return this.tapsWhileMoving;
  }

  /** いま移動中か（`aim` を含む。予告も「移動のうち」） */
  isMoving(): boolean {
    return this.phase !== 'idle';
  }

  /**
   * 移動中のタップ（不変条件4b）。
   *
   * **`phaseT` にも `destination` にも触らない。**
   * ここで移動を止めたり、行き先を選び直したりする経路を作らないこと。
   * 止めると「どこへ行ったか」が分からなくなり、モードBが成立しない。
   * 返すのは驚きの反応（振り向き）だけ。
   */
  private onTapped(): void {
    if (!this.isMoving()) return;
    this.tapsWhileMoving++;
    this.startle = STARTLE_SEC;
  }

  update(dt: number): void {
    this.startle = Math.max(0, this.startle - dt);

    // `SpotSystem` が `out` の idle を使い切ると `moving` にしてくる（§4-5）。
    // そこが移動の始まり
    if (this.phase === 'idle') {
      if (this.current.state !== 'moving') return;
      this.beginAim();
    }

    this.phaseT += dt;
    switch (this.phase) {
      case 'aim':
        this.stepAim();
        break;
      case 'hop':
        this.stepHop();
        break;
      case 'look':
        this.stepLook();
        break;
      case 'burrow':
        this.stepBurrow();
        break;
      default:
        break;
    }
  }

  /* --- 予告（§4-5「必ず行き先の方を先に向く」） -------------------------- */

  private beginAim(): void {
    this.phase = 'aim';
    this.phaseT = 0;
    this.destination = this.pickDestination();

    const slot = this.animals.getSlot(this.current.config.id);
    if (slot) {
      // 行き先を見る。**予告なしに動き出すと「消えた」に見えて目で追えない**
      slot.gazeTarget = this.destination.worldPosition.clone();
      slot.driven = true;
    }
  }

  private stepAim(): void {
    const slot = this.animals.getSlot(this.current.config.id);
    if (slot) {
      // 体も行き先のほうへ捻る。顔だけ動かすと「見ているだけ」に見える
      const dx = this.destination!.worldPosition.x - this.current.worldPosition.x;
      const turn = Math.sign(dx) * 0.7 * Math.min(1, this.phaseT / AIM_SEC);
      slot.built.group.rotation.y = turn;
      // 予告のあいだは出きった高さのまま
      slot.built.group.position.y = slot.outY;
    }
    if (this.phaseT >= AIM_SEC) this.beginHop();
  }

  /* --- 跳ぶ（§4-5「弧を描く」「速度は一定」） ---------------------------- */

  private beginHop(): void {
    this.phase = 'hop';
    this.phaseT = 0;

    const from = this.current;
    const slot = this.animals.getSlot(from.config.id);

    // ふたは閉じる。うさぎはもう居ない
    from.occupied = false;
    from.state = 'hiding';

    if (slot) {
      // 跳んでいるあいだは隠れ場所の子ではなく、場面の直下に置く。
      // 親のままだと、元の草むらが閉じる動きに引きずられる
      this.spots.group.add(slot.built.group);
      // **付け替えたら、その場でワールド座標を入れ直すこと。**
      // three の `add()` はローカル座標をそのまま持ち越すので、
      // 隠れ場所の子だったときの (0, outY, animalZ) が場面直下の座標として
      // 読み直され、**1フレームだけ画面中央へ瞬間移動する**。
      // 実測: 1フレームの水平移動量が 1.10（等速なら 0.019）まで飛んだ。
      // 目では「一瞬ちらつく」程度にしか見えないが、追っている子どもは見失う。
      // 単体テスト「移動中の水平方向は等速」がこれを捕まえた
      slot.built.group.position.set(
        from.worldPosition.x,
        from.worldPosition.y + slot.outY,
        from.worldPosition.z + from.shape.animalZ
      );
      slot.driven = true;
    }
  }

  private stepHop(): void {
    const from = this.current;
    const dest = this.destination!;
    const slot = this.animals.getSlot(from.config.id);
    const t = Math.min(1, this.phaseT / HOP_SEC);

    if (slot) {
      _from.copy(from.worldPosition);
      _from.y += slot.outY;
      _from.z += from.shape.animalZ;
      _to.copy(dest.worldPosition);
      _to.y += slot.outY;
      _to.z += dest.shape.animalZ;

      // 水平は線形。**イージングを掛けない**（§4-5「加減速をつけると追いづらい」）
      _pos.lerpVectors(_from, _to, t);
      // 上下は弧。1跳ねぶんの位相で持ち上げる
      const hop = (t * HOP_COUNT) % 1;
      _pos.y += Math.sin(hop * Math.PI) * ARC_HEIGHT;
      slot.built.group.position.copy(_pos);

      // 進行方向を向いたまま跳ぶ。驚いたときだけ、こちらを見る（不変条件4b）
      const dx = dest.worldPosition.x - from.worldPosition.x;
      slot.built.group.rotation.y = Math.sign(dx) * 0.7;
      slot.gazeTarget = this.startle > 0 ? null : dest.worldPosition.clone();
    }

    // 行き先のくさむらは、着く前から開けておく。
    // 着いてから開くと「壁にぶつかってから入った」に見える
    dest.extraOpen = Math.min(1, t * 2);

    if (this.phaseT >= HOP_SEC) this.beginLook();
  }

  /* --- 到着（§4-5「こちらを一度見る」） ---------------------------------- */

  private beginLook(): void {
    this.phase = 'look';
    this.phaseT = 0;

    const from = this.current;
    const dest = this.destination!;

    // うさぎを移動先の子に付け替える。**キーと親子の両方**（片方だけだと、
    // 次の移動で元の場所から生えてくる）
    this.animals.reassign(from, dest);
    const slot = this.animals.getSlot(dest.config.id);
    if (slot) {
      slot.built.group.position.set(0, slot.outY, dest.shape.animalZ);
      // こちらを見る。「ここに入ったよ」の合図（§4-5）
      slot.gazeTarget = null;
    }

    this.previous = from;
    this.current = dest;
    this.destination = null;
    this.history.push(dest.config.id);
    dest.occupied = true;
  }

  private stepLook(): void {
    const slot = this.animals.getSlot(this.current.config.id);
    if (slot) {
      // 正面に向き直る。跳んでいた向きのまま潜ると、横を向いて沈む
      slot.built.group.rotation.y *= Math.max(0, 1 - this.phaseT / LOOK_SEC);
      slot.built.group.position.y = slot.outY;
    }
    this.current.extraOpen = 1;
    if (this.phaseT >= LOOK_SEC) {
      this.phase = 'burrow';
      this.phaseT = 0;
    }
  }

  /* --- もぐる ------------------------------------------------------------- */

  private stepBurrow(): void {
    const spot = this.current;
    const t = Math.min(1, this.phaseT / BURROW_SEC);
    const slot = this.animals.getSlot(spot.config.id);
    if (slot) {
      slot.built.group.position.y = slot.outY + (slot.hiddenY - slot.outY) * t;
      slot.built.group.rotation.y = 0;
    }
    // ふたは体より少し遅れて閉じる。同時だと挟まって見える
    spot.extraOpen = 1 - Math.max(0, (t - 0.25) / 0.75);

    if (this.phaseT >= BURROW_SEC) {
      spot.extraOpen = 0;
      spot.state = 'hidden';
      spot.reveal = 0;
      if (slot) {
        slot.driven = false;
        slot.gazeTarget = null;
        slot.built.group.position.y = slot.hiddenY;
      }
      this.phase = 'idle';
      this.phaseT = 0;
      this.laps++;
    }
  }

  /* --- 次の行き先（§4-5「次の行き先の選び方」） -------------------------- */

  /**
   * 行き先を1つ選ぶ。
   *
   *  - **いま居る場所は候補から外す。** 同じ場所に戻ると「動いていない」に見える
   *  - **ひとつ前に居た場所も外す**（2つ以上残るときだけ）。
   *    外さないと A→B→A→B の往復になり、§4-5 の「3回連続で同じ場所は避ける」
   *    を破る。4箇所あるので、外しても候補は必ず2つ残る
   *  - 残りを「隣」と「斜め」に分け、**群として** 60% / 40% で選ぶ
   */
  private pickDestination(): SpotRuntime {
    const all = this.spots.runtimes;
    const others = all.filter((s) => s !== this.current);
    // 候補が減りすぎるくらいなら、往復のほうがまし（無反応は作らない）
    const withoutPrev = others.filter((s) => s !== this.previous);
    const pool = withoutPrev.length >= 2 ? withoutPrev : others;

    let min = Infinity;
    for (const s of pool) {
      const d = s.worldPosition.distanceTo(this.current.worldPosition);
      if (d < min) min = d;
    }
    const near = pool.filter(
      (s) => s.worldPosition.distanceTo(this.current.worldPosition) <= min * NEAR_RATIO
    );
    const far = pool.filter((s) => !near.includes(s));

    const group = near.length && far.length ? (this.rng() < NEAR_CHANCE ? near : far) : pool;
    return group[Math.floor(this.rng() * group.length) % group.length];
  }
}
