/**
 * 1場面ぶんの生成と破棄（設計書 §7-4 / 不変条件8）
 *
 * ==========================================================================
 * **場面を捨てるときに geometry / material / texture を1つ残らず dispose する。**
 * みずのなかでは、ここで1つ漏らすたびに切替のたびにメモリが増えていった。
 * `renderer.info.memory` が場面の往復で増え続けないことを E2E で見る。
 *
 * 場面切替そのものは Phase 6。だが**捨てる側を後から足すのは間に合わない**ので、
 * 場面が1つしか無いいまのうちに `dispose()` まで書いて、往復のテストも通しておく。
 * ==========================================================================
 */

import * as THREE from 'three';

import type { AssetLoader } from '../core/AssetLoader';
import { findAnimal } from '../data/animals';
import { AnimalSystem } from '../peekaboo/AnimalSystem';
import { ChaseSystem } from '../peekaboo/ChaseSystem';
import { EmptySpot } from '../peekaboo/EmptySpot';
import { disposeObject3D } from '../peekaboo/SpotShapes';
import { SpotShuffle } from '../peekaboo/SpotShuffle';
import { createCutoutAnimal, createCutoutShadow } from '../peekaboo/CutoutAnimal';
import { createProceduralAnimal } from '../peekaboo/ProceduralAnimals';
import { SpotSystem } from '../peekaboo/SpotSystem';
import { createBackdropTexture, createContactShadow, createShadowTexture } from './Backdrop';
import { Flavor, FOOTPRINT_EVERY_SEC } from './Flavor';

/** 行き先の隠れ場所からこれだけ離れていないと、足あとを落とさない */
const FOOTPRINT_KEEP_AWAY = 0.95;
import type { SceneConfig } from '../types';

/** 足あとの位置を取るための使い捨て。**毎フレーム new をしない**（§10-3） */
const _footAt = new THREE.Vector3();

export class SceneRoot {
  readonly group = new THREE.Group();
  readonly spots: SpotSystem;
  readonly animals: AnimalSystem;
  /** モードB（§4-5）のときだけ。モードAでは null */
  readonly chase: ChaseSystem | null;
  /** §6-2。モードAのときだけ。モードBでは null */
  readonly shuffle: SpotShuffle | null;
  /** §4-6。モードAでも空の場所は起きないが、**外さない**（不変条件3b の保険） */
  readonly empty: EmptySpot;
  /** 場面ごとの味つけ（`SceneConfig.flavor`）。何も指定が無ければ何も起きない */
  readonly flavor: Flavor;
  /** もう1匹（§6 の〈大〉）の見た目。**`Flavor` は捨てない**ので、ここで捨てる */
  private cameo: { dispose(): void } | null = null;
  /** 影（§6 の〈中〉）の見た目。同上 */
  private shadowShapes: Map<string, THREE.Object3D> | null = null;
  /** 足あとを落とす間隔の積算（§6 の〈中〉） */
  private footprintT = 0;

  /**
   * この場面で読んだ絵。§6-3 のサプライズが同じテクスチャを使い回す。
   * **`AssetLoader` が持っているので、ここでは捨てない**
   */
  readonly cutouts: ReadonlyMap<string, THREE.Texture>;

  /** 床。隠れ場所が宙に浮いて見えないように敷くだけ */
  private readonly floor: THREE.Mesh;
  /** 手続き生成の背景と影。**`AssetLoader` は持っていないので自分で捨てる** */
  private readonly backdrop: THREE.Texture | null;
  private readonly shadowTexture: THREE.Texture | null;
  /**
   * 接地影の板。
   *
   * **`SpotSystem` の子にしても、あちらは捨ててくれない。**
   * 自分で作ったものは自分で捨てる（不変条件8）。
   * 入れ忘れたときは、場面を10往復して geometry が 35 → 75 に増えた
   * （4箇所 × 10往復 = 40 枚ぶん）。e2e が捕まえた
   */
  private readonly shadows: readonly THREE.Mesh[];

  private constructor(
    readonly config: SceneConfig,
    spots: SpotSystem,
    animals: AnimalSystem,
    chase: ChaseSystem | null,
    shuffle: SpotShuffle | null,
    empty: EmptySpot,
    flavor: Flavor,
    floor: THREE.Mesh,
    backdrop: THREE.Texture | null,
    shadowTexture: THREE.Texture | null,
    shadows: readonly THREE.Mesh[],
    cutouts: ReadonlyMap<string, THREE.Texture>
  ) {
    this.cutouts = cutouts;
    this.backdrop = backdrop;
    this.shadowTexture = shadowTexture;
    this.shadows = shadows;
    this.spots = spots;
    this.animals = animals;
    this.chase = chase;
    this.shuffle = shuffle;
    this.empty = empty;
    this.flavor = flavor;
    this.floor = floor;
    this.group.add(floor);
    this.group.add(spots.group);
    // 横切るものは隠れ場所より奥に置く（`Flavor` が z を決めている）
    this.group.add(flavor.group);
    // 影だけは隠れ場所の手前。**隠れているあいだしか出さない**ので、
    // 出てきた動物にかぶることがない（`Flavor` の `SHADOW_Z` を読むこと）
    this.group.add(flavor.frontGroup);
  }

  /**
   * 場面を組み立てる。
   *
   * **素材が1つも無くても必ず返る**（不変条件7）。
   * `backgroundUrl` / `modelUrl` が null なら手続き生成に落ちるし、
   * 404 でも `AssetLoader` が黙って null を返す。ここで例外は投げない。
   */
  static async build(
    config: SceneConfig,
    assets: AssetLoader,
    options: { chaseSeed?: number } = {}
  ): Promise<SceneRoot> {
    const spots = new SpotSystem(config.spots, config.mode);

    // 素材のURLは必ず `resolveAssetUrl()` を通す（`AssetLoader` の中で通している）。
    // いまは背景も動物も null なので何も読まないが、**経路だけ先に通しておく**。
    // 通っていないことは、素材を置いた日まで気づけない（CLAUDE.md）。
    const background = await assets.loadOptionalTexture(config.backgroundUrl);

    // 背景。素材があればそれを、無ければ手続き生成のグラデーションを敷く（道D）。
    // **単色の板をやめる。** 空も地面も奥行きも無いのが「安っぽさ」の正体だった。
    // `document` が無い環境（単体テスト）では単色のまま落とす（例外を投げない）
    // 場面ごとの空（2026-09-07）。**指定が無ければ従来どおりの夜空**
    const sky = config.sky ?? ['#3d5c8c', '#0b1526'];
    const backdrop =
      !background && typeof document !== 'undefined'
        ? createBackdropTexture(sky[0], sky[1])
        : null;
    const floorMat = new THREE.MeshStandardMaterial({
      color: backdrop ? 0xffffff : 0x2a3550,
      roughness: 1,
      metalness: 0,
      ...(background ? { map: background } : {}),
      ...(backdrop ? { map: backdrop } : {}),
    });
    // **画面いっぱいを覆う大きさにする**（2026-09-07）。
    // 14×10 では縦が足りず、上下に地の色（レンダラのクリア色）の帯が出ていた。
    // 実測: この奥行き（z = -1.6、カメラから 8.8）で画面に入るのは
    // 縦 ±5.71・横 ±2.80 なので、縦は 11.4 以上が要る。三角形は2枚のまま
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), floorMat);
    // 隠れ場所より奥に、少しだけ手前に倒して敷く。
    // 真後ろの垂直な板にすると、隠れ場所との前後関係が読めない
    floor.position.set(0, 0, -1.6);
    floor.rotation.x = -0.12;

    // 絵をそのまま貼る動物（道A）の素材を、場面ぶんまとめて読む。
    // **1枚でも読めなければ、その動物だけ手続き生成に落ちる**（不変条件7）。
    // ここで待つのは、`AnimalSystem.spawn()` が同期だから。
    // 場面の構築はもともと非同期（背景と同じ経路）なので待ち時間は増えない
    const wanted = new Set<string>();
    for (const spot of config.spots) for (const id of spot.animals) wanted.add(id);
    if (config.runner) wanted.add(config.runner);
    const cutouts = new Map<string, THREE.Texture>();
    await Promise.all(
      [...wanted].map(async (id) => {
        const url = findAnimal(id)?.cutoutUrl ?? null;
        const tex = await assets.loadOptionalTexture(url);
        if (tex) cutouts.set(id, tex);
      })
    );

    // 接地影（道D）。**`shadowMap` は使わない。**
    // 光源1つ・カメラ固定なので影の形は動かない。動かない影を毎フレーム
    // 描き直す理由が無いし、shadowMap はスマホでいちばん高くつく
    let shadowTexture: THREE.Texture | null = null;
    const shadows: THREE.Mesh[] = [];
    if (typeof document !== 'undefined') {
      shadowTexture = createShadowTexture();
      for (const runtime of spots.runtimes) {
        const shadow = createContactShadow(shadowTexture, runtime.shape.mouthWidth * 1.9);
        // 隠れ場所の底より少し下、少し奥。**手前に出さないこと。**
        // 出すと動物の足元に黒い帯が乗る。
        // 板は立てたまま（寝かせると見下ろし 11.8° では見えない）
        shadow.position.set(0, runtime.shape.coverBottomY - 0.1, -0.3);
        runtime.group.add(shadow);
        shadows.push(shadow);
      }
    }

    const animals = new AnimalSystem(spots, undefined, cutouts);

    // モードB（§4-5）。走り手はデータではなく実行時にどこかへ入れる。
    // **`SpotConfig.animals` は空配列のまま**（§5-1）
    let chase: ChaseSystem | null = null;
    if (config.mode === 'chase' && config.runner && spots.runtimes.length > 0) {
      const start = spots.runtimes[0];
      const runner = animals.spawn(start, config.runner);
      // モードBのヒントは「移動そのもの」（§4-5 の表）。
      // 外したときは正解の場所が揺れて教える（§4-6）ので、
      // くさむらから体の一部を出さない。**人間が決めた扱い**（2026-09-05）
      if (runner) runner.showHint = false;
      chase = new ChaseSystem(spots, animals, {
        ...(options.chaseSeed !== undefined ? { seed: options.chaseSeed } : {}),
        startSpotId: start.config.id,
      });
    }

    // §4-6。**モードAでも繋いでおく。** 場面のデータを間違えて
    // 動物の居ない隠れ場所を作ってしまっても、無反応にはならない（不変条件3b）
    // §6-2「同じ隠れ場所から別の動物が出る」。
    // **モードAだけ。** モードBは走り手が移動しているので、ここが動かすと
    // 2つの書き手が同じものを取り合う（§4-5 の `driven` と同じ話）
    const shuffle =
      config.mode === 'hideout'
        ? new SpotShuffle(spots, animals, {
            ...(options.chaseSeed !== undefined ? { seed: options.chaseSeed ^ 0x5bd1e995 } : {}),
          })
        : null;

    // 場面ごとの味つけ（2026-09-07）。**`config.flavor` を読むだけ。**
    // 場面 id で分岐しない（`Flavor.ts` 冒頭の理由）
    const flavor = new Flavor(spots.runtimes, config.flavor, {
      ...(options.chaseSeed !== undefined ? { seed: options.chaseSeed ^ 0x1b873593 } : {}),
    });

    const empty = new EmptySpot(spots);
    spots.onEmpty((spot) => {
      // もう1匹が顔を出している場所なら、**その子が引っ込む**（§6 の〈大〉）。
      // 押した先に居るのに「あれ？」＋正解を教える揺れが出るのは因果が合わない
      // （2026-09-07 に実機で指摘）
      if (flavor.tapCameo(spot.config.id)) return;
      empty.trigger(spot, chase?.getAnswerSpot() ?? null);
    });

    /** もう1匹の見た目。**作った側で捨てる**（不変条件8） */
    let cameoBuilt: { dispose(): void } | null = null;
    /** 影の見た目。同上 */
    let shadowShapes: Map<string, THREE.Object3D> | null = null;


    // 残るもの（§6）。**隠れ場所そのものを たまご／つぼみ に入れ替える。**
    // 「小さな卵が横に残っているだけでは何の意味もない」と言われて、
    // 人間が決めた形（2026-09-07）。当たり判定は動かない（`worldPosition` 基準）
    // **入れ替えた場所だけでなく、全部を置き直す。**
    // たまごは元の隠れ場所より下まで伸びるので、下の段の動物の上限が変わる
    flavor.onLeftover((spot, kind) => {
      if (spots.setShape(spot, kind)) animals.reanchorAll();
    });
    flavor.onLeftoverEnd((spot) => {
      if (spots.setShape(spot, spot.config.kind)) animals.reanchorAll();
    });

    // 影が先に映る（§6 の〈中〉）。**その動物の絵を黒く塗った板**を使う。
    // 丸ふたつで作ったら「雪だるまみたいで意味がない」と言われた（2026-09-07）。
    // 絵が無い動物は影も出さない（不変条件7。手続き生成の輪郭は板にできない）
    if (config.flavor?.shadowPeek) {
      const shapes = new Map<string, THREE.Object3D>();
      for (const [animalId, tex] of cutouts) {
        const cfg = findAnimal(animalId);
        if (cfg) shapes.set(animalId, createCutoutShadow(cfg, tex));
      }
      shadowShapes = shapes;
      flavor.setShadowShapes(shapes, (spotId) => animals.getSlot(spotId)?.config.id ?? null);
    }

    // もう1匹（§6 の〈大〉）。**追いかけっこの相手ではない脇役。**
    // `AnimalSystem` のスロットを使わない（使うと `ChaseSystem` と
    // 同じ隠れ場所を取り合って、跳ねているうさぎが吸い込まれる）。
    // 見た目だけここで作って `Flavor` に渡す
    if (chase && config.flavor?.cameo && config.runner) {
      const cfg = findAnimal(config.runner);
      const tex = cutouts.get(config.runner);
      // 絵が無ければ手続き生成に落ちる（不変条件7）
      const built = cfg ? (tex ? createCutoutAnimal(cfg, tex) : createProceduralAnimal(cfg)) : null;
      if (built) {
        // 本人と同じ大きさに揃える。**少しだけ小さくする**（子に見える）
        const runnerSlot = animals.getSlot(spots.runtimes[0].config.id);
        const scale = (runnerSlot?.fitScale ?? cfg!.scale) * 0.86;
        built.group.scale.setScalar(scale);
        built.hint.visible = false;
        cameoBuilt = built;
        flavor.setCameo(built.group, built.height * scale, () => ({
          busy: chase!.isMoving(),
          avoidSpotId: chase!.getAnswerSpot().config.id,
        }));
      }
    }

    const root = new SceneRoot(config, spots, animals, chase, shuffle, empty, flavor, floor, backdrop, shadowTexture, shadows, cutouts);
    root.cameo = cameoBuilt;
    root.shadowShapes = shadowShapes;
    return root;
  }

  /**
   * 1フレーム進める。
   *
   * **順番を変えないこと。**
   * `SpotSystem` が `out` → `moving` を作り、`ChaseSystem` がそれを拾う。
   * 逆にすると移動の開始が毎回1フレーム遅れる（4.80秒の表からずれる）。
   * `AnimalSystem` は最後。両者が決めた `reveal` と位置を見て絵にする。
   */
  update(dt: number, camera: THREE.Camera): void {
    this.spots.update(dt);
    this.chase?.update(dt);
    this.trackFootprints(dt);
    this.empty.update(dt);
    // **`SpotSystem` のあと。** 状態の遷移（ため のはじまり・登場の山）を
    // 同じフレームで拾う。先に呼ぶと足音と地ひびきが1フレーム遅れる
    this.flavor.update(dt);
    this.animals.update(dt, this.spots, camera);
  }

  /**
   * 足あと（§6 の〈中〉）。**跳ねている道筋そのものに落とす。**
   *
   * 画面の下へ横一列に並べた版は、実機で「意味のない足あと」と言われた
   * （2026-09-07）。居た場所から隠れた場所へ**つながって見える**ことが要る。
   *
   * `ChaseSystem` は位置をイベントで渡さない（跳ねた回数しか知らせない）ので、
   * 移動中は毎フレーム、走り手の世界座標を見て一定間隔で落とす。
   */
  private trackFootprints(dt: number): void {
    // **跳んでいるあいだだけ。** `isMoving()` は予告（aim）と到着（look・burrow）も
    // 含むので、そのまま使うと動いていない時間に足あとが同じ場所へ積み上がる
    // （実測: 中央のくさむらの下に縦一列で 5個 重なった）
    if (this.chase?.getPhase() !== 'hop') {
      this.footprintT = 0;
      return;
    }
    this.footprintT += dt;
    if (this.footprintT < FOOTPRINT_EVERY_SEC) return;
    this.footprintT = 0;
    const dest = this.chase.getAnswerSpot();
    for (const runtime of this.spots.runtimes) {
      const slot = this.animals.getSlot(runtime.config.id);
      if (!slot) continue;
      slot.built.group.getWorldPosition(_footAt);
      // **行き先の近くには落とさない。** 足あとは隠れ場所より手前に出るので、
      // 着地点に残すと、そのあと出てくる動物にかぶる
      if (_footAt.distanceTo(dest.worldPosition) > FOOTPRINT_KEEP_AWAY) {
        this.flavor.dropFootprint(_footAt.x, _footAt.y);
      }
      return;
    }
  }

  /**
   * 場面を捨てる。**漏らさないこと**（不変条件8）。
   *
   * `AnimalSystem` と `SpotSystem` は自分の分を捨てる。
   * `disposeObject3D` は「取りこぼしが無いか」の最後の網で、
   * ここまで来る前に各システムが捨てているのが正しい姿。
   */
  dispose(): void {
    // 自分で作ったものは自分で捨てる（不変条件8）。
    // 影の板は `SpotSystem` の子だが、あちらは捨ててくれない
    for (const shadow of this.shadows) disposeObject3D(shadow, { keepTextures: true });
    this.flavor.dispose();
    this.cameo?.dispose();
    if (this.shadowShapes) {
      // テクスチャは `AssetLoader` が持っている（動物の絵と同じもの）
      for (const shape of this.shadowShapes.values()) {
        disposeObject3D(shape, { keepTextures: true });
      }
      this.shadowShapes = null;
    }
    this.backdrop?.dispose();
    this.shadowTexture?.dispose();
    this.empty.dispose();
    this.animals.dispose();
    this.spots.dispose();
    disposeObject3D(this.floor);
    disposeObject3D(this.group);
  }
}
