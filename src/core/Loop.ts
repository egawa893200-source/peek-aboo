/**
 * 固定タイムステップの更新ループ（§7-2）
 *
 * - 登場・移動のアニメーションは固定 dt で更新して、
 *   端末の fps で速さが変わらないようにする。
 *   §4-3 の「0.35秒で山が来る」は、これが無いと端末ごとにずれる。
 * - 描画は rAF ごとに1回。
 * - タブが裏に回ったら止め、戻ったら大きな dt が一気に流れ込まないようにする。
 */

/*
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/core/Loop.ts`（116行）。
 * 実機で検証済みなので書き直していない。
 * --------------------------------------------------------------------------
 */

import type { FrameContext } from '../types';

export type UpdateFn = (ctx: FrameContext) => void;
export type RenderFn = (alpha: number, elapsed: number) => void;

const FIXED_DT = 1 / 60;
/** 1フレームで消化する最大サブステップ数（スパイク時に雪だるま式に増えるのを防ぐ） */
const MAX_SUBSTEPS = 3;

export class Loop {
  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  private elapsed = 0;
  private frame = 0;

  /** 直近フレームの実測 dt（QualityManager が参照する） */
  public rawDelta = FIXED_DT;
  /** 描画した通しフレーム数。E2E で「ループが回っているか」を見るのに使う */
  public frameCount = 0;

  private readonly updateFns: UpdateFn[] = [];
  private renderFn: RenderFn | null = null;

  private readonly onVisibility = () => {
    if (document.hidden) {
      this.pause();
    } else {
      this.resume();
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * 更新が進めた時間（秒）。**壁時計ではない。**
   *
   * このループは 1/60 の固定刻みで、1フレームに最大3ステップしか進めず、
   * 溜まりすぎたぶんは捨てる（「時間の借金」を作らない）。
   * だから **fps が足りない環境では、simulatedSeconds は実時間より遅れる**。
   *
   * §4-3 / §4-5 のタイミング表はこの時計の上で決まっているので、
   * 表どおりかを検査するときは壁時計ではなくこちらを使うこと。
   * CI にも開発コンテナにも GPU が無く、ソフトウェア描画では
   * 実時間で測ると 4.80秒の移動が 5.67秒に見えた（実測）。
   * 実時間で合否を決めると、fps を合否条件にしたのと同じことになる（§10-2）。
   */
  get simulatedSeconds(): number {
    return this.elapsed;
  }

  /** 更新ステップの通し数。`frameCount`（描画回数）とは別物 */
  get stepCount(): number {
    return this.frame;
  }

  onUpdate(fn: UpdateFn): void {
    this.updateFns.push(fn);
  }

  onRender(fn: RenderFn): void {
    this.renderFn = fn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  resume(): void {
    if (this.running) return;
    // 復帰時は溜まった時間を捨てる
    this.accumulator = 0;
    this.start();
  }

  dispose(): void {
    this.pause();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.updateFns.length = 0;
    this.renderFn = null;
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // 0.25s を超える間隔（タブ復帰など）は捨てる
    let delta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (delta > 0.25) delta = 0.25;
    this.rawDelta = delta;

    this.accumulator += delta;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.accumulator -= FIXED_DT;
      this.elapsed += FIXED_DT;
      this.frame++;
      const ctx: FrameContext = {
        dt: FIXED_DT,
        elapsed: this.elapsed,
        frame: this.frame,
      };
      for (let i = 0; i < this.updateFns.length; i++) {
        this.updateFns[i](ctx);
      }
      steps++;
    }
    // 溜まりすぎたぶんは切り捨て（低速端末での「時間の借金」を作らない）
    if (this.accumulator > FIXED_DT * MAX_SUBSTEPS) {
      this.accumulator = 0;
    }

    this.frameCount++;
    this.renderFn?.(this.accumulator / FIXED_DT, this.elapsed);
  };
}
