/**
 * WebGLRenderer（§7-4）
 *
 * --------------------------------------------------------------------------
 * これは「みずのなか」からのコピーではなく、**同じ判断だけを引き継いだ短い版**。
 * あちらの Renderer は 258行あるが、その大半は水中用のポスト処理
 * （Bloom / 被写界深度 / 色収差 / 周辺減光 / グレイン）の組み立てで、
 * このアプリには要らない。`postprocessing` への依存も外している。
 *
 * **ポスト処理を足すことにしたら、必ず下の「罠」を読むこと。**
 * --------------------------------------------------------------------------
 */

import * as THREE from 'three';

/** devicePixelRatio は最大 2.0 でクランプ（それ以上は見た目が変わらず重いだけ） */
const MAX_PIXEL_RATIO = 2.0;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLCanvasElement;

  /** 品質を下げるときの解像度スケール（1.0 / 0.85 / 0.75） */
  private resolutionScale = 1.0;
  private basePixelRatio = 1.0;
  private width = 1;
  private height = 1;

  private readonly onResize = () => this.resize();

  constructor(private readonly container: HTMLElement) {
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    // 高DPIのスマホでは MSAA が高くつくので、DPR が十分あるときは切る。
    //
    // **罠（みずのなかで実測）**: ここの `antialias` は**キャンバスにしか効かない**。
    // `EffectComposer` を挟むとシーンはレンダーターゲットに描かれるので、
    // composer 側に `{ multisampling: 4 }` を渡さないと、どの端末でも
    // ジャギーのままになる。輪郭が1画素で切り替わって「切り絵」に見えていた
    // 直接の原因がこれだった。ポスト処理を足すときは同じ条件
    // （`basePixelRatio < 1.5` のときだけ 4）で composer にも渡すこと。
    const wantsAntialias = this.basePixelRatio < 1.5;

    this.renderer = new THREE.WebGLRenderer({
      antialias: wantsAntialias,
      // 背景を実写写真の <img> や CSS に重ねられるように透過を残す（§5-1 backgroundUrl）
      alpha: true,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      // iOS Safari で preserveDrawingBuffer を有効にすると重いので必ず false
      preserveDrawingBuffer: false,
    });

    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // トーンマッピング。
    //
    // ACESFilmic は映画向けのカーブなので、彩度の高い色を大きく退色させる。
    // みずのなかでは、体表テクスチャの彩度が 0.70 あるクマノミが画面では
    // 淡いサーモンピンクにしか見えず、「色のついていない魚がいる」と言われた。
    // Neutral（Khronos PBR Neutral）は白飛びのロールオフを残したまま
    // 色相と彩度を保つ。**動物を見分けるのは色と輪郭**なので、ここは重要。
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // 影は最初から切っておく。1歳半に効くのは影ではなく「顔が見えること」で、
    // shadowMap はスマホでいちばん高くつく（必要になってから入れる）。
    this.renderer.shadowMap.enabled = false;

    // draw call と三角形数を1フレーム分の合計として数える（GPU非依存の指標）。
    // 既定（autoReset = true）だと three が render() のたびに数え直すので、
    // 最後のパスの数字だけが残って無意味になる。フレームの頭で自分で reset する。
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 0);

    this.domElement = this.renderer.domElement;
    this.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(this.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60);
    this.camera.position.set(0, 0.3, 7.2);
    this.camera.lookAt(0, 0, 0);

    this.resize();
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('orientationchange', this.onResize, { passive: true });
  }

  /** 解像度スケールを段階的に下げる（QualityManager が呼ぶ） */
  setResolutionScale(scale: number): void {
    const clamped = Math.max(0.5, Math.min(1, scale));
    if (Math.abs(clamped - this.resolutionScale) < 0.01) return;
    this.resolutionScale = clamped;
    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    this.resize();
  }

  getResolutionScale(): number {
    return this.resolutionScale;
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (w === this.width && h === this.height) {
      // ピクセル比だけ変わった場合も反映する
      this.renderer.setSize(w, h, false);
      return;
    }
    this.width = w;
    this.height = h;
    this.camera.aspect = w / Math.max(1, h);
    // 縦画面では画角を少し広げて、隠れ場所4箇所が画面に収まるようにする
    this.camera.fov = this.camera.aspect < 1 ? 66 : 55;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  render(scene: THREE.Scene): void {
    this.renderer.info.reset();
    this.renderer.render(scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.renderer.dispose();
    this.domElement.remove();
  }
}
