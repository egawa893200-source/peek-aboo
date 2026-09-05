/**
 * 全体制御（§7-4）
 *
 * --------------------------------------------------------------------------
 * **ここは Phase 1 の「骨組み」まで**しか入っていない。
 *
 * 入っているもの:
 *   - Renderer / Loop / Input / Ripple / AudioBus / WakeLock / ParentalGate の配線
 *   - タップ → 波紋 ＋ 「ばあ！」の声（これだけで不変条件1 を満たす）
 *   - 空のシーンと、上からの光ひとつ
 *
 * まだ無いもの（Phase 1 の残り。設計書 §12 を見ること）:
 *   - SpotSystem（隠れ場所の状態遷移。§4-1）
 *   - AnimalSystem（動物の生成と登場アニメ。§4-3 / §4-4）
 *   - SceneRoot / data/scenes.ts（4場面 × 隠れ場所4箇所。§5-3）
 *
 * **配線を先に通してあるのは、「押しても何も起きない」状態を1秒も作らないため。**
 * 隠れ場所を足す前から、どこを押しても波紋と声が返る。
 * ここを壊さずに機能を足していくこと（不変条件1）。
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

  /** 受理したタップの総数（E2E から見る） */
  private taps = 0;

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
      void ctx; // TODO(Phase 1): SpotSystem / AnimalSystem をここで更新する
    });
    this.loop.onRender(() => this.renderer.render(this.scene));
  }

  async start(): Promise<void> {
    this.loop.start();
    void this.wakeLock.request();
  }

  /**
   * タップの処理。
   *
   * **順番が大事。** 波紋を先に出す。隠れ場所の判定より先に出しておけば、
   * 判定がどう転んでも「押したのに何も起きない」にはならない（不変条件1）。
   */
  private onTap(screenX: number, screenY: number): void {
    this.taps++;
    this.ripple.spawn(screenX, screenY);

    // 音は初期ミュート。最初のタップで解禁してフェードインさせる（不変条件9）
    this.audio.unlock();

    // TODO(Phase 1): ここで SpotSystem に当たり判定を渡す。
    //   const hit = this.spots.pick(screenX, screenY, this.projector);
    //   hit ? hit.tap() : /* 外れ。§4-6 の空の場所と同じ扱いにはしない */;
    // いまは配線の確認として、必ず声を返す。
    this.audio.speak('ばあ！', 'baa');
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
    };
  }

  dispose(): void {
    this.loop.dispose();
    this.input.dispose();
    this.ripple.dispose();
    this.gate.dispose();
    this.audio.dispose();
    this.wakeLock.dispose();
    this.assets.dispose();
    this.renderer.dispose();
    // TODO(Phase 5): 場面を捨てるときは geometry / material / texture を
    // 1つ残らず dispose すること（不変条件8）。みずのなかでは
    // ここを1つ漏らすたびに切替のたびにメモリが増えていった。
    void this.elements;
  }
}
