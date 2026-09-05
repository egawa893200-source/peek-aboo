/**
 * 空の隠れ場所を押したときの反応（設計書 §4-6 / 不変条件3b）
 *
 * ==========================================================================
 * モードB（§4-5）では4箇所のうち3箇所が空になる。
 * **ここが無反応だと、このアプリでいちばん多い操作が「何も起きない」になる。**
 * 4回に3回は空振りするのだから、空振りのほうを丁寧に作る。
 *
 * §4-6 のタイミング表:
 *
 *   0.00s  ふたが開く（正解と同じ動き）        ← 押した実感
 *   0.20s  誰もいない ＋「あれ？」の声 ＋ ぽふっと煙
 *   0.50s  正解の隠れ場所が「ぷるっ」と揺れる  ← こっちだよ
 *   0.80s  ふたが閉じる
 *
 * 守っていること:
 *  - **外れを「失敗」にしない。** 音は落胆ではなく、とぼけた「あれ？」。
 *    ブザー・×印・暗転は使わない
 *  - **必ず正解を教える。** 1歳半に「探させる」のは早い。
 *    当てるのが目的ではなく、**移動を目で追うのが目的**
 *  - ヒントの揺れは §4-2 と同じ。**明滅ではない**（不変条件6）
 *  - **連打しても、上のシーケンスが毎回最後まで走る。**
 *    途中のタップで向きを変えない（不変条件2。みずのなかの貝と同じ扱い）
 * ==========================================================================
 */

import type { SpotRuntime, SpotSystem } from './SpotSystem';

/* --- §4-6 のタイミング表。**動かすときは設計書も直すこと** ----------------- */

/** ふたが開ききるまで */
export const EMPTY_OPEN_SEC = 0.2;
/** 「あれ？」の声と煙（§4-6 の 0.20s） */
export const EMPTY_VOICE_AT_SEC = 0.2;
/** 正解を揺らす（§4-6 の 0.50s） */
export const EMPTY_HINT_AT_SEC = 0.5;
/** ふたが閉じはじめる（§4-6 の 0.80s） */
export const EMPTY_CLOSE_AT_SEC = 0.8;
/** 閉じきるまで。表には無いが、瞬間的に閉じると「消えた」に見えるので 0.3秒かける */
export const EMPTY_CLOSE_SEC = 0.3;
/** ひと通り */
export const EMPTY_TOTAL_SEC = EMPTY_CLOSE_AT_SEC + EMPTY_CLOSE_SEC;

/**
 * 正解を知らせる揺れの強さ。
 * **押した実感の「ぷるっ」とは別枠**（`SpotRuntime.callShake`）。
 * あちらは 0.3秒で消えるが、こちらは 1.6秒かけて揺れる。
 * 短いと、空振りの演出を見ている途中に終わってしまい、
 * どこが揺れたのか分からない。
 */
const CALL_STRENGTH = 1;

interface Run {
  readonly spot: SpotRuntime;
  /** 押した時点の正解。走っている途中で行き先が変わっても、この場所を揺らす */
  readonly answer: SpotRuntime | null;
  t: number;
  voiced: boolean;
  hinted: boolean;
}

export type EmptyEvent = (spot: SpotRuntime, answer: SpotRuntime | null) => void;

export class EmptySpot {
  private readonly runs = new Map<string, Run>();
  private readonly voiceFns: EmptyEvent[] = [];
  private readonly puffFns: EmptyEvent[] = [];

  /** 走らせたシーケンスの数。**押した回数と混ぜないこと**（連打では増えない） */
  private started = 0;
  /** 最後まで走りきった数。`started` と一致すること */
  private finished = 0;
  /** 空の場所を押された回数。1回残らず反応を返している（不変条件3b） */
  private taps = 0;

  constructor(private readonly spots: SpotSystem) {}

  /** とぼけた「あれ？」（§4-6。**落胆の音にしないこと**） */
  onVoice(fn: EmptyEvent): void {
    this.voiceFns.push(fn);
  }

  /** ぽふっと煙 */
  onPuff(fn: EmptyEvent): void {
    this.puffFns.push(fn);
  }

  /**
   * 空の隠れ場所が押された。**必ず `true` を返す**（不変条件3b）。
   *
   * すでに走っている最中でも `true`。ただし**シーケンスは巻き戻さない**。
   * みずのなかの貝は、開閉中のタップで向きを反転していたせいで
   * 60Hz の連打で開き量の最大が 0.037 にしかならなかった。
   * ここで `t = 0` に戻すと、同じことが §4-6 で起きる
   * （連打すると「ふたが開きかけては戻る」を繰り返して、
   *  誰もいないことも正解の場所も、一度も見せられない）。
   *
   * @param answer いま正解の隠れ場所。null なら揺れは出さない
   */
  trigger(spot: SpotRuntime, answer: SpotRuntime | null): boolean {
    this.taps++;
    const running = this.runs.get(spot.config.id);
    if (running) {
      // **巻き戻さない。** 反応は「ぷるっ」（SpotSystem が返している）と、
      // ここでもう一度返す声だけにする
      this.emit(this.voiceFns, running.spot, running.answer);
      return true;
    }
    this.runs.set(spot.config.id, { spot, answer, t: 0, voiced: false, hinted: false });
    this.started++;
    return true;
  }

  update(dt: number): void {
    for (const run of this.runs.values()) {
      run.t += dt;

      // ふた。開いて、しばらく開けたまま、閉じる
      run.spot.extraOpen = openAmount(run.t);

      if (!run.voiced && run.t >= EMPTY_VOICE_AT_SEC) {
        run.voiced = true;
        this.emit(this.voiceFns, run.spot, run.answer);
        this.emit(this.puffFns, run.spot, run.answer);
      }

      if (!run.hinted && run.t >= EMPTY_HINT_AT_SEC) {
        run.hinted = true;
        // **必ず正解を教える**（§4-6）。押した場所そのものが正解だったときは、
        // すでに「ぷるっ」が返っているので二重に揺らさない
        if (run.answer && run.answer !== run.spot) {
          run.answer.callShake = Math.max(run.answer.callShake, CALL_STRENGTH);
        }
      }

      if (run.t >= EMPTY_TOTAL_SEC) {
        run.spot.extraOpen = 0;
        this.runs.delete(run.spot.config.id);
        this.finished++;
      }
    }
  }

  isRunning(spotId: string): boolean {
    return this.runs.has(spotId);
  }

  getStartedCount(): number {
    return this.started;
  }

  getFinishedCount(): number {
    return this.finished;
  }

  getTapCount(): number {
    return this.taps;
  }

  dispose(): void {
    for (const run of this.runs.values()) run.spot.extraOpen = 0;
    this.runs.clear();
    this.voiceFns.length = 0;
    this.puffFns.length = 0;
    void this.spots;
  }

  private emit(fns: readonly EmptyEvent[], spot: SpotRuntime, answer: SpotRuntime | null): void {
    for (const fn of fns) fn(spot, answer);
  }
}

/** §4-6 のふたの開き具合 */
function openAmount(t: number): number {
  if (t < EMPTY_OPEN_SEC) return t / EMPTY_OPEN_SEC;
  if (t < EMPTY_CLOSE_AT_SEC) return 1;
  return Math.max(0, 1 - (t - EMPTY_CLOSE_AT_SEC) / EMPTY_CLOSE_SEC);
}
