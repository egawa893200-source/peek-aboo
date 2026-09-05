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
 *   - ChaseSystem / EmptySpot（§4-5 / §4-6。Phase 3）
 *   - RevealEffect の粒子（Phase 2）
 *   - 場面切替バーと残り3場面（Phase 6）
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
import { DEFAULT_SCENE_ID, findScene } from '../data/scenes';
import type { SpotRuntime, SpotSnapshot } from '../peekaboo/SpotSystem';
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

  private sceneRoot: SceneRoot | null = null;
  private sceneId = DEFAULT_SCENE_ID;
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

    // 上からの光ひとつだけ。
    // **顔と目が見えることが最重要**（§4-4）なので、真上ではなく少し手前から当てる。
    const key = new THREE.DirectionalLight(0xfff3e2, 1.6);
    key.position.set(0.4, 1.2, 1.0);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xdceeff, 0x4a4436, 1.1));

    this.input.onTap((tap) => this.onTap(tap.screenX, tap.screenY));

    this.loop.onUpdate((ctx) => {
      this.quality.sample(this.loop.rawDelta);
      this.renderer.setResolutionScale(this.quality.settings.resolutionScale);
      this.sceneRoot?.update(ctx.dt, this.renderer.camera);
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
  async loadScene(id: string): Promise<void> {
    if (this.building) return;
    this.building = true;
    try {
      const config = findScene(id);
      const next = await SceneRoot.build(config, this.assets);

      // **古いほうを捨ててから足す。** 順番を逆にすると、
      // 一瞬だけ2場面ぶんのリソースが載って、切替のたびに山が出る
      if (this.sceneRoot) {
        this.scene.remove(this.sceneRoot.group);
        this.sceneRoot.dispose();
      }
      this.sceneRoot = next;
      this.sceneId = config.id;
      this.scene.add(next.group);

      // 「ばあ！」は登場の山（0.35秒後）で鳴る。押した瞬間ではない（§4-3）。
      // 連打で呼ばれたときは押した瞬間に鳴る（不変条件2「声とアピールは必ず返す」）。
      next.spots.onVoice(() => this.audio.speak('ばあ！', 'baa'));
      next.spots.onPeak((spot) => this.onPeak(next, spot));
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
  }

  /** E2E と実機確認のためのデバッグ API */
  createDebugApi() {
    return {
      getTapCount: (): number => this.taps,
      getFrameCount: (): number => this.loop.frameCount,
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
    };
  }

  dispose(): void {
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
