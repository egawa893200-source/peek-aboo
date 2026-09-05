/**
 * タップ入力（§3-3 / 不変条件5）
 *
 * 操作はタップのみ。スワイプ／ピンチ／ダブルタップ／長押しには何も割り当てない。
 * 例外はペアレンタルゲートの2秒長押し（画面右上 24×24px）だけ。
 */

/*
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/core/Input.ts`（141行）。
 * 実機で検証済みなので書き直していない。
 * --------------------------------------------------------------------------
 */

import * as THREE from 'three';

/**
 * タップ座標を投影する平面の深さ。波紋（§4-3 の「押した実感」）を出す位置。
 *
 * みずのなかは -3.0 から -1.0 へ手前に寄せた。カメラは z = 7.2 にいるので、
 * -3.0 だと 10.2m 先になり、反応が画面の奥で起きて分かりにくかった。
 *
 * **隠れ場所の当たり判定にはこの平面を使わない。** そちらは
 * `ScreenProjector.distancePx()`（画面座標の距離）で判定する（§7-3）。
 * 3D のレイだと、隠れ場所の裏や真横から当たりが出ず
 * 「押したのに反応しない」が起きる（不変条件1 でいちばん避けたいこと）。
 */
export const TAP_PLANE_Z = -1.0;

export interface TapEvent {
  /** CSS ピクセル座標（L3 の波紋に使う） */
  screenX: number;
  screenY: number;
  /** 水中のワールド座標（深さ TAP_PLANE_Z の平面に投影したもの） */
  world: THREE.Vector3;
  /**
   * カメラからタップ方向へのレイ（§7-2 魚を直接タップした判定に使う）。
   * ハンドラの実行中だけ有効な使い回しインスタンスなので、保持しないこと。
   */
  ray: THREE.Ray;
}

export type TapHandler = (tap: TapEvent) => void;

export class Input {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane: THREE.Plane;
  private readonly handlers: TapHandler[] = [];
  /** 受理したタップの総数（動作確認用） */
  private tapCount = 0;

  constructor(
    private readonly target: HTMLElement,
    private readonly camera: THREE.Camera
  ) {
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -TAP_PLANE_Z);

    // pointerdown だけを見る。押した瞬間に反応する方が幼児には分かりやすい（§4-3）。
    this.target.addEventListener('pointerdown', this.onPointerDown, { passive: true });

    // 不変条件5: ブラウザの既定ジェスチャを全て殺す
    this.target.addEventListener('contextmenu', this.prevent);
    this.target.addEventListener('dragstart', this.prevent);
    this.target.addEventListener('gesturestart', this.prevent as EventListener);
    this.target.addEventListener('gesturechange', this.prevent as EventListener);
    this.target.addEventListener('gestureend', this.prevent as EventListener);
    this.target.addEventListener('touchmove', this.preventIfMultiTouch, { passive: false });
    document.addEventListener('dblclick', this.prevent);
  }

  onTap(fn: TapHandler): void {
    this.handlers.push(fn);
  }

  /**
   * テストから使うタップ注入。
   * 実際の pointerdown と同じハンドラを通すので、経路が分岐しない。
   */
  simulateTap(clientX: number, clientY: number): void {
    this.tapCount++;
    const world = this.screenToWorld(clientX, clientY);
    const tap: TapEvent = {
      screenX: clientX,
      screenY: clientY,
      world,
      ray: this.raycaster.ray,
    };
    for (const fn of this.handlers) fn(tap);
  }

  /** 受理したタップの総数 */
  getTapCount(): number {
    return this.tapCount;
  }

  /** 画面座標 → 深さ TAP_PLANE_Z のワールド座標 */
  screenToWorld(clientX: number, clientY: number, out = new THREE.Vector3()): THREE.Vector3 {
    const rect = this.target.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.plane, out)) {
      // カメラが平面と平行な異常系。中央にフォールバック（無反応を作らない 不変条件1）
      out.set(0, 0, TAP_PLANE_Z);
    }
    return out;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    // 不変条件1「押したのに無反応」を作らないため、間引きは一切しない。
    // 連打への耐性は入力側ではなく、波紋・粒子のプール側で担保する。
    //
    // **みずのなかで実際にやった失敗**: 貝の開閉中のタップを
    // 「アニメーション中だから」と無視したところ、60Hz で連打すると
    // 開き量の最大が 0.037（1回押しなら 1.0）にしかならず、
    // 実機で「触っても反応しない」と報告された。不変条件2 はそのための条文。
    this.tapCount++;
    const world = this.screenToWorld(e.clientX, e.clientY);
    // screenToWorld が raycaster を更新済みなので、そのレイをそのまま渡す
    const tap: TapEvent = {
      screenX: e.clientX,
      screenY: e.clientY,
      world,
      ray: this.raycaster.ray,
    };
    for (const fn of this.handlers) fn(tap);
  };

  private readonly prevent = (e: Event): void => {
    e.preventDefault();
  };

  private readonly preventIfMultiTouch = (e: TouchEvent): void => {
    // 1本指のスクロールも含め、キャンバス上のスクロールは全て無効にする
    e.preventDefault();
  };

  dispose(): void {
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('contextmenu', this.prevent);
    this.target.removeEventListener('dragstart', this.prevent);
    this.target.removeEventListener('gesturestart', this.prevent as EventListener);
    this.target.removeEventListener('gesturechange', this.prevent as EventListener);
    this.target.removeEventListener('gestureend', this.prevent as EventListener);
    this.target.removeEventListener('touchmove', this.preventIfMultiTouch);
    document.removeEventListener('dblclick', this.prevent);
    this.handlers.length = 0;
  }
}
