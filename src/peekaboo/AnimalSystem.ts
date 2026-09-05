/**
 * 動物の生成・登場アニメ・視線（設計書 §4-3 / §4-4）
 *
 * ==========================================================================
 * 登場は `SpotSystem` の `reveal`（0..1）だけを見て決まる。
 * **ここに独自の時間を持たせないこと。**
 * 2つの時計があると、連打したときに片方だけ巻き戻って
 * 「体は出ているのに顔が下を向いたまま」のような状態が作れてしまう。
 *
 * §4-4「同時に4つ」のうち、ここで作るのは3つ:
 *   1. 大きさ … 1.0 →1.15 にオーバーシュートして 1.0 に戻る
 *   3. 光    … 山で一瞬だけ明るくする（粒子は Phase 2 の RevealEffect）
 *   4. 視線  … 出きったらカメラの方を向く。**顔と目が見えることが最重要**
 * 2（音）は `App` が `SpotSystem.onVoice` を受けて鳴らす。
 * ==========================================================================
 */

import * as THREE from 'three';

import { findAnimal } from '../data/animals';
import type { AnimalConfig } from '../types';
import { createProceduralAnimal, HINT_EXPOSURE, type ProceduralAnimal } from './ProceduralAnimals';
import type { SpotRuntime, SpotSystem } from './SpotSystem';

/** §4-4 の「1.15倍にオーバーシュート」 */
const OVERSHOOT = 0.15;

/**
 * 光る演出の最短間隔（秒）。**不変条件6「1秒に3回を超える明滅を作らない」。**
 *
 * 1/3 秒（0.333）にすると、0.000 / 0.333 / 0.667 / 1.000 で
 * **1秒の窓に4回**入ってしまう。0.4 なら 0 / 0.4 / 0.8 の3回で頭打ちになる。
 * 連打は入力側では一切間引かない（不変条件1）ので、
 * 明滅の制限はこうして出力側だけで掛ける。
 */
export const FLASH_MIN_INTERVAL_SEC = 0.4;

/** 光の減衰。長いと「点いたまま」に見えて、明滅の回数を数えても意味が無くなる */
const GLOW_DECAY_SEC = 0.32;

/** 出きったときに、体をどれだけ縁の上に出すか（1.0 = 全身） */
const OUT_LIFT = 0.9;

/** 視線を向けはじめる `reveal`（§4-3 の「0.50s 出きって、こちらを向く」） */
const GAZE_FROM = 0.72;

/* 毎フレーム走るので、使い捨てのベクトルはここに置く（§10-3） */
const _camPos = new THREE.Vector3();
const _headPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _box = new THREE.Box3();

export interface AnimalSlot {
  readonly spotId: string;
  readonly config: AnimalConfig;
  readonly built: ProceduralAnimal;
  /** 隠れているときの y（隠れ場所のローカル座標）。体は縁の下、ヒントだけ上 */
  readonly hiddenY: number;
  /** 出きったときの y */
  readonly outY: number;
  /** 縁の高さ（隠れ場所のローカル座標） */
  readonly coverTopY: number;
  /** いまの光の強さ 0..1 */
  glow: number;
}

/** 不変条件3 を数値で見るための実測値。すべてワールド座標 */
export interface AnimalExposure {
  /** 縁より上に出ている高さ ÷ 体の高さ。**隠れていても 0 であってはいけない** */
  fraction: number;
  /**
   * ヒントを除いた「体」が縁より上に出ている割合。
   * **隠れている間は 0 であること。** 顔が見えていたら「ばあ！」が驚きにならない。
   */
  bodyFraction: number;
  coverTopY: number;
  animalTopY: number;
  animalHeight: number;
}

export class AnimalSystem {
  private readonly slots = new Map<string, AnimalSlot>();
  /** 光った回数。E2E と単体テストから数える（不変条件6） */
  private flashes = 0;
  /** 前回光った時刻。`Loop` の固定 dt を積むので、テストで正確に再現できる */
  private lastFlashAt = Number.NEGATIVE_INFINITY;
  private clock = 0;
  private readonly glowScale: number;

  /**
   * @param reducedMotion `prefers-reduced-motion` 指定時は光を弱める（不変条件6）。
   *   省略時は環境から読む。node（単体テスト）には `matchMedia` が無いので、
   *   **例外を投げずに false に落とす**。
   */
  constructor(spots: SpotSystem, reducedMotion = detectReducedMotion()) {
    this.glowScale = reducedMotion ? 0.3 : 1;

    for (const spot of spots.runtimes) {
      const id = spot.config.animals[spot.animalIndex];
      // mode 'chase' は空配列（§5-1）。Phase 3 でここに入居者が来る
      if (!id) continue;
      const config = findAnimal(id);
      if (!config) continue;

      const built = createProceduralAnimal(config);
      const scale = config.scale;
      const h = built.height * scale;
      const coverTopY = spot.shape.coverTopY;

      // 隠れている位置。**体のてっぺんが、ちょうど縁と同じ高さ。**
      // ヒントは体のてっぺんに生えているので、そのぶんだけが縁の上に残る。
      const hiddenY = coverTopY - h;
      // 出きった位置。少しだけ縁に埋めておくと「そこから出てきた」に見える
      const outY = coverTopY - h * (1 - OUT_LIFT);

      built.group.position.set(0, hiddenY, spot.shape.animalZ);
      built.group.scale.setScalar(scale);

      // ヒントだけは前板の**手前**へ出す（§4-2）。
      // 体と同じ奥行きに置くと、上段の隠れ場所はカメラより上にあるため
      // 下から見上げる形になり、ふたやレールがヒントを丸ごと隠す。
      // 高さは足りているので**数値のテストでは気づけない**（実際に見落とした）。
      // `hint` は動物のスケールの中にいるので、割り戻してから渡す
      built.hint.position.z = (spot.shape.hintZ - spot.shape.animalZ) / scale;

      spot.group.add(built.group);

      this.slots.set(spot.config.id, {
        spotId: spot.config.id,
        config,
        built,
        hiddenY,
        outY,
        coverTopY,
        glow: 0,
      });
    }
  }

  /**
   * 山で光らせる（§4-4）。
   * **1秒に3回を超えないように、ここで落とす**（不変条件6）。
   * 落としたときも `false` を返すだけで、声とアピールは止めない（不変条件2）。
   */
  requestFlash(spot: SpotRuntime): boolean {
    const slot = this.slots.get(spot.config.id);
    if (!slot) return false;
    if (this.clock - this.lastFlashAt < FLASH_MIN_INTERVAL_SEC) return false;
    this.lastFlashAt = this.clock;
    this.flashes++;
    slot.glow = 1;
    return true;
  }

  getFlashCount(): number {
    return this.flashes;
  }

  update(dt: number, spots: SpotSystem, camera: THREE.Camera): void {
    this.clock += dt;
    camera.getWorldPosition(_camPos);

    for (const spot of spots.runtimes) {
      const slot = this.slots.get(spot.config.id);
      if (!slot) continue;

      const { built } = slot;
      const reveal = spot.reveal;

      // --- 高さ。ease-out で、出はじめを速く、止まりぎわを緩く ---------------
      const lift = easeOutCubic(reveal);
      built.group.position.y = slot.hiddenY + (slot.outY - slot.hiddenY) * lift;

      // --- 大きさ。§4-4 のオーバーシュート -----------------------------------
      built.group.scale.setScalar(slot.config.scale * (1 + OVERSHOOT * spot.pulse));

      // --- ヒント（§4-2） ----------------------------------------------------
      // 出はじめたら引っ込める。頭の上に尻尾が残っていたら、ただの飾りになる
      built.hint.visible = reveal < 0.12;
      // 中でもぞもぞしている感じ。隠れ場所の揺れと同じ量を、逆向きに掛ける
      if (built.hint.visible) built.hint.rotation.z = -spot.shake * 0.35;

      // --- 視線（§4-4 顔と目が見えることが最重要） ---------------------------
      const gaze = smoothstep(GAZE_FROM, 1, reveal);
      if (gaze > 0) {
        built.head.getWorldPosition(_headPos);
        _dir.subVectors(_camPos, _headPos);
        const flat = Math.hypot(_dir.x, _dir.z);
        const yaw = Math.atan2(_dir.x, _dir.z);
        const pitch = Math.atan2(_dir.y, flat);
        // 首は回りきらない。人形が真後ろを向くと不気味に見えるので浅く止める
        built.head.rotation.set(clamp(pitch, -0.45, 0.45) * gaze, clamp(yaw, -0.7, 0.7) * gaze, 0);
      } else {
        built.head.rotation.set(0, 0, 0);
      }

      // --- 光 -----------------------------------------------------------------
      slot.glow = Math.max(0, slot.glow - dt / GLOW_DECAY_SEC);
      built.setGlow(slot.glow * this.glowScale);
    }
  }

  /**
   * 縁からどれだけ出ているかを**実測する**（不変条件3）。
   *
   * 定数をそのまま返さずに、組み上がった Object3D の境界箱から測っている。
   * こうしておくと「ヒントの生成に失敗した」「動物が隠れ場所に対して大きすぎる」
   * のような、目で見て気づきにくい壊れ方を数値で捕まえられる。
   */
  getExposure(spot: SpotRuntime): AnimalExposure | null {
    const slot = this.slots.get(spot.config.id);
    if (!slot) return null;

    const scale = spot.config.scale;
    const coverTopY = spot.worldPosition.y + slot.coverTopY * scale;
    const animalHeight = slot.built.height * slot.config.scale * scale;

    slot.built.group.updateWorldMatrix(true, true);

    _box.setFromObject(slot.built.group);
    const animalTopY = _box.max.y;

    // ヒントを除いた「体」だけの上端。ここが縁より上に出ていたら、
    // 隠れているつもりで顔が見えている
    _box.makeEmpty();
    for (const child of slot.built.group.children) {
      if (child === slot.built.hint) continue;
      _box.expandByObject(child);
    }
    const bodyTopY = _box.isEmpty() ? coverTopY : _box.max.y;

    return {
      fraction: Math.max(0, animalTopY - coverTopY) / animalHeight,
      bodyFraction: Math.max(0, bodyTopY - coverTopY) / animalHeight,
      coverTopY,
      animalTopY,
      animalHeight,
    };
  }

  /** 見分けがつくかの実測（§4-2「動物の断面の 0.86 倍を隠れ場所が覆う」） */
  getFit(spot: SpotRuntime): { mouthWidth: number; animalWidth: number; ratio: number } | null {
    const slot = this.slots.get(spot.config.id);
    if (!slot) return null;
    const animalWidth = slot.built.width * slot.config.scale;
    const mouthWidth = spot.shape.mouthWidth;
    return { mouthWidth, animalWidth, ratio: mouthWidth / animalWidth };
  }

  getSlot(spotId: string): AnimalSlot | null {
    return this.slots.get(spotId) ?? null;
  }

  dispose(): void {
    for (const slot of this.slots.values()) slot.built.dispose();
    this.slots.clear();
  }
}

/** ヒントが縁から出る量の設計値（§4-2 は体長の 15〜25%）。テストが参照する */
export const EXPECTED_HINT_EXPOSURE = HINT_EXPOSURE;

/**
 * `prefers-reduced-motion`。
 * **node（単体テスト）とサーバ描画では `matchMedia` が無い。**
 * 例外を投げずに false へ落とす（§2 エラー画面を出さない）。
 */
function detectReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function easeOutCubic(t: number): number {
  const x = 1 - Math.max(0, Math.min(1, t));
  return 1 - x * x * x;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
