/**
 * ペアレンタルゲート（不変条件5 の唯一の例外）
 *
 * 「保護者用の操作（設定・音量・終了）はペアレンタルロック:
 *   画面右上の小さな領域を 2秒長押し で設定パネルを開く。
 *   幼児の偶発的な長押しを避けるため、開く直前に
 *   『3つ並んだ丸のうち一番右を押す』確認を挟む」
 *
 * 1歳半が偶然通過しないことが唯一の目的なので、
 *  - 起点は右上 24×24px の目立たない領域だけ
 *  - 2秒間、指を離さず・大きく動かさずに押し続ける必要がある
 *  - そのうえで3択を1回当てる必要がある（当てずっぽうで 1/3）
 * としてある。
 */

/*
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/ui/ParentalGate.ts`（164行）。
 * 実機で検証済みなので書き直していない。
 * --------------------------------------------------------------------------
 */

const HOLD_MS = 2000;
/** この距離以上動いたら長押しを中断する（幼児は押しながら指が動く） */
const MOVE_TOLERANCE_PX = 18;

export class ParentalGate {
  private readonly hotspot: HTMLDivElement;
  private readonly progress: HTMLDivElement;
  private confirm: HTMLDivElement | null = null;

  private holdTimer = 0;
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private handlers: Array<() => void> = [];

  constructor(private readonly container: HTMLElement) {
    this.hotspot = document.createElement('div');
    this.hotspot.className = 'gate__hotspot';
    // 読み上げには出すが、見た目はほぼ見えない点だけ
    this.hotspot.setAttribute('role', 'button');
    this.hotspot.setAttribute('aria-label', 'ほごしゃせってい（2びょうながおし）');

    this.progress = document.createElement('div');
    this.progress.className = 'gate__progress';
    this.hotspot.appendChild(this.progress);

    this.hotspot.addEventListener('pointerdown', this.onDown);
    this.hotspot.addEventListener('pointermove', this.onMove);
    this.hotspot.addEventListener('pointerup', this.onUp);
    this.hotspot.addEventListener('pointercancel', this.onUp);

    this.container.appendChild(this.hotspot);
  }

  onUnlock(fn: () => void): void {
    this.handlers.push(fn);
  }

  private readonly onDown = (e: PointerEvent): void => {
    e.stopPropagation(); // 背後の水槽に餌を落とさない
    if (this.pointerId !== null || this.confirm) return;
    this.pointerId = e.pointerId;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.hotspot.setPointerCapture(e.pointerId);
    this.progress.classList.add('is-holding');
    this.holdTimer = window.setTimeout(() => this.showConfirm(), HOLD_MS);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) this.cancelHold();
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.cancelHold();
  };

  private cancelHold(): void {
    if (this.pointerId !== null) {
      try {
        this.hotspot.releasePointerCapture(this.pointerId);
      } catch {
        /* すでに解放済み */
      }
    }
    this.pointerId = null;
    window.clearTimeout(this.holdTimer);
    this.progress.classList.remove('is-holding');
  }

  /** 3つ並んだ丸のうち一番右を押させる（§2） */
  private showConfirm(): void {
    this.cancelHold();
    if (this.confirm) return;

    const overlay = document.createElement('div');
    overlay.className = 'gate__confirm';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'gate__card';

    const label = document.createElement('p');
    label.className = 'gate__label';
    label.textContent = '右はしの まるを おしてください';
    card.appendChild(label);

    const row = document.createElement('div');
    row.className = 'gate__dots';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'gate__dot';
      dot.setAttribute('aria-label', i === 2 ? '右はしのまる' : `${i + 1}ばんめのまる`);
      dot.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (i === 2) {
          this.close();
          for (const fn of this.handlers) fn();
        } else {
          // 間違えたら黙って閉じる（幼児に「もう一回」を促さない）
          this.close();
        }
      });
      row.appendChild(dot);
    }
    card.appendChild(row);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'gate__cancel';
    cancel.textContent = 'とじる';
    cancel.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.close();
    });
    card.appendChild(cancel);

    overlay.appendChild(card);
    // 枠外を押しても閉じる
    overlay.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target === overlay) this.close();
    });

    this.container.appendChild(overlay);
    this.confirm = overlay;

    // 放置されたら勝手に閉じる
    window.setTimeout(() => this.close(), 15000);
  }

  private close(): void {
    this.confirm?.remove();
    this.confirm = null;
  }

  dispose(): void {
    this.cancelHold();
    this.close();
    this.hotspot.remove();
    this.handlers = [];
  }
}
