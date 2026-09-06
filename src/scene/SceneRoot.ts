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
import { SpotSystem } from '../peekaboo/SpotSystem';
import { createBackdropTexture, createContactShadow, createShadowTexture } from './Backdrop';
import type { SceneConfig } from '../types';

export class SceneRoot {
  readonly group = new THREE.Group();
  readonly spots: SpotSystem;
  readonly animals: AnimalSystem;
  /** モードB（§4-5）のときだけ。モードAでは null */
  readonly chase: ChaseSystem | null;
  /** §4-6。モードAでも空の場所は起きないが、**外さない**（不変条件3b の保険） */
  readonly empty: EmptySpot;

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
    empty: EmptySpot,
    floor: THREE.Mesh,
    backdrop: THREE.Texture | null,
    shadowTexture: THREE.Texture | null,
    shadows: readonly THREE.Mesh[]
  ) {
    this.backdrop = backdrop;
    this.shadowTexture = shadowTexture;
    this.shadows = shadows;
    this.spots = spots;
    this.animals = animals;
    this.chase = chase;
    this.empty = empty;
    this.floor = floor;
    this.group.add(floor);
    this.group.add(spots.group);
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
    const backdrop =
      !background && typeof document !== 'undefined'
        ? createBackdropTexture('#3d5c8c', '#0b1526')
        : null;
    const floorMat = new THREE.MeshStandardMaterial({
      color: backdrop ? 0xffffff : 0x2a3550,
      roughness: 1,
      metalness: 0,
      ...(background ? { map: background } : {}),
      ...(backdrop ? { map: backdrop } : {}),
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), floorMat);
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
    const empty = new EmptySpot(spots);
    spots.onEmpty((spot) => empty.trigger(spot, chase?.getAnswerSpot() ?? null));

    return new SceneRoot(config, spots, animals, chase, empty, floor, backdrop, shadowTexture, shadows);
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
    this.empty.update(dt);
    this.animals.update(dt, this.spots, camera);
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
    this.backdrop?.dispose();
    this.shadowTexture?.dispose();
    this.empty.dispose();
    this.animals.dispose();
    this.spots.dispose();
    disposeObject3D(this.floor);
    disposeObject3D(this.group);
  }
}
