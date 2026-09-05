/**
 * タップ地点の波紋（§4-3 の 0.00s「押した実感」）
 *
 * 「直径 0 → 220px に 0.5秒で拡大しながらフェード」
 *
 * **不変条件1 を担保する最後の砦。** 隠れ場所から外れた場所でも、
 * 空の隠れ場所でも、動物が出ている最中でも、押されたら必ず出す。
 * ここが出ていれば「押したのに何も起きない」にはならない。
 *
 * 連打されても DOM が増え続けないよう、要素はプールして使い回す。
 * prefers-reduced-motion 指定時は控えめにする（不変条件6）。
 */

/*
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/feeding/Ripple.ts`（99行）。
 * 実機で検証済みなので書き直していない。
 * このアプリでは餌が無いので `ui/` に移した。中身は同じ。
 * --------------------------------------------------------------------------
 */

const POOL_SIZE = 12;
const DURATION_MS = 500;
/** CSS 側の .ripple の幅と揃える */
const MAX_DIAMETER_PX = 220;

export class Ripple {
  private readonly pool: HTMLDivElement[] = [];
  private next = 0;
  private readonly reduced: boolean;
  /** §4-3 の画面全体に広がる波紋。使うときに作る */
  private fullscreen: HTMLDivElement | null = null;

  constructor(private readonly container: HTMLElement) {
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'ripple';
      el.style.opacity = '0';
      this.container.appendChild(el);
      this.pool.push(el);
    }
  }

  /** 画面座標（CSS px）に波紋を出す */
  spawn(screenX: number, screenY: number): void {
    const el = this.pool[this.next];
    this.next = (this.next + 1) % POOL_SIZE;

    el.style.left = `${screenX}px`;
    el.style.top = `${screenY}px`;

    // 進行中のアニメーションがあれば捨てて撃ち直す（連打で詰まらせない）
    el.getAnimations?.().forEach((a) => a.cancel());

    const scaleTo = this.reduced ? 0.55 : 1;
    const opacity = this.reduced ? 0.45 : 0.85;

    el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.02)', opacity: opacity },
        { transform: `translate(-50%, -50%) scale(${scaleTo * 0.55})`, opacity: opacity * 0.7, offset: 0.45 },
        { transform: `translate(-50%, -50%) scale(${scaleTo})`, opacity: 0 },
      ],
      { duration: this.reduced ? 700 : DURATION_MS, easing: 'cubic-bezier(0.15, 0.7, 0.3, 1)' }
    );
  }

  /**
   * 画面全体に広がる波紋（§4-3 水槽切替のトランジション）。
   * 餌やりの波紋とは別の専用要素を使う（プールを食い潰さないため）。
   */
  spawnFullscreen(durationMs = 600): void {
    if (!this.fullscreen) {
      this.fullscreen = document.createElement('div');
      this.fullscreen.className = 'ripple ripple--fullscreen';
      this.fullscreen.style.opacity = '0';
      this.container.appendChild(this.fullscreen);
    }
    const el = this.fullscreen;
    el.getAnimations?.().forEach((a) => a.cancel());
    el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.05)', opacity: this.reduced ? 0.3 : 0.7 },
        { transform: 'translate(-50%, -50%) scale(1.1)', opacity: 0.45, offset: 0.55 },
        { transform: 'translate(-50%, -50%) scale(2.1)', opacity: 0 },
      ],
      { duration: this.reduced ? durationMs * 1.4 : durationMs, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }
    );
  }

  /** CSS の px 直径（テストや調整用） */
  static get diameter(): number {
    return MAX_DIAMETER_PX;
  }

  dispose(): void {
    for (const el of this.pool) {
      el.getAnimations?.().forEach((a) => a.cancel());
      el.remove();
    }
    this.pool.length = 0;
    this.fullscreen?.getAnimations?.().forEach((a) => a.cancel());
    this.fullscreen?.remove();
    this.fullscreen = null;
  }
}
