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
import { AnimalSystem } from '../peekaboo/AnimalSystem';
import { disposeObject3D } from '../peekaboo/SpotShapes';
import { SpotSystem } from '../peekaboo/SpotSystem';
import type { SceneConfig } from '../types';

export class SceneRoot {
  readonly group = new THREE.Group();
  readonly spots: SpotSystem;
  readonly animals: AnimalSystem;

  /** 床。隠れ場所が宙に浮いて見えないように敷くだけ */
  private readonly floor: THREE.Mesh;

  private constructor(
    readonly config: SceneConfig,
    spots: SpotSystem,
    animals: AnimalSystem,
    floor: THREE.Mesh
  ) {
    this.spots = spots;
    this.animals = animals;
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
  static async build(config: SceneConfig, assets: AssetLoader): Promise<SceneRoot> {
    const spots = new SpotSystem(config.spots);

    // 素材のURLは必ず `resolveAssetUrl()` を通す（`AssetLoader` の中で通している）。
    // いまは背景も動物も null なので何も読まないが、**経路だけ先に通しておく**。
    // 通っていないことは、素材を置いた日まで気づけない（CLAUDE.md）。
    const background = await assets.loadOptionalTexture(config.backgroundUrl);

    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x2a3550,
      roughness: 1,
      metalness: 0,
      ...(background ? { map: background } : {}),
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), floorMat);
    // 隠れ場所より奥に、少しだけ手前に倒して敷く。
    // 真後ろの垂直な板にすると、隠れ場所との前後関係が読めない
    floor.position.set(0, 0, -1.6);
    floor.rotation.x = -0.12;

    const animals = new AnimalSystem(spots);
    return new SceneRoot(config, spots, animals, floor);
  }

  update(dt: number, camera: THREE.Camera): void {
    this.spots.update(dt);
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
    this.animals.dispose();
    this.spots.dispose();
    disposeObject3D(this.floor);
    disposeObject3D(this.group);
  }
}
