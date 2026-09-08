/**
 * 全体制御（§7-4）
 *
 * --------------------------------------------------------------------------
 * ここに置くのは**配線だけ**。遊びのロジックは `peekaboo/` に置く。
 *
 * 入っているもの:
 *   - Renderer / Loop / Input / Ripple / AudioBus / WakeLock / ParentalGate の配線
 *   - 場面（`SceneRoot`）の生成と破棄
 *   - タップ → 波紋 ＋ 効果音 ＋ 隠れ場所の当たり判定（§4-1）
 *
 * まだ無いもの（設計書 §12 を見ること）:
 *   - RevealEffect の粒子（Phase 2）
 *   - **画面上の場面切替バー**と、そと／うみ（Phase 6）。
 *     いまは `__peekaboo.setScene('nohara')` でしか のはら に行けない
 *
 * **タップの順番を変えないこと。** 波紋と効果音を先に出す。
 * 当たり判定がどう転んでも「押したのに何も起きない」にはならない（不変条件1）。
 * --------------------------------------------------------------------------
 */

import * as THREE from 'three';

import { AssetLoader } from '../core/AssetLoader';
import { AudioBus } from '../core/AudioBus';
import { Input } from '../core/Input';
import { Loop } from '../core/Loop';
import { QualityManager } from '../core/QualityManager';
import { Renderer } from '../core/Renderer';
import { ScreenProjector } from '../core/ScreenProjector';
import { WakeLock } from '../core/WakeLock';
import { LIGHTS, SCENE_LIGHT_TINT, SUN_FOLLOW } from '../data/look';
import { DEFAULT_SCENE_ID, findScene, SCENES } from '../data/scenes';
import type { SpotRuntime, SpotSnapshot } from '../peekaboo/SpotSystem';
import { Surprise } from '../peekaboo/Surprise';
import { SceneRoot } from '../scene/SceneRoot';
import { ParentalGate } from '../ui/ParentalGate';
import { Ripple } from '../ui/Ripple';

export interface AppElements {
  backgroundLayer: HTMLElement;
  webglLayer: HTMLElement;
  overlayLayer: HTMLElement;
  ripples: HTMLElement;
  uiRoot: HTMLElement;
  loadingRoot: HTMLElement;
}

export class App {
  private readonly renderer: Renderer;
  private readonly loop = new Loop();
  private readonly input: Input;
  private readonly ripple: Ripple;
  private readonly audio = new AudioBus();
  private readonly wakeLock = new WakeLock();
  private readonly quality = new QualityManager();
  private readonly assets = new AssetLoader();
  private readonly projector: ScreenProjector;
  private readonly gate: ParentalGate;
  private readonly scene = new THREE.Scene();
  /**
   * 場面ごとに色を変える光。**絵そのものには当たらない**
   * （背景も動物も `MeshBasicMaterial`）ので、色が変わるのは隠れ場所と飾りだけ。
   */
  private readonly key: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  /** 白い光。場面の色へ寄せるときの元にする */
  private readonly keyBase = new THREE.Color(LIGHTS.key.color);
  private readonly hemiSkyBase = new THREE.Color(LIGHTS.hemi.sky);
  private readonly hemiGroundBase = new THREE.Color(LIGHTS.hemi.ground);
  /**
   * §6-3 のサプライズ。**場面をまたいで使い回す**（カメラの子なので、
   * 場面を作り直すたびに付け替える必要がない）
   */
  private readonly surprise = new Surprise();

  private sceneRoot: SceneRoot | null = null;
  private sceneId = DEFAULT_SCENE_ID;
  /** モードB の乱数の種。E2E から固定して、行き先の抽選を再現する */
  private chaseSeed: number | undefined;
  /** 場面の作り直しが走っている間は次の作り直しを受けない（二重生成でリークする） */
  private building = false;

  /** 受理したタップの総数（E2E から見る） */
  private taps = 0;
  /** 隠れ場所に当たったタップの数。当たらなかったぶんは波紋と近くの揺れで返す */
  private hits = 0;

  constructor(private readonly elements: AppElements) {
    this.renderer = new Renderer(elements.webglLayer);
    // **`document.body` に付けること。** `#overlay-layer` は
    // `pointer-events: none`（子要素で個別に有効化する）なので、
    // そこに付けるとタップが1度もハンドラに届かない。
    // 実測: overlay-layer に付けた版は、画面のどこを押しても
    // `getTapCount()` が 0 のままだった（不変条件1 が丸ごと死ぬ）。
    this.input = new Input(document.body, this.renderer.camera);
    this.ripple = new Ripple(elements.ripples);
    this.projector = new ScreenProjector(document.body, this.renderer.camera);
    this.gate = new ParentalGate(elements.uiRoot);
    this.gate.onUnlock(() => {
      // TODO(Phase 8): 設定パネルを開く。
    });

    // 光。**数値は `data/look.ts` に外出ししてある**（見た目の調整は
    // 「1つ変えて撮って測る」を繰り返すので、値が散らばると追えなくなる）。
    // **顔と目が見えることが最重要**（§4-4）なので、真上ではなく少し手前から当てる。
    this.key = new THREE.DirectionalLight(LIGHTS.key.color, LIGHTS.key.intensity);
    this.key.position.set(...LIGHTS.key.position);
    this.scene.add(this.key);
    this.hemi = new THREE.HemisphereLight(LIGHTS.hemi.sky, LIGHTS.hemi.ground, LIGHTS.hemi.intensity);
    this.scene.add(this.hemi);
    // 補助光。主光と反対側から弱く当てて、右を向いた側面が黒帯にならないようにする
    const fill = new THREE.DirectionalLight(LIGHTS.fill.color, LIGHTS.fill.intensity);
    fill.position.set(...LIGHTS.fill.position);
    this.scene.add(fill);

    // §6-3 のサプライズは**カメラの子**にする。カメラ空間に置けば、
    // 画面のどこにどれだけの大きさで出るかが素直に決まる。
    // **カメラを scene に入れないと、その子は描かれない**（three の仕様）
    this.scene.add(this.renderer.camera);
    this.renderer.camera.add(this.surprise.group);
    this.surprise.onVoice(() => this.audio.playVoice('baa'));

    this.input.onTap((tap) => this.onTap(tap.screenX, tap.screenY));

    this.loop.onUpdate((ctx) => {
      this.quality.sample(this.loop.rawDelta);
      this.renderer.setResolutionScale(this.quality.settings.resolutionScale);
      this.sceneRoot?.update(ctx.dt, this.renderer.camera);
      this.surprise.update(ctx.dt, this.renderer.camera);
    });
    this.loop.onRender(() => this.renderer.render(this.scene));
  }

  async start(): Promise<void> {
    // 先にループを回す。場面の構築を待たせない（§10-1「3秒以内に何か表示」）。
    // 構築が終わる前に押されても、波紋と効果音は返る（不変条件1）。
    this.loop.start();
    void this.wakeLock.request();
    await this.loadScene(this.sceneId);
  }

  /** 場面を差し替える。前の場面は必ず捨てる（不変条件8） */
  async loadScene(id: string, seed?: number): Promise<void> {
    if (this.building) return;
    this.building = true;
    try {
      if (seed !== undefined) this.chaseSeed = seed;
      const config = findScene(id);
      const next = await SceneRoot.build(config, this.assets, {
        ...(this.chaseSeed !== undefined ? { chaseSeed: this.chaseSeed } : {}),
      });

      // **古いほうを捨ててから足す。** 順番を逆にすると、
      // 一瞬だけ2場面ぶんのリソースが載って、切替のたびに山が出る
      if (this.sceneRoot) {
        this.scene.remove(this.sceneRoot.group);
        this.sceneRoot.dispose();
      }
      this.sceneRoot = next;
      this.sceneId = config.id;
      this.scene.add(next.group);

      // 場面の光の色を、背景の絵から読んだ空と地の色へ寄せる。
      // **絵には当たらない**（背景も動物も `MeshBasicMaterial`）ので、
      // 色が変わるのは隠れ場所と手続き生成の飾りだけ。
      // 白いままだと、うみ（青い水中）でも きょうりゅう（橙の夕景）でも
      // 隠れ場所に同じ光が当たり、絵と「別の場所のもの」に見えていた
      this.hemi.color.copy(this.hemiSkyBase).lerp(next.ambient.sky, SCENE_LIGHT_TINT);
      this.hemi.groundColor.copy(this.hemiGroundBase).lerp(next.ambient.ground, SCENE_LIGHT_TINT);
      // 主光の向きを、背景の絵のいちばん明るいところに寄せる。
      // きょうりゅう の夕日は画面の左下にあるのに、どの場面でも左上から
      // 当てていて、判定に「太陽と反対向きに陰を持っている」と言われた。
      // **下からは当てない**（`SUN_FOLLOW.minUp`）
      if (next.sun) {
        const wantX = (next.sun.u - 0.5) * 2;
        const wantY = Math.max(SUN_FOLLOW.minUp, (0.5 - next.sun.v) * 2);
        this.key.position.set(
          LIGHTS.key.position[0] * (1 - SUN_FOLLOW.amount) + wantX * 1.4 * SUN_FOLLOW.amount,
          LIGHTS.key.position[1] * (1 - SUN_FOLLOW.amount) + wantY * 1.4 * SUN_FOLLOW.amount,
          LIGHTS.key.position[2]
        );
      } else {
        this.key.position.set(...LIGHTS.key.position);
      }

      // 主光は**半分だけ**寄せる。ここまで染めると陰影の向きが読めなくなる
      this.key.color.copy(this.keyBase).lerp(next.ambient.sky, SCENE_LIGHT_TINT * 0.5);

      // 「ばあっ！」は登場の山（0.35秒後）で鳴る。押した瞬間ではない（§4-3）。
      // 連打で呼ばれたときは押した瞬間に鳴る（不変条件2「声とアピールは必ず返す」）。
      //
      // **`speak()` ではなく `playVoice()` を使うこと。**
      // `speak()` は読み上げ用の入口で最短間隔 1.25秒 の制限があり、
      // 続けて別の隠れ場所を押すと声が落ちて「ばあっ！が返らない回」ができる。
      // §6-1: 声のピッチを ±5% 振る。毎回まったく同じ声にしない
      next.spots.onVoice((spot) => this.audio.playVoice('baa', spot.voiceVar));
      next.spots.onPeak((spot) => this.onPeak(next, spot));
      // §6-3。絵が無い動物は出さない（不変条件7）
      this.surprise.setTextures(next.cutouts);

      // ふたが開きはじめたら、形に合った音を返す。
      // くさむらは葉をかき分ける「ワサワサ」（§4-5 / §4-6）
      next.spots.onOpen((spot) => {
        if (spot.config.kind === 'bush') this.audio.playOneShot('rustle');
      });

      // §4-6。正解の場所が揺れはじめたら「こっちこっち〜」（2026-09-06）。
      // **揺れと同時に鳴らすこと。** ずれると、どこが揺れたのか結び付かない
      next.empty.onHint(() => this.audio.playVoice('kocchi'));

      // §4-6。**落胆の音にしない。** とぼけた「あれ？」。
      // ブザー・×印・暗転は使わない（外れを「失敗」にしない）。
      // ここで `speak('あれ？','baa')` と書くと、**録音してある「ばあっ！」が鳴る**
      // （`speak` は第2引数のクリップを鳴らすので、第1引数の文字は読まれない）。
      // 空振りなのに「ばあっ！」と言うのは、いちばん紛らわしい間違いだった
      next.empty.onVoice(() => this.audio.playOneShot('huh'));
      next.empty.onPuff(() => this.audio.playOneShot('bubble'));

      // ぴょんぴょん（§4-5）。1跳ねごとに1回
      next.chase?.onHop(() => this.audio.playOneShot('hop'));

      // 場面ごとの味つけ（2026-09-07）。音は App に集める
      // （**`Flavor` の中で音を鳴らさない**）
      next.flavor.onFootstep(() => this.audio.playOneShot('thud'));
      // みんなで鳴く（§6 の〈中〉）。場所ごとに高さを変える。
      // **「ばあっ！」を使わないこと。** まだ隠れているのに「ばあっ」と
      // 言うのは、いちばん紛らわしい間違いだった（2026-09-07 に実機で指摘）
      next.flavor.onCall((_spot, pitch) => this.audio.playOneShot('peep', pitch));
      // もう1匹（§6 の〈大〉）。**声は出さない。**
      // 押していないのに「ばあっ！」と鳴ると、どれが自分の押した結果か
      // 分からなくなる。草をかき分ける音だけ返す
      next.flavor.onCameo(() => this.audio.playOneShot('rustle'));
      // 順番待ちで出せなかったとき（2026-09-07 の「1体ずつ」）。
      // **無反応にしない。** 波紋と「ぽん」は既に返しているので、
      // ここは草をかき分ける音だけ足す（「いま順番だよ」の合図）
      next.spots.onBusy(() => this.audio.playOneShot('rustle'));
    } finally {
      this.building = false;
    }
  }

  /**
   * タップの処理。
   *
   * **順番が大事。** 波紋と効果音を先に出す。当たり判定より先に出しておけば、
   * 判定がどう転んでも「押したのに何も起きない」にはならない（不変条件1）。
   */
  private onTap(screenX: number, screenY: number): void {
    this.taps++;
    this.ripple.spawn(screenX, screenY);

    // 音は初期ミュート。最初のタップで解禁してフェードインさせる（不変条件9）
    this.audio.unlock();
    // §4-3 の「0.00s タップ地点に反応（波紋・小さな音）」。押した実感
    this.audio.playOneShot('plop');

    const spots = this.sceneRoot?.spots;
    if (!spots) return;

    // あぶく（§6 の〈中〉）。**隠れ場所より先に見ない。**
    // 割れるかどうかに関わらず、このあと隠れ場所の判定は必ず走る
    // （あぶくのせいで「押したのに動物が出ない」を作らない）
    this.sceneRoot?.flavor.tap(screenX, screenY, this.projector);

    // 当たり判定は 3D のレイではなく画面座標で（§7-3）
    const hit = spots.pick(screenX, screenY, this.projector);
    if (hit) {
      this.hits++;
      spots.tap(hit);
      return;
    }
    // 外した。**それでも近くの隠れ場所を揺らす**
    //（不変条件1「それ以外でも波紋・音・近くの動物の反応が出る」）。
    // 状態は変えない。押していない場所が開いたら、因果が壊れて見える
    spots.nudgeNearest(screenX, screenY, this.projector);
  }

  /** 登場の山（§4-4）。ここだけが光る演出で、回数は AnimalSystem が抑える */
  private onPeak(root: SceneRoot, spot: SpotRuntime): void {
    root.animals.requestFlash(spot);
    this.audio.playOneShot('bubble');
    // §6-3。**外れても何も止めない。** いつもどおり動物は出ている
    const animalId = root.animals.getSlot(spot.config.id)?.config.id;
    if (animalId) this.surprise.maybeTrigger(animalId);
  }

  /** E2E と実機確認のためのデバッグ API */
  createDebugApi() {
    return {
      getTapCount: (): number => this.taps,
      /** §6-2。いまその隠れ場所に居る動物の id */
      getAnimalAt: (spotId: string): string | null =>
        this.sceneRoot?.animals.getSlot(spotId)?.config.id ?? null,
      /** §6-2。抽選した回数と、実際に入れ替えた回数 */
      getShuffle: (): { rolled: number; swapped: number } => ({
        rolled: this.sceneRoot?.shuffle?.getRolledCount() ?? 0,
        swapped: this.sceneRoot?.animals.getSwapCount() ?? 0,
      }),
      /** §6-3 のサプライズ。抽選した回数と、実際に出した回数 */
      getSurprise: (): {
        rolled: number;
        fired: number;
        running: boolean;
        direction: string;
      } => ({
        rolled: this.surprise.getRolledCount(),
        fired: this.surprise.getFiredCount(),
        running: this.surprise.isRunning(),
        direction: this.surprise.getDirection(),
      }),
      /** 場面ごとの味つけ（2026-09-07）。実測用 */
      getFlavor: (): {
        footsteps: number;
        crossings: number;
        quaking: boolean;
        maxTiltRad: number;
        landings: number;
        perchedSpotId: string | null;
        bubbles: { count: number; popped: number };
        chorus: { runs: number; running: boolean };
        footprints: number;
        leftovers: { alive: number; total: number };
        shadows: number;
        shadowSpotId: string | null;
        cameos: number;
        cameoSpotId: string | null;
        cameoTaps: number;
      } | null => {
        const flavor = this.sceneRoot?.flavor;
        if (!flavor) return null;
        return {
          footsteps: flavor.getFootstepCount(),
          crossings: flavor.getCrossingCount(),
          quaking: flavor.isQuaking(),
          maxTiltRad: flavor.getMaxTiltRad(),
          landings: flavor.getLandingCount(),
          perchedSpotId: flavor.getPerchedSpotId(),
          bubbles: flavor.getBubbles(),
          chorus: flavor.getChorus(),
          footprints: flavor.getFootprintCount(),
          leftovers: flavor.getLeftovers(),
          shadows: flavor.getShadowCount(),
          shadowSpotId: flavor.getShadowSpotId(),
          cameos: flavor.getCameoCount(),
          cameoSpotId: flavor.getCameoSpotId(),
          cameoTaps: flavor.getCameoTapCount(),
        };
      },
      getFrameCount: (): number => this.loop.frameCount,
      /**
       * 更新が進めた時間（秒）。**壁時計ではない**（`Loop.simulatedSeconds`）。
       * §4-3 / §4-5 のタイミング表を検査するときは必ずこちらを使う。
       * 実時間で測ると、ソフトウェア描画の遅さが合否に混ざる（§10-2）。
       */
      getSimulatedSeconds: (): number => this.loop.simulatedSeconds,
      getQualityLevel: (): number => this.quality.currentLevel,
      /** タップを注入する（実際の pointerdown と同じ経路を通る） */
      tap: (x: number, y: number): void => this.input.simulateTap(x, y),
      /** three が持っているリソース数。場面切替でのリークを見る（不変条件8） */
      getMemory: () => ({ ...this.renderer.renderer.info.memory }),
      getTextureBytes: () => this.assets.estimateTextureBytes(),
      /** ワールド座標が画面のどこに来るか（当たり判定のテスト用） */
      projectToScreen: (x: number, y: number, z: number) => {
        const out = { x: 0, y: 0 };
        return this.projector.project(new THREE.Vector3(x, y, z), out) ? out : null;
      },

      /* --- ここから Phase 1 で足したぶん ----------------------------------- */

      /** 場面の構築が終わったか。**E2E はここを待つこと**（`loop.start()` では足りない） */
      isReady: (): boolean => this.sceneRoot !== null,
      getSceneId: (): string => this.sceneId,
      getSceneIds: (): string[] => SCENES.map((s) => s.id),
      /**
       * 場面を切り替える。**画面上の切替バーは Phase 6。**
       * いまは のはら（§4-5 モードB）をここからしか開けない。
       * `seed` を渡すと行き先の抽選が再現できる（E2E 用）。
       */
      setScene: (id: string, seed?: number): Promise<void> => this.loadScene(id, seed),
      /**
       * **見た目の採点用（`npm run visual`）。** 場面を読み込み、更新時計を 0 に
       * 戻してから、ちょうど `seconds` ぶんだけ進めて1枚描いて止める。
       *
       * rAF を回したまま撮ると、GPU の速さで何ステップ進んだかが変わって
       * 同じコードでも絵が変わる。**採点は「2回撮ってバイト単位で一致」を
       * 前提にしている**ので、ここで壁時計を切り離す（`Loop.stepExact`）。
       */
      freezeAt: async (id: string, seed: number, seconds: number): Promise<void> => {
        this.loop.pause();
        await this.loadScene(id, seed);
        this.loop.resetClock();
        this.loop.stepExact(Math.round(seconds * 60));
      },
      /**
       * 隠れ場所（と、その中の動物・接地影）だけを消してもう1枚描く。
       * **見た目の採点用。** 2枚の差が、そのまま「隠れ場所の画素」になる。
       *
       * 位置と半径から矩形を推し量ると、隣とぶつかったり背景を巻き込んだりして
       * 数字が動く。**消して撮る**ほうが、輪郭ちょうどで切り出せる。
       */
      setSpotsVisible: (visible: boolean): void => {
        if (this.sceneRoot) this.sceneRoot.spots.group.visible = visible;
        this.loop.stepExact(0);
      },
      /**
       * 接地影だけを消してもう1枚描く。**見た目の採点用。**
       *
       * 影は隠れ場所の子なので、`setSpotsVisible(false)` では影も一緒に消える。
       * つまり「隠れ場所の画素」に影のぼんやりした裾まで入ってしまい、
       * 内部の陰影を測る数字が影のグラデーションで水増しされる。
       * 影を消した1枚を別に撮って、**本体だけ**を切り出す。
       */
      setShadowsVisible: (visible: boolean): void => {
        // **ハローも一緒に消すこと。** 消し忘れると、輪郭のすぐ外の暗がりが
        // 「隠れ場所の画素」として切り出され、輪郭の明度差が壊れる
        // （実測: V1 が 29箇所中 21箇所で 30 台 → 6〜7 に落ちた）
        this.sceneRoot?.spots.group.traverse((o) => {
          if (o.name === 'contactShadow' || o.name === 'edgeHalo') o.visible = visible;
        });
        this.loop.stepExact(0);
      },
      /**
       * 隠れ場所の状態と、画面上の位置・**実際に使っている当たり半径**。
       * 当たり判定どうしの距離はここから測る（§3-2）。
       */
      getSpots: (): SpotSnapshot[] => this.sceneRoot?.spots.snapshot(this.projector) ?? [],
      /** 隠れ場所に当たったタップ数。`getTapCount()` との差が「外したタップ」 */
      getHitCount: (): number => this.hits,
      /** 応答を返したタップの数。当たったタップ数と必ず一致する（不変条件1・2） */
      getSpotResponseCount: (): number => this.sceneRoot?.spots.getResponseCount() ?? 0,
      /** 縁からどれだけ出ているかの実測（不変条件3） */
      getExposure: (spotId: string) => {
        const spot = this.sceneRoot?.spots.find(spotId);
        if (!spot || !this.sceneRoot) return null;
        return this.sceneRoot.animals.getExposure(spot);
      },
      /** 隠れ場所の開口部と動物の幅（§4-2 の 0.86倍） */
      getFit: (spotId: string) => {
        const spot = this.sceneRoot?.spots.find(spotId);
        if (!spot || !this.sceneRoot) return null;
        return this.sceneRoot.animals.getFit(spot);
      },
      /** 光った回数。1秒に3回を超えないこと（不変条件6） */
      getFlashCount: (): number => this.sceneRoot?.animals.getFlashCount() ?? 0,
      /**
       * GPU に依存しない描画量（§10-2）。
       * **fps は合否にしない。** 見るのは三角形数と draw call。
       */
      getRenderInfo: () => {
        const info = this.renderer.renderer.info;
        return {
          triangles: info.render.triangles,
          calls: info.render.calls,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
        };
      },
      /** 場面を作り直す。往復させて `getMemory()` が増えないことを見る（不変条件8） */
      reloadScene: (): Promise<void> => this.loadScene(this.sceneId),

      /* --- §4-5 移動モード / §4-6 空の隠れ場所（Phase 3） ------------------ */

      /** 移動モードの様子。モードAの場面では null */
      getChase: () => {
        const chase = this.sceneRoot?.chase;
        if (!chase) return null;
        return {
          phase: chase.getPhase(),
          moving: chase.isMoving(),
          answerSpotId: chase.getAnswerSpot().config.id,
          history: [...chase.getHistory()],
          laps: chase.getLaps(),
          tapsWhileMoving: chase.getTapsWhileMoving(),
        };
      },
      /** §4-6 の空振り。押した回数と、走りきったシーケンスの数 */
      getEmpty: () => {
        const empty = this.sceneRoot?.empty;
        if (!empty) return null;
        return {
          taps: empty.getTapCount(),
          started: empty.getStartedCount(),
          finished: empty.getFinishedCount(),
        };
      },
    };
  }

  dispose(): void {
    this.surprise.dispose();
    this.loop.dispose();
    this.input.dispose();
    this.ripple.dispose();
    this.gate.dispose();
    this.audio.dispose();
    this.wakeLock.dispose();
    if (this.sceneRoot) {
      this.scene.remove(this.sceneRoot.group);
      this.sceneRoot.dispose();
      this.sceneRoot = null;
    }
    this.assets.dispose();
    this.renderer.dispose();
    void this.elements;
  }
}
