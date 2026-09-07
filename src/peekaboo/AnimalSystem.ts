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
import type { AnimalConfig, AnimalStyle } from '../types';
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
const OUT_LIFT = 0.99;

/**
 * 絵を貼った動物を、開口の幅の何倍まで大きくするか。
 * §4-2 の上限（`mouthWidth >= animalWidth * 0.86`）そのもの
 */
const FIT_WIDTH = 0.86;
/**
 * 隠れたときに縁の下へ収めるための余白。
 *
 * **0.02 では、こや（とびら）と しだ（くさむら）の下から足が出ていた**
 * （2026-09-07 の実測。絵を貼った動物でだけ起きる。手続き生成の体は
 * 細いので届いていなかった）。`coverBottomY` は「板の下端」だが、
 * 板の形によっては、そこまでびっしり覆えていない。
 * 0.06 でも1箇所残り、0.10 で全部の場面が漏れなしになった
 */
const FIT_MARGIN = 0.1;
/** 出きった動物と、上の隠れ場所の下端とのすき間 */
const CEILING_CLEAR = 0.08;
/**
 * 上限を決めるときの安全係数。
 *
 * 出きった動物は `height * OUT_LIFT` ぶん縁より上に出るが、実際には
 * §6-1 の大きさのばらつき（最大 1.1倍）と、出たあとの癖（`idleMotion` で
 * 最大 0.12ぶん上へ）が乗る。計算どおりに詰めると、その回だけ上の
 * 隠れ場所に食い込む（実測でどうぶつえん・きょうりゅうに 0.11 残った）
 */
const OUT_TOP_SLACK = 1.3;

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
/**
 * さらに沈める量（`HIDDEN_SINK` の上に足す）。
 *
 * 隠れ場所を上下に広げた（±1.55/−1.20 → ±2.05/−1.75）ぶん、下の段を
 * 見下ろす角度が深くなり、縁の上から頭が覗くようになった
 * （ふとん で 3点、はち・つぼ で 1点ずつ）。
 * **ヒントは同じだけ持ち上げる**ので、§4-2 の「縁から 15〜25% 見えている」は
 * 変わらない。
 *
 * 0.06 まで沈めると、こんどは出きったときの見えている割合が 54% まで落ちた
 * （判定は 55%）。0.04 ＋ `OUT_LIFT` 0.99 で両立する
 */
const EXTRA_SINK = 0.04;

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
  /** `out` に入ってからの秒数。出ているあいだの癖（§6-2）に使う */
  outT: number;
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
  /** 上の隠れ場所にぶつからない大きさを決めるのに使う（`ceilingFor`） */
  private readonly spots: SpotSystem;

  constructor(
    spots: SpotSystem,
    reducedMotion = detectReducedMotion(),
    cutouts: ReadonlyMap<string, THREE.Texture> = new Map()
  ) {
    this.spots = spots;
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
      outT: 0,
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

  /**
   * この隠れ場所のすぐ上にある隠れ場所の**下端**（ワールド）。無ければ Infinity。
   *
   * 出きった動物がここを越えると、上の段の隠れ場所に重なって見える。
   * 横に離れている隠れ場所は数えない（重ならないため）。
   */
  private ceilingFor(spot: SpotRuntime): number {
    let ceiling = Infinity;
    for (const other of this.spots.runtimes) {
      if (other === spot) continue;
      if (other.worldPosition.y <= spot.worldPosition.y) continue;
      // 横にずれていれば重ならない。**見かけの幅で見る**
      const halfWidth = (spot.shape.mouthWidth + other.shape.mouthWidth) / 2;
      if (Math.abs(other.worldPosition.x - spot.worldPosition.x) >= halfWidth) continue;
      // **`coverBottomY` ではなく、実際の形の下端を測る。**
      // 背板や鉢は `coverBottomY` より下まで伸びていて、
      // 宣言値で計算した版では重なりが残った（さる で 0.73×0.11）
      other.group.updateWorldMatrix(true, true);
      _box.setFromObject(other.shape.group);
      if (Number.isFinite(_box.min.y)) ceiling = Math.min(ceiling, _box.min.y);
    }
    return ceiling;
  }

  /**
   * 隠れ場所の見た目が入れ替わったあと、動物を置き直す（§6「残るもの」）。
   * **呼ばないと、たまごの縁から体がはみ出す**（高さも開口部も変わるため）
   */
  reanchor(spot: SpotRuntime): void {
    const slot = this.slots.get(spot.config.id);
    if (slot) this.anchor(slot, spot);
  }

  /**
   * 全部を置き直す。
   *
   * **隠れ場所の見た目が入れ替わったら、その場所だけでは足りない。**
   * たまごは元の隠れ場所より下まで伸びるので、**下の段の動物の上限**が変わる。
   * 入れ替えた場所だけ置き直した版では、のうじょうの さく が
   * こや（たまご）に 1.10×0.20 重なった（2026-09-07 の実測）
   */
  reanchorAll(): void {
    for (const spot of this.spots.runtimes) this.reanchor(spot);
  }

  /** 隠れ場所に合わせて、隠れる高さ・出きる高さ・ヒントの奥行きを決め直す */
  private anchor(slot: AnimalSlot, spot: SpotRuntime): void {
    // **絵を貼った動物は、隠れ場所ごとに大きさを決め直す。**
    // 固定の大きさにしていたら、開口 1.21〜1.29 に対して動物の幅が
    // 0.49〜0.70 しか無く、1歳半には小さすぎると言われた（実測）。
    // 幅は §4-2 の上限まで、高さは「隠れたときに縁の下へ収まる」まで
    // 隠れたときに縁の下へ収まる高さ。**手続き生成の動物にも掛ける**
    // （`config.scale` は沈める深さを知らないので、深くしたぶん下から出た）
    const room = spot.shape.coverTopY - spot.shape.coverBottomY - HIDDEN_SINK - EXTRA_SINK - FIT_MARGIN;
    const byHeight = room / slot.built.height;
    if (slot.built.autoFit) {
      const byWidth = (spot.shape.mouthWidth * FIT_WIDTH) / slot.built.width;
      slot.fitScale = Math.max(0.2, Math.min(byWidth, byHeight));
    } else {
      slot.fitScale = Math.max(0.2, Math.min(slot.fitScale, byHeight));
    }
    // **上の隠れ場所にぶつからないところまで縮める**（2026-09-07 の実測）。
    // 出きった動物は縁より `height * OUT_LIFT` 上に出る。絵を隠れ場所いっぱいに
    // 合わせた結果、下の段の動物が上の段の隠れ場所に覆いかぶさっていた
    // （さる が どうぶつえん の きげあーす に 0.92×0.39 重なった。ほかに
    //  そと・うみ・のうじょう・きょうりゅう でも起きていた）。
    // **`config.scale` で決め打ちの動物にも掛ける**（縮める側にしか動かない）
    const ceiling = this.ceilingFor(spot);
    if (Number.isFinite(ceiling)) {
      const roomUp = ceiling - CEILING_CLEAR - spot.worldPosition.y - spot.shape.coverTopY;
      const maxScale = roomUp / (OUT_LIFT * OUT_TOP_SLACK * slot.built.height);
      slot.fitScale = Math.max(0.2, Math.min(slot.fitScale, maxScale));
    }
    const scale = slot.fitScale;
    slot.built.group.scale.setScalar(scale);
    const h = slot.built.height * scale;
    slot.coverTopY = spot.shape.coverTopY;
    // 隠れている位置。**体のてっぺんが、ちょうど縁と同じ高さ。**
    // ヒントは体のてっぺんに生えているので、そのぶんだけが縁の上に残る。
    // 縁より少し下に沈める（見下ろす角度で頭が覗かないように。上の定数を読むこと）
    slot.hiddenY = slot.coverTopY - h - HIDDEN_SINK - EXTRA_SINK;
    // **余分に沈めたぶんだけ、ヒントを持ち上げる。**
    // 縁から出る量（§4-2 の 15〜25%）は、沈める深さと独立でなければならない。
    // `HIDDEN_SINK`（0.06）は §4-2 の実測に使った基準なので動かさず、
    // それを超えて沈めたぶん（`EXTRA_SINK`）だけ戻す
    slot.built.hint.position.y = slot.built.height + EXTRA_SINK / scale;
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

      // --- 高さ。出かたの癖（§6-2 の `AnimalConfig.style`）で変わる ----------
      // **`driven` のあいだは触らない。** §4-5 の移動中は `ChaseSystem` が
      // ワールド座標で書いているので、ここで上書きすると跳ねが潰れる
      if (!slot.driven) {
        const lift = liftCurve(slot.config.style, reveal);
        // 出ているあいだの癖（§6-2）。**登場の 0.35秒では速すぎて見えない。**
        // 実機で「キリンの首もゾウの鼻も先に出ておらず、普通にばあっするだけ」と
        // 言われた（2026-09-07）。出きったあとの `OUT_IDLE_SEC`（1.6秒）は
        // 十分に長いので、癖はそこで見せる。
        // **`out` に入った瞬間は 0。** ここが 0 でないと、出きった位置が
        // 動物ごとに変わって「出きったとき体が見えている」の判定がぶれる
        if (spot.state === 'out') slot.outT += dt;
        else slot.outT = 0;
        const idle = idleMotion(slot.config.style, slot.outT);

        built.group.position.y =
          slot.hiddenY + (slot.outY - slot.hiddenY) * lift + idle.y * (slot.outY - slot.hiddenY);
        // 横のずれと傾き。**両端で必ず 0 に戻る**ので、
        // 隠れているとき（reveal = 0）と出きったとき（reveal = 1）の
        // 見え方は癖を入れる前とまったく同じ（不変条件3 と 2026-09-06 の再発防止）
        // 画面の外側へ逃がす向き。左の隠れ場所は左へ、右は右へ。
        // 内側へ振ると、隣の隠れ場所に重なって見える
        const side = spot.worldPosition.x < 0 ? -1 : 1;
        const arc = Math.sin(Math.PI * reveal);
        built.group.position.x = arc * styleShiftX(slot.config.style) * side + idle.x;
        built.group.rotation.z = arc * styleTilt(slot.config.style) * side + idle.tilt;
      }

      // 奥行き。絵を貼った動物は、隠れているあいだ奥に居る（`setDepth` の説明）
      built.setDepth(reveal);

      // --- 大きさ。§4-4 のオーバーシュート -----------------------------------
      // **`config.scale` ではなく `fitScale`。** 絵を貼った動物は
      // 隠れ場所ごとに倍率が違うので、ここで戻すと毎フレーム元の大きさに縮む。
      //
      // §6-1 の「大きさが ±10% ばらつく」は `sizeVar` を `reveal` で掛ける。
      // **隠れているあいだ（reveal = 0）は必ず 1 倍。**
      // ここを常時掛けると、大きく出た回に隠れ場所へ収まらなくなる（§4-2）
      const sizeVar = 1 + (spot.sizeVar - 1) * spot.reveal;
      built.group.scale.setScalar(slot.fitScale * sizeVar * (1 + OVERSHOOT * spot.pulse));

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

/* --- 出かたの癖（§6-2 の `AnimalConfig.style`）--------------------------- */

/**
 * ==========================================================================
 * **25体ぶん書いてあるのに、誰も読んでいなかった**（2026-09-07 まで）。
 * 「味つけが弱い」の一因がこれで、どの動物もまったく同じ出かたをしていた。
 *
 * 癖は**位置と傾きのカーブだけ**を変える。速さ（`reveal` の進みかた）は
 * 触らない。§4-3 の山（0.50s）と §4-5 の1周（4.80s）は `reveal` で
 * 決まっているので、そこに手を入れると表からずれる。
 *
 * **どの癖も、reveal が 0 と 1 のときには何も足さない。**
 * だから「隠れているあいだ体は覗けない」（不変条件3）も
 * 「出きったとき体が見えている」（2026-09-06 の再発防止）も、
 * 癖を入れる前とまったく同じ判定になる。テストがそれを見張る。
 * ==========================================================================
 */

/** 出かたの高さのカーブ。0→0、1→1 は**どの癖でも必ず守る** */
function liftCurve(style: AnimalStyle, reveal: number): number {
  if (style === 'peek') {
    // **顔だけ先に、ゆっくり。** きりん・ぞうの「首や鼻が先に伸びてくる」。
    // 前半で 45% まで出て、そこから一気に立ち上がる
    return reveal < 0.55 ? easeOutCubic(reveal / 0.55) * 0.45 : 0.45 + easeOutCubic((reveal - 0.55) / 0.45) * 0.55;
  }
  if (style === 'flip') {
    // 勢いよく行き過ぎてから戻る。**1 を越えない**（越えると縁から飛び出す）
    return Math.min(1, easeOutCubic(reveal) * 1.12 - 0.12 * Math.sin(Math.PI * reveal));
  }
  return easeOutCubic(reveal);
}

/**
 * 出ているあいだの癖（§6-2）。
 *
 * ==========================================================================
 * **登場の 0.35秒では癖が見えない。**
 * 実機で「キリンの首もゾウの鼻も先に出ておらず、普通にばあっするだけ」と
 * 言われた（2026-09-07）。0.35秒は「出た！」を作るための速さで、
 * そこに動きを足しても目が追いつかない。
 *
 * 出きったあとの `OUT_IDLE_SEC`（1.6秒）は十分に長いので、癖はそこで見せる。
 * **`out` に入った瞬間（t = 0）は必ず 0 を返す**ので、出きった位置は
 * どの動物でも同じ（「出きったとき体が見えている」の判定がぶれない）。
 *
 * 戻り値は「体の高さぶんの割合」。`y` は隠れ〜出きるの幅に対する比。
 * ==========================================================================
 */
function idleMotion(style: AnimalStyle, t: number): { x: number; y: number; tilt: number } {
  // **出た直後は動かさない。** 出きった瞬間の位置は、どの動物でも同じで
  // なければならない（そうしないと「出きったとき体が見えている」の判定が
  // 動物ごとにぶれる）。落ち着いてから癖が出るほうが、動きとしても読みやすい
  const ramp = smoothstep(0.15, 0.5, t);
  if (ramp <= 0) return { x: 0, y: 0, tilt: 0 };
  const m = motionOf(style, t);
  return { x: m.x * ramp, y: m.y * ramp, tilt: m.tilt * ramp };
}

function motionOf(style: AnimalStyle, t: number): { x: number; y: number; tilt: number } {
  switch (style) {
    case 'peek':
      // きりん。**さらに首を伸ばすように、ゆっくり上へ。**
      // 1周 1.4秒。出ている 1.6秒でちょうど1回、伸びて戻る。
      //
      // **下には行かせない。** `sin` で作った版は後半で下がり、
      // りす（peek）が岩に沈んで体の見えている割合が 53% まで落ちた
      // （判定は 55%）。上がって戻るだけなら、必ず今より見えている。
      //
      // 0.12 では実機で「相変わらず普通に出現している」と言われた（2026-09-07）。
      // 上へ伸びるぶんは、上の隠れ場所との重なりを `OUT_TOP_SLACK` が
      // 見込んであるので、体の高さの 0.26 まで出せる
      return { x: 0, y: (1 - Math.cos((t / 1.4) * Math.PI * 2)) * 0.5 * 0.26, tilt: 0 };
    case 'slide':
      // ぞう。**鼻で探すように、左右へゆっくり。**
      // 横に**動かす**版（±0.10）は、隠れ場所の縁に食われて
      // 体の見えている割合が 53% まで落ちた（判定は 55%）。
      // **傾ける**なら中心が動かないので、縁に食われない。
      // 0.14rad（8°）では気づかれなかったので 0.30rad（17°）にした
      return { x: 0, y: 0, tilt: Math.sin((t / 1.15) * Math.PI * 2) * 0.3 };
    case 'flip':
      // さる。**跳ねる。** 短い周期で小さく上下
      return { x: 0, y: Math.abs(Math.sin((t / 0.5) * Math.PI)) * 0.12, tilt: 0 };
    case 'spin':
      // ゆっくり首をかしげる
      return { x: 0, y: 0, tilt: Math.sin((t / 1.6) * Math.PI * 2) * 0.2 };
    default:
      // pop は動かない。**全部に癖をつけない**（全部動くと誰も目立たない）
      return { x: 0, y: 0, tilt: 0 };
  }
}

/** 出るときの横のずれ[ワールド]。**両端で 0**（`sin` を掛けて使う） */
function styleShiftX(style: AnimalStyle): number {
  if (style === 'slide') return 0.3;
  if (style === 'flip') return 0.12;
  return 0;
}

/** 出るときの傾き[rad]。**両端で 0**（同上） */
function styleTilt(style: AnimalStyle): number {
  if (style === 'slide') return 0.22;
  if (style === 'flip') return 0.5;
  if (style === 'spin') return 0.75;
  return 0;
}

/**
 * `prefers-reduced-motion`。
 * **node（単体テスト）とサーバ描画では `matchMedia` が無い。**
 * 例外を投げずに false へ落とす（§2 エラー画面を出さない）。
 */
export function detectReducedMotion(): boolean {
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
