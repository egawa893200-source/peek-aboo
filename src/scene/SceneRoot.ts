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
import type { SpotRuntime } from '../peekaboo/SpotSystem';
import {
  createBackdropImage,
  createBackdropTexture,
  createContactShadow,
  createShadowTexture,
  sampleBackdropLight,
  sampleBackdropHorizon,
  sampleBackdropSun,
} from './Backdrop';
import { DROP_SHADOW, SKY_SHADOW_FADE, SUPPORT } from '../data/look';
import { Flavor, FOOTPRINT_EVERY_SEC } from './Flavor';

/** 行き先の隠れ場所からこれだけ離れていないと、足あとを落とさない */
const FOOTPRINT_KEEP_AWAY = 0.95;
import type { SceneConfig } from '../types';

/** 足あとの位置を取るための使い捨て。**毎フレーム new をしない**（§10-3） */
const _footAt = new THREE.Vector3();
/** 落ち影を合わせるときの使い捨て。同上 */
const _shadowBox = new THREE.Box3();
const _shadowInverse = new THREE.Matrix4();
const _shadowAt = new THREE.Vector3();
/** 楕円の影が似合う隠れ場所。それ以外は角丸の四角にする */
const ROUND_SHAPES: ReadonlySet<string> = new Set(['bush', 'rock', 'pot', 'egg']);

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
   * この場面の光の色（背景の絵から読んだ、上半分と下半分の平均色）。
   * `App` がこれを `HemisphereLight` に渡す。**絵そのものには光を当てない**
   * （背景も動物も `MeshBasicMaterial`）ので、変わるのは隠れ場所と飾りだけ。
   */
  readonly ambient: { sky: THREE.Color; ground: THREE.Color };

  /**
   * 背景の絵のいちばん明るいところ（0〜1 の u, v）。`App` が主光の向きに使う。
   * 絵が無ければ null（不変条件7）。
   */
  readonly sun: { u: number; v: number } | null;

  /** 背景の絵の地平線（ワールドの y）。空に掛かる影を弱めるのに使う */
  private readonly horizonY: number | null;
  /** 上の段を地面まで支える柱。**自分で作ったものは自分で捨てる**（不変条件8） */
  private readonly supports: readonly THREE.Mesh[];

  /**
   * この場面で読んだ絵。§6-3 のサプライズが同じテクスチャを使い回す。
   * **`AssetLoader` が持っているので、ここでは捨てない**
   */
  readonly cutouts: ReadonlyMap<string, THREE.Texture>;

  /** 床。隠れ場所が宙に浮いて見えないように敷くだけ */
  private readonly floor: THREE.Mesh;
  /** 背景の絵の板。指定が無ければ null（グラデーションだけ） */
  private readonly backdropImage: THREE.Mesh | null;
  /** 手続き生成の背景と影。**`AssetLoader` は持っていないので自分で捨てる** */
  private readonly backdrop: THREE.Texture | null;
  private readonly shadowTexture: THREE.Texture | null;
  /** 角のある隠れ場所ぶんの落ち影。丸いものとは別のテクスチャを使う */
  private readonly shadowRectTexture: THREE.Texture | null;
  /**
   * いま影を合わせてある形。**入れ替わったら測り直す。**
   * たまごに入れ替わると外接箱が変わるので、合わせ直さないと影だけ元の形のまま残る
   */
  private readonly shadowFitted: (object | null)[] = [];
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
    backdropImage: THREE.Mesh | null,
    backdrop: THREE.Texture | null,
    shadowTexture: THREE.Texture | null,
    shadowRectTexture: THREE.Texture | null,
    shadows: readonly THREE.Mesh[],
    cutouts: ReadonlyMap<string, THREE.Texture>,
    ambient: { sky: THREE.Color; ground: THREE.Color },
    sun: { u: number; v: number } | null,
    horizonY: number | null,
    supports: readonly THREE.Mesh[]
  ) {
    this.horizonY = horizonY;
    this.supports = supports;
    this.ambient = ambient;
    this.sun = sun;
    this.cutouts = cutouts;
    this.backdrop = backdrop;
    this.shadowTexture = shadowTexture;
    this.shadowRectTexture = shadowRectTexture;
    this.shadows = shadows;
    this.spots = spots;
    this.animals = animals;
    this.chase = chase;
    this.shuffle = shuffle;
    this.empty = empty;
    this.flavor = flavor;
    this.floor = floor;
    this.backdropImage = backdropImage;
    this.group.add(floor);
    if (backdropImage) this.group.add(backdropImage);
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

    // 背景の絵（`SceneConfig.backgroundUrl`）。
    //
    // **正方形の板に貼らないこと。** グラデーションと同じ 16×16 に貼ると、
    // 縦長の絵が横に潰れる。絵の縦横比のまま、画面に入る範囲を覆う大きさで
    // 別の板に貼る（うしろにグラデーションの板が残るので、横持ちでも
    // 地の色は出ない）。**光を当てない**ので、描いたとおりの色が出る
    const backdropImage = background ? createBackdropImage(background) : null;

    // 場面の光の色。**絵から読む**（`SCENE_LIGHT_TINT` の理由を参照）。
    // 絵が無ければ `SceneConfig.sky` の2色に落ちる（不変条件7）
    const sampled = background ? sampleBackdropLight(background) : null;
    const ambient = sampled ?? {
      sky: new THREE.Color(sky[0]),
      ground: new THREE.Color(sky[1]),
    };
    // 主光の向き。**絵のいちばん明るいところ**に寄せる（`SUN_FOLLOW`）。
    // 絵が無ければ null で、`App` が既定の向きのままにする
    const sun = background ? sampleBackdropSun(background) : null;
    // 地平線（ワールドの y）。空に掛かる影を弱めるために使う。
    // 絵が無い場面・地面の無い絵（うみ）では null
    let horizonY: number | null = null;
    if (background && backdropImage) {
      const v = sampleBackdropHorizon(background);
      if (v !== null) {
        const plane = backdropImage.geometry as THREE.PlaneGeometry;
        horizonY = (0.5 - v) * plane.parameters.height;
      }
    }

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
    let shadowRectTexture: THREE.Texture | null = null;
    const shadows: THREE.Mesh[] = [];
    if (typeof document !== 'undefined') {
      shadowTexture = createShadowTexture('ellipse');
      shadowRectTexture = createShadowTexture('rect');
      for (const runtime of spots.runtimes) {
        const shadow = createContactShadow(shadowTexture, 1, 1);
        runtime.group.add(shadow);
        shadows.push(shadow);
      }
    }

    // 上の段を地面まで支える柱（`SUPPORT`）。**見た目だけの追加。**
    // 地平線が読めない絵では出さない（不変条件7）
    const supports = horizonY === null ? [] : addSupports(spots.runtimes, horizonY, ambient);

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

    const root = new SceneRoot(config, spots, animals, chase, shuffle, empty, flavor, floor, backdropImage, backdrop, shadowTexture, shadowRectTexture, shadows, cutouts, ambient, sun, horizonY, supports);
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
  /**
   * 落ち影を、いまの隠れ場所の外接箱に合わせる。
   *
   * **形が入れ替わったときだけ測り直す**（たまご／つぼみ）。
   * 毎フレーム `Box3` を取ると重いので、前に合わせた形と同じなら何もしない。
   * 参照を1つ比べるだけなので、毎フレーム呼んでよい（§10-3 の new もしない）。
   */
  private fitShadows(camera: THREE.Camera): void {
    for (let i = 0; i < this.shadows.length; i++) {
      const runtime = this.spots.runtimes[i];
      const shadow = this.shadows[i];
      if (!runtime || !shadow) continue;
      if (this.shadowFitted[i] === runtime.shape) continue;
      this.shadowFitted[i] = runtime.shape;

      // **ワールド座標のまま使わないこと。**
      // 影は `runtime.group`（＝隠れ場所の位置に置かれている）の子なので、
      // ワールドの中心 y をそのまま入れると位置が二重に足される。
      // 上の段（y=+1.90）の影が +3.80 に飛んで、画面から消えていた
      // （実測: 接地の暗さ V5 が 6箇所でちょうど 0.00 になった）
      _shadowBox.setFromObject(runtime.shape.group);
      _shadowInverse.copy(runtime.group.matrixWorld).invert();
      _shadowBox.applyMatrix4(_shadowInverse);
      // **芯は本体と同じ大きさ。まわりに `blur` だけ滲ませる**（倍率では隠れる）
      const width = _shadowBox.max.x - _shadowBox.min.x + DROP_SHADOW.blur * 2;
      const height = _shadowBox.max.y - _shadowBox.min.y + DROP_SHADOW.blur * 2;
      const centerY = (_shadowBox.max.y + _shadowBox.min.y) / 2;

      // ==================================================================
      // **上の段と下の段で、見かけの上下がひっくり返る。**
      //
      // 影は隠れ場所より `z` だけ奥にあるので、カメラから見ると中心（y=0.3）へ
      // 寄って見える。上の段（y=+1.90）では下へ、下の段（y=-2.00）では**上へ**。
      // ずらす量を同じにしていたら、下の段では視差が食ってしまい、
      // 影が本体の裏に隠れた（実測: 接地の暗さ V5 が
      // 上の段 20〜28 に対して下の段 0.5〜2.3）。
      // CLAUDE.md「『縁の高さ』と『縁に見える高さ』は違う」と同じ話。
      //
      // だから**見かけの位置で指定して、ローカル座標に逆算する**。
      // ==================================================================
      const depth = camera.position.z / (camera.position.z - DROP_SHADOW.z);
      runtime.group.getWorldPosition(_shadowAt);
      const round = ROUND_SHAPES.has(runtime.shapeKind);
      const offsetY = DROP_SHADOW.offsetY * (round ? DROP_SHADOW.roundOffsetScale : 1);
      const wantWorldY = _shadowAt.y + centerY + offsetY;
      const localY = (wantWorldY - camera.position.y) / depth - _shadowAt.y + camera.position.y;

      shadow.geometry.dispose();
      // 奥にあるぶん小さく見えるので、そのぶん大きく作る
      shadow.geometry = new THREE.PlaneGeometry(width / depth, height / depth);
      // **角のあるものに楕円の影を付けない。** 形が合っていないと
      // 「別のものが後ろに置いてある」ように見える
      const texture = round ? this.shadowTexture : this.shadowRectTexture;
      if (texture) (shadow.material as THREE.MeshBasicMaterial).map = texture;
      shadow.position.set(DROP_SHADOW.offsetX / depth, localY, DROP_SHADOW.z);

      // **空には影を落とさない。** 地平線より上にある隠れ場所の影は、
      // 背景の絵の空の上に灰色のにじみとして乗る（`SKY_SHADOW_FADE`）
      const overSky = this.horizonY !== null && _shadowAt.y + centerY > this.horizonY;
      (shadow.material as THREE.MeshBasicMaterial).opacity = overSky ? SKY_SHADOW_FADE : 1;
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.fitShadows(camera);
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
    // 柱は自分で作ったので自分で捨てる（不変条件8）。
    // material は柱どうしで使い回しているが、`disposeObject3D` が重複を畳む
    for (const support of this.supports) disposeObject3D(support);
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
    this.shadowRectTexture?.dispose();
    this.empty.dispose();
    this.animals.dispose();
    this.spots.dispose();
    disposeObject3D(this.floor);
    // **テクスチャは `AssetLoader` が持っている**ので、板だけ捨てる
    if (this.backdropImage) disposeObject3D(this.backdropImage, { keepTextures: true });
    disposeObject3D(this.group);
  }
}


/**
 * 上の段の隠れ場所を、背景の地面まで支える柱を立てる。
 *
 * ==========================================================================
 * 隠れ場所より**奥**（背板 z=-0.45 より奥）に置くので、中の動物には
 * 一切かからない。もともと地面に近い隠れ場所には立てない（`minGap`）。
 *
 * **見かけの高さで合わせる。** 柱は奥にあるぶんカメラから見て中心へ寄るので、
 * ワールドの y をそのまま使うと地面より手前で終わって見える
 * （落ち影で踏んだのと同じ話）。
 *
 * 色は場面の地の色から取る（`ambient.ground`）ので、絵ごとに馴染む。
 * ==========================================================================
 */
function addSupports(
  runtimes: readonly SpotRuntime[],
  horizonY: number,
  ambient: { sky: THREE.Color; ground: THREE.Color }
): THREE.Mesh[] {
  const made: THREE.Mesh[] = [];
  const color = ambient.ground.clone().multiplyScalar(0.72);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 });
  const depth = 7.2 / (7.2 - SUPPORT.z);

  for (const runtime of runtimes) {
    // **`runtime.group` のワールド行列はまだ入っていない。**
    // ここは場面を組み立てている途中で、`SpotSystem` の group が
    // `SceneRoot.group` に付く前なので、`setFromObject` はローカルの箱を返す
    // （実測: 上の段の隠れ場所なのに下端が -1.56 と出た）。
    // 位置はデータ（`SpotConfig.position`）から取る
    // **吊り下がっているものには柱を立てない。**
    // カーテンは上にレールが描いてあって「掛かっている」と読めるので、
    // 下に台を付けると意味が食い違う（判定も「カーテンは掛かっていると
    // 読める」と書いている）
    if (runtime.shapeKind === 'curtain') continue;
    const spotY = runtime.config.position[1];
    _shadowBox.setFromObject(runtime.shape.group);
    const bottomWorld = spotY + _shadowBox.min.y;
    const gap = bottomWorld - horizonY;
    if (gap < SUPPORT.minGap) continue;

    // 見かけで「隠れ場所の下端」から「地平線」までを埋める高さにする
    const apparent = (y: number): number => (y - 0.3) / depth + 0.3;
    const topLocal = apparent(bottomWorld + 0.06) - spotY;
    const bottomLocal = apparent(horizonY) - spotY;
    const height = topLocal - bottomLocal;
    if (height <= 0) continue;

    const post = new THREE.Mesh(
      new THREE.BoxGeometry(SUPPORT.width, height, 0.18),
      material
    );
    post.name = 'support.post';
    post.position.set(0, (topLocal + bottomLocal) / 2, SUPPORT.z);
    runtime.group.add(post);
    made.push(post);

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(SUPPORT.width * SUPPORT.baseScale, SUPPORT.baseHeight, 0.22),
      material
    );
    base.name = 'support.base';
    base.position.set(0, bottomLocal + SUPPORT.baseHeight / 2, SUPPORT.z);
    runtime.group.add(base);
    made.push(base);
  }
  return made;
}
