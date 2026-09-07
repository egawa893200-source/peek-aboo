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
import { createCutoutAnimal } from './CutoutAnimal';
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

/**
 * 出きったときに、体をどれだけ縁の上に出すか（1.0 = 全身）。
 *
 * **0.9 では足りなかった**（2026-09-06）。新しく足した
 * 「出きったとき、体がカメラから見えている」で、そと の いわ が 53% しか
 * 見えず落ちた。いわは開いた半分が手前へ張り出すので、縁に埋めたぶんが
 * そのまま隠れる。0.95 で全場面が通る。
 * **0 にしないこと。** 少しだけ埋まっていないと「そこから出てきた」に見えない
 */
const OUT_LIFT = 0.95;

/**
 * 絵を貼った動物を、開口の幅の何倍まで大きくするか。
 * §4-2 の上限（`mouthWidth >= animalWidth * 0.86`）そのもの
 */
const FIT_WIDTH = 0.86;
/** 隠れたときに縁の下へ収めるための余白 */
const FIT_MARGIN = 0.02;

/**
 * 隠れているとき、体の頭を縁より**どれだけ下**に沈めるか（ワールド）。
 *
 * **0 にしないこと。** 体のてっぺんをちょうど縁と同じ高さに置くと、
 * 縁より上には出ていないのに**上から覗くと頭が見える**。
 * 隠れ場所の前板（z = 0.22）と体（z = 0 付近）には 0.22 の奥行き差があり、
 * 画面下段の隠れ場所はカメラ（y = 0.3）より下にあるので 11.8° 見下ろす形になる。
 * 0.22 × tan(11.8°) = 0.046 ぶん、縁の向こう側が見えてしまう。
 * 実測: ふとん（ねずみ）の頭が、格子 225点のうち 4点で見えていた。
 * 余裕を足して 0.06 にしてある。
 */
export const HIDDEN_SINK = 0.06;

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
  /**
   * 隠れているときの y（隠れ場所のローカル座標）。体は縁の下、ヒントだけ上。
   * モードB（§4-5）では移動先の隠れ場所に合わせて `anchor()` が入れ直す。
   */
  hiddenY: number;
  /** 出きったときの y。同上 */
  outY: number;
  /** 縁の高さ（隠れ場所のローカル座標） */
  coverTopY: number;
  /** いまの光の強さ 0..1 */
  glow: number;
  /**
   * いま居る隠れ場所。**モードB（§4-5）では移動のたびに変わる。**
   * `slots` のキーでもあるので、動かすときは必ず `reassign()` を通すこと。
   */
  spotIdMutable: string;
  /**
   * `true` のあいだ、位置は**外（`ChaseSystem`）が書く**。
   *
   * ここを見ずに `AnimalSystem` も位置を書くと、2つの書き手が毎フレーム
   * 上書きし合って、跳ねているうさぎが草むらに吸い込まれる。
   * §4-5 の移動は 1.5秒あるので、実機では「震えながら進む」ように見える。
   */
  driven: boolean;
  /**
   * 視線の行き先（ワールド座標）。null ならカメラを見る（§4-4）。
   * §4-5 の「予告」で行き先のほうを向かせるのに使う。
   */
  gazeTarget: THREE.Vector3 | null;
  /**
   * §4-2 のヒント（尻尾・耳）を縁から出すか。
   *
   * **モードB（§4-5）では false。** あちらのヒントは「移動そのもの」で、
   * 外したときは正解の場所が揺れて教えてくれる（§4-6）ので、
   * 草むらから体の一部を出す必要がない。
   * 不変条件3 のこの扱いは**人間が決めた**（2026-09-05）。
   */
  showHint: boolean;
  /**
   * 実際に掛けている倍率。
   *
   * 手続き生成は `config.scale` そのまま。絵を貼った動物（`autoFit`）は、
   * **隠れ場所ごとに `anchor()` が決め直す**（開口の幅と、縁の高さの両方から）。
   * モードB（§4-5）では移動先ごとに変わるので、`config.scale` を直接
   * 読まずに必ずここを見ること。
   */
  fitScale: number;
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
  /**
   * 隠れ場所の**下**からはみ出している割合。
   *
   * **上だけ見ていると気づけない。** うさぎ（体高 1.38）をくさむら（1.05）に
   * 入れたとき、縁より上の量は 0.22 で正しかったのに、
   * 下から白い体が飛び出していた。実機の絵を見るまで分からなかった。
   */
  bottomFraction: number;
  coverTopY: number;
  coverBottomY: number;
  animalTopY: number;
  animalBottomY: number;
  animalHeight: number;
}

export class AnimalSystem {
  private readonly slots = new Map<string, AnimalSlot>();
  /** 光った回数。E2E と単体テストから数える（不変条件6） */
  private flashes = 0;
  /** 入れ替えた回数（§6-2）。テストが見る */
  private swaps = 0;
  /** 前回光った時刻。`Loop` の固定 dt を積むので、テストで正確に再現できる */
  private lastFlashAt = Number.NEGATIVE_INFINITY;
  private clock = 0;
  private readonly glowScale: number;

  /**
   * @param reducedMotion `prefers-reduced-motion` 指定時は光を弱める（不変条件6）。
   *   省略時は環境から読む。node（単体テスト）には `matchMedia` が無いので、
   *   **例外を投げずに false に落とす**。
   */
  /**
   * 絵をそのまま貼るための素材（道A）。`SceneRoot` が場面ごとに読んで渡す。
   * **空でも動く。** その場合は全部が手続き生成になる（不変条件7）
   */
  private readonly cutouts: ReadonlyMap<string, THREE.Texture>;

  constructor(
    spots: SpotSystem,
    reducedMotion = detectReducedMotion(),
    cutouts: ReadonlyMap<string, THREE.Texture> = new Map()
  ) {
    this.cutouts = cutouts;
    this.glowScale = reducedMotion ? 0.3 : 1;

    for (const spot of spots.runtimes) {
      const id = spot.config.animals[spot.animalIndex];
      // モードB（§4-5）は空配列。走り手は `SceneRoot` が `spawn()` で入れる
      if (!id) continue;
      this.spawn(spot, id);
    }
  }

  /**
   * 隠れ場所に動物を1体入れる。
   *
   * モードB（§4-5）の走り手は `SceneRoot` がここから入れる。
   * **見つからない動物 id でも例外を投げない**（不変条件7）。
   */
  spawn(spot: SpotRuntime, animalId: string): AnimalSlot | null {
    const config = findAnimal(animalId);
    if (!config) return null;

    // **絵があれば絵を貼る。無ければ手続き生成**（不変条件7）。
    // `AnimalSystem` から先は、どちらで作られたか知らないままで動く
    const cutout = this.cutouts.get(animalId);
    const built = cutout ? createCutoutAnimal(config, cutout) : createProceduralAnimal(config);
    const coverTopY = spot.shape.coverTopY;

    const slot: AnimalSlot = {
      spotId: spot.config.id,
      spotIdMutable: spot.config.id,
      config,
      built,
      hiddenY: 0,
      outY: 0,
      coverTopY,
      glow: 0,
      fitScale: config.scale,
      driven: false,
      gazeTarget: null,
      showHint: true,
    };
    this.slots.set(spot.config.id, slot);
    this.anchor(slot, spot);
    built.group.position.y = slot.hiddenY;
    return slot;
  }

  /**
   * 走り手を別の隠れ場所へ移す（§4-5 の到着）。
   *
   * `slots` のキーと three の親子関係の**両方**を移す。
   * 片方だけ直すと、次の移動で「元の場所から生えてくる」になる。
   */
  reassign(from: SpotRuntime, to: SpotRuntime): AnimalSlot | null {
    const slot = this.slots.get(from.config.id);
    if (!slot) return null;
    this.slots.delete(from.config.id);
    slot.spotIdMutable = to.config.id;
    this.slots.set(to.config.id, slot);
    to.group.add(slot.built.group);
    this.anchor(slot, to);
    return slot;
  }

  /**
   * 2箇所の動物を入れ替える（§6-2 / 2026-09-06）。
   *
   * **どちらも隠れ終わっていること。** 出ている最中に入れ替えると
   * 目の前ですり替わる。呼ぶ側（`SceneRoot`）が確かめる。
   *
   * `slots` のキーと three の親子関係の**両方**を移す。
   * `reassign()` と同じ理由で、片方だけ直すと次に出るとき元の場所から生える。
   * 入れ替えたあとは必ず `anchor()` を通す。**絵を貼った動物は
   * 隠れ場所ごとに大きさが変わる**ので、通さないと前の場所の大きさのままになる。
   */
  swap(a: SpotRuntime, b: SpotRuntime): boolean {
    if (a === b) return false;
    const slotA = this.slots.get(a.config.id);
    const slotB = this.slots.get(b.config.id);
    if (!slotA || !slotB) return false;

    this.slots.set(a.config.id, slotB);
    this.slots.set(b.config.id, slotA);
    slotA.spotIdMutable = b.config.id;
    slotB.spotIdMutable = a.config.id;
    b.group.add(slotA.built.group);
    a.group.add(slotB.built.group);
    this.anchor(slotA, b);
    this.anchor(slotB, a);
    // 入れ替えた直後は隠れている。次に開けたときに気づく
    slotA.built.group.position.y = slotA.hiddenY;
    slotB.built.group.position.y = slotB.hiddenY;
    this.swaps++;
    return true;
  }

  getSwapCount(): number {
    return this.swaps;
  }

  /** 隠れ場所に合わせて、隠れる高さ・出きる高さ・ヒントの奥行きを決め直す */
  private anchor(slot: AnimalSlot, spot: SpotRuntime): void {
    // **絵を貼った動物は、隠れ場所ごとに大きさを決め直す。**
    // 固定の大きさにしていたら、開口 1.21〜1.29 に対して動物の幅が
    // 0.49〜0.70 しか無く、1歳半には小さすぎると言われた（実測）。
    // 幅は §4-2 の上限まで、高さは「隠れたときに縁の下へ収まる」まで
    if (slot.built.autoFit) {
      const byWidth = (spot.shape.mouthWidth * FIT_WIDTH) / slot.built.width;
      const room = spot.shape.coverTopY - spot.shape.coverBottomY - HIDDEN_SINK - FIT_MARGIN;
      const byHeight = room / slot.built.height;
      slot.fitScale = Math.max(0.2, Math.min(byWidth, byHeight));
    }
    const scale = slot.fitScale;
    slot.built.group.scale.setScalar(scale);
    const h = slot.built.height * scale;
    slot.coverTopY = spot.shape.coverTopY;
    // 隠れている位置。**体のてっぺんが、ちょうど縁と同じ高さ。**
    // ヒントは体のてっぺんに生えているので、そのぶんだけが縁の上に残る。
    // 縁より少し下に沈める（見下ろす角度で頭が覗かないように。上の定数を読むこと）
    slot.hiddenY = slot.coverTopY - h - HIDDEN_SINK;
    // 出きった位置。少しだけ縁に埋めておくと「そこから出てきた」に見える
    slot.outY = slot.coverTopY - h * (1 - OUT_LIFT);

    slot.built.group.position.x = 0;
    slot.built.group.position.z = spot.shape.animalZ;

    // ヒントだけは前板の**手前**へ出す（§4-2）。
    // 体と同じ奥行きに置くと、上段の隠れ場所はカメラより上にあるため
    // 下から見上げる形になり、ふたやレールがヒントを丸ごと隠す。
    // 高さは足りているので**数値のテストでは気づけない**（実際に見落とした）。
    // `hint` は動物のスケールの中にいるので、割り戻してから渡す
    slot.built.hint.position.z = (spot.shape.hintZ - spot.shape.animalZ) / scale;

    if (slot.built.group.parent !== spot.group) spot.group.add(slot.built.group);
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
      // **`driven` のあいだは触らない。** §4-5 の移動中は `ChaseSystem` が
      // ワールド座標で書いているので、ここで上書きすると跳ねが潰れる
      if (!slot.driven) {
        const lift = easeOutCubic(reveal);
        built.group.position.y = slot.hiddenY + (slot.outY - slot.hiddenY) * lift;
      }

      // --- 大きさ。§4-4 のオーバーシュート -----------------------------------
      // **`config.scale` ではなく `fitScale`。** 絵を貼った動物は
      // 隠れ場所ごとに倍率が違うので、ここで戻すと毎フレーム元の大きさに縮む
      built.group.scale.setScalar(slot.fitScale * (1 + OVERSHOOT * spot.pulse));

      // --- ヒント（§4-2） ----------------------------------------------------
      // 出はじめたら引っ込める。頭の上に尻尾が残っていたら、ただの飾りになる。
      // 移動中（`driven`）も消す。跳んでいる最中に頭の上から耳が生えたら怖い
      built.hint.visible = slot.showHint && !slot.driven && reveal < 0.12;
      // 中でもぞもぞしている感じ。隠れ場所の揺れと同じ量を、逆向きに掛ける
      if (built.hint.visible) built.hint.rotation.z = -spot.shake * 0.35;

      // --- 視線（§4-4 顔と目が見えることが最重要） ---------------------------
      // 移動中は行き先を見る（§4-5 の「予告」）。それ以外はカメラを見る。
      // **どちらでも必ずどこかを見ている。** 目が泳ぐと生き物に見えない
      // さかな・かに・たこは横向き／真上向きに作ってあるので、
      // カメラを正面から見せると輪郭が崩れる。個体ごとに効きを変える
      const gaze = (slot.driven ? 1 : smoothstep(GAZE_FROM, 1, reveal)) * built.gazeStrength;
      if (gaze > 0) {
        built.head.getWorldPosition(_headPos);
        _dir.subVectors(slot.gazeTarget ?? _camPos, _headPos);
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
    const coverBottomY = spot.worldPosition.y + spot.shape.coverBottomY * scale;
    const animalHeight = slot.built.height * slot.fitScale * scale;

    slot.built.group.updateWorldMatrix(true, true);

    // ヒントを出さない個体（モードBの走り手）は、**ヒントを数に入れない**。
    // `Box3` は `visible` を見ないので、消してあるヒントまで数えると
    // 「画面に出ている量」が実際より多く出て、測定そのものが嘘になる
    _box.makeEmpty();
    for (const child of slot.built.group.children) {
      if (!slot.showHint && child === slot.built.hint) continue;
      _box.expandByObject(child);
    }
    const animalTopY = _box.max.y;
    const animalBottomY = _box.min.y;

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
      bottomFraction: Math.max(0, coverBottomY - animalBottomY) / animalHeight,
      coverTopY,
      coverBottomY,
      animalBottomY,
      animalTopY,
      animalHeight,
    };
  }

  /** 見分けがつくかの実測（§4-2「動物の断面の 0.86 倍を隠れ場所が覆う」） */
  getFit(spot: SpotRuntime): { mouthWidth: number; animalWidth: number; ratio: number } | null {
    const slot = this.slots.get(spot.config.id);
    if (!slot) return null;
    const animalWidth = slot.built.width * slot.fitScale;
    const mouthWidth = spot.shape.mouthWidth;
    return { mouthWidth, animalWidth, ratio: mouthWidth / animalWidth };
  }

  getSlot(spotId: string): AnimalSlot | null {
    return this.slots.get(spotId) ?? null;
  }

  /** 場面に1体しか居ないとき（モードB の走り手）に、その1体を返す */
  getOnlySlot(): AnimalSlot | null {
    if (this.slots.size !== 1) return null;
    for (const slot of this.slots.values()) return slot;
    return null;
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
