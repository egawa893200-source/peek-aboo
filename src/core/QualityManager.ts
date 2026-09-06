/**
 * アダプティブ品質（§10）
 *
 * 段階（数字が大きいほど低品質）:
 *   0: フル
 *   1: ポスト処理 DoF オフ（このアプリはまだポスト処理を持たないので効かない）
 *   2: パーティクル半減
 *   3: 同時に描く動物の数を 70%
 *   4: 解像度スケール 0.75
 *
 * **fps を合否には使わない**（§11-2）。開発環境には GPU が無く、
 * ソフトウェア描画の fps は実機を反映しない。ここで見ているのは
 * 「その端末で重いなら下げる」という実行時の調整であって、判定ではない。
 */

/*
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/core/QualityManager.ts`（185行）。
 * 実機で検証済みなので書き直していない。
 * --------------------------------------------------------------------------
 */

import type { QualityLevel } from '../types';

export interface QualitySettings {
  dof: boolean;
  particleScale: number;
  creatureScale: number;
  resolutionScale: number;
}

const LEVELS: Record<QualityLevel, QualitySettings> = {
  0: { dof: true, particleScale: 1.0, creatureScale: 1.0, resolutionScale: 1.0 },
  1: { dof: false, particleScale: 1.0, creatureScale: 1.0, resolutionScale: 1.0 },
  2: { dof: false, particleScale: 0.5, creatureScale: 1.0, resolutionScale: 1.0 },
  3: { dof: false, particleScale: 0.5, creatureScale: 0.7, resolutionScale: 1.0 },
  4: { dof: false, particleScale: 0.5, creatureScale: 0.7, resolutionScale: 0.75 },
};

const SAMPLE_COUNT = 60;
/**
 * §9「切替はフェードで行い、カクつきを見せない」
 * 段階が変わったとき、連続的に効く設定（パーティクル量・個体数）は
 * この秒数をかけて滑らかに動かす。
 */
const BLEND_SEC = 0.8;
const DOWN_THRESHOLD_FPS = 50;
const UP_THRESHOLD_FPS = 58;
const DOWN_HOLD_SEC = 2.0;
const UP_HOLD_SEC = 10.0;
/** 段階変更後は計測を落ち着かせる */
const COOLDOWN_SEC = 1.5;

export class QualityManager {
  private level: QualityLevel = 0;
  private locked = false;

  /** 現在の見た目（段階のあいだを補間した値） */
  private readonly current: QualitySettings = { ...LEVELS[0] };
  /** 補間の開始点と目標 */
  private readonly from: QualitySettings = { ...LEVELS[0] };
  private blend = 1;

  private readonly samples = new Float32Array(SAMPLE_COUNT);
  private sampleIndex = 0;
  private sampleFilled = 0;

  private lowTimer = 0;
  private highTimer = 0;
  private cooldown = 0;

  private listeners: Array<(s: QualitySettings, level: QualityLevel) => void> = [];

  onChange(fn: (s: QualitySettings, level: QualityLevel) => void): void {
    this.listeners.push(fn);
  }

  /** 補間途中の値。毎フレームこれを見て反映する */
  get settings(): QualitySettings {
    return this.current;
  }

  /** 段階の目標値（補間の終点） */
  get targetSettings(): QualitySettings {
    return LEVELS[this.level];
  }

  get currentLevel(): QualityLevel {
    return this.level;
  }

  /** 設定パネルから品質を固定する（§10 SettingsPanel） */
  lock(level: QualityLevel | null): void {
    if (level === null) {
      this.locked = false;
      return;
    }
    this.locked = true;
    if (level === this.level) {
      // すでにその段階なら、補間途中でも目標値に合わせて終わらせる
      Object.assign(this.current, LEVELS[level]);
      this.blend = 1;
      for (const fn of this.listeners) fn(this.current, level);
      return;
    }
    this.setLevel(level);
  }

  /** 実測 dt（秒）を毎フレーム渡す */
  sample(rawDelta: number): void {
    if (rawDelta <= 0) return;

    // 段階が変わったあとは、目標値へ滑らかに寄せていく
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + rawDelta / BLEND_SEC);
      const t = easeInOut(this.blend);
      const target = LEVELS[this.level];
      this.current.particleScale = lerp(this.from.particleScale, target.particleScale, t);
      this.current.creatureScale = lerp(this.from.creatureScale, target.creatureScale, t);
      // DoF と解像度は連続値にできないので、補間の途中で一度だけ切り替える。
      // 品質を下げるときは早めに、戻すときは補間の最後にする
      // （「重いから下げる」は急ぎ、「軽いから戻す」は慌てない）
      const flip = target.resolutionScale < this.from.resolutionScale ? 0.15 : 0.9;
      if (t >= flip) {
        this.current.dof = target.dof;
        this.current.resolutionScale = target.resolutionScale;
      }
      for (const fn of this.listeners) fn(this.current, this.level);
    }

    const fps = 1 / rawDelta;
    this.samples[this.sampleIndex] = fps;
    this.sampleIndex = (this.sampleIndex + 1) % SAMPLE_COUNT;
    if (this.sampleFilled < SAMPLE_COUNT) this.sampleFilled++;

    if (this.cooldown > 0) {
      this.cooldown -= rawDelta;
      return;
    }
    if (this.locked || this.sampleFilled < SAMPLE_COUNT) return;

    const avg = this.averageFps();

    if (avg < DOWN_THRESHOLD_FPS) {
      this.lowTimer += rawDelta;
      this.highTimer = 0;
      if (this.lowTimer >= DOWN_HOLD_SEC && this.level < 4) {
        this.setLevel((this.level + 1) as QualityLevel);
        this.lowTimer = 0;
      }
    } else if (avg >= UP_THRESHOLD_FPS) {
      this.highTimer += rawDelta;
      this.lowTimer = 0;
      if (this.highTimer >= UP_HOLD_SEC && this.level > 0) {
        this.setLevel((this.level - 1) as QualityLevel);
        this.highTimer = 0;
      }
    } else {
      this.lowTimer = 0;
      this.highTimer = 0;
    }
  }

  averageFps(): number {
    if (this.sampleFilled === 0) return 60;
    let sum = 0;
    for (let i = 0; i < this.sampleFilled; i++) sum += this.samples[i];
    return sum / this.sampleFilled;
  }

  private setLevel(level: QualityLevel): void {
    if (level === this.level) return;
    this.level = level;
    this.cooldown = COOLDOWN_SEC;
    this.sampleFilled = 0;
    this.sampleIndex = 0;
    // 今の見た目を起点にして、新しい段階へ補間を始める
    Object.assign(this.from, this.current);
    this.blend = 0;
  }

  dispose(): void {
    this.listeners = [];
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}
