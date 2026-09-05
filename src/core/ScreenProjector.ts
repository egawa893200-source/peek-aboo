/**
 * ワールド座標 → 画面座標の近接判定
 *
 * 「画面上でこのあたりを押したか」を判定するための道具。
 * **このアプリの当たり判定はすべてこれで行う**（§7-3）。
 *
 * 3D のレイ判定と違い、**画面上の距離**で判定する。
 * 隠れ場所のように大きくて向きのあるものは、レイだと裏側や真横から
 * 当たりが出ず、「押したのに反応しない」が起きる
 * （不変条件1 で最も避けたいこと）。みずのなかの岩で実際に起きた。
 *
 * **空の隠れ場所（§4-6）も同じ判定を持たせること。**
 * 中身が居ないからと判定を外すと、モードBでいちばん多い操作が
 * 無反応になる（不変条件3b）。
 *
 * 毎フレームではなくタップのたびにしか呼ばれないが、
 * 使い回しのベクトルを持って割り当てを避けてある。
 */

/*
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/core/ScreenProjector.ts`（50行）。
 * 実機で検証済みなので書き直していない。
 * --------------------------------------------------------------------------
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();

export class ScreenProjector {
  constructor(
    private readonly target: HTMLElement,
    private readonly camera: THREE.Camera
  ) {}

  /**
   * ワールド座標が画面のどこに来るか（CSS px）。
   * カメラの後ろにある場合は false を返し、out は書き換えない。
   */
  project(world: THREE.Vector3, out: { x: number; y: number }): boolean {
    _v.copy(world).project(this.camera);
    // z が 1 を超えるのはカメラの後ろ（near より手前）
    if (_v.z > 1) return false;
    const rect = this.target.getBoundingClientRect();
    out.x = rect.left + ((_v.x + 1) / 2) * rect.width;
    out.y = rect.top + ((1 - _v.y) / 2) * rect.height;
    return true;
  }

  /**
   * ワールド座標と画面座標の距離（CSS px）。
   * カメラの後ろなら Infinity（＝どんな半径でも当たらない）。
   */
  distancePx(world: THREE.Vector3, screenX: number, screenY: number): number {
    if (!this.project(world, _screen)) return Infinity;
    return Math.hypot(_screen.x - screenX, _screen.y - screenY);
  }
}

const _screen = { x: 0, y: 0 };
