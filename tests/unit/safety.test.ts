/**
 * 不変条件（設計書 §2）を数値で押さえるテスト。
 *
 * **このファイルが落ちたら、設計書ではなく実装を直すこと。**
 * ここは「実装が正」の例外で、設計書 §2 が正。
 *
 * ここに置くのは「壊れても静かに壊れる」もの。
 * 目で見て気づけないから数値にする。
 *
 * --------------------------------------------------------------------------
 * みずのなかでの実例（不変条件2 が生まれた理由）:
 *   貝が開閉中のタップで向きを反転していたため、60Hz で連打すると
 *   0.45秒の開閉が一度も完了せず、開き量の最大が 0.037（1回押しなら 1.0）だった。
 *   実機で「触っても反応しない」と報告された。
 *   **「連打しても壊れない」は「連打しても動く」まで確かめること。**
 *
 * `it.todo` のまま残してあるものは、Phase 3（移動モード §4-5 / §4-6）と、
 * DOM が要るので Playwright 側にあるもの。**消さないこと。**
 * --------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { ANIMALS } from '../../src/data/animals';
import { CUTOUT_MASKS, CUTOUT_SIZES } from '../../src/data/cutoutSizes';
import type { SceneConfig } from '../../src/types';
import { SpotShuffle, SWAP_CHANCE } from '../../src/peekaboo/SpotShuffle';
import {
  Surprise,
  SURPRISE_CHANCE,
  SURPRISE_TOTAL_SEC,
  type SurpriseDirection,
} from '../../src/peekaboo/Surprise';

/** サプライズの最短間隔を必ず跨ぐ長さ。**間隔の制限ではなく抽選を測る**ため */
const MIN_GAP_FOR_TEST = 3.0;

/** サプライズが大きさを決めるのに使うカメラ。実機と同じ画角 */
function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(66, 0.49, 0.05, 60);
  c.position.set(0, 0.3, 7.2);
  c.updateMatrixWorld(true);
  return c;
}
import { findScene, SCENES } from '../../src/data/scenes';
import {
  BUBBLE_COUNT,
  CAMEO_EVERY_SEC,
  CAMEO_TOTAL_SEC,
  CHORUS_EVERY_SEC,
  CROSS_GAP_SEC,
  CROSS_SEC,
  CROSS_X,
  Flavor,
  FOOTPRINT_MAX,
  PERCH_SEC,
  FOOTSTEP_AT_SEC,
  maxSpotTiltRad,
  PROP_COUNT,
  QUAKE_SEC,
  SHADOW_EVERY_SEC,
  WATER_AMP2_RAD,
  WATER_AMP_RAD,
  WIND_AMP_RAD,
  WOBBLE_AMP_RAD,
} from '../../src/scene/Flavor';
import {
  AnimalSystem,
  EXPECTED_HINT_EXPOSURE,
  FLASH_MIN_INTERVAL_SEC,
  HIDDEN_SINK,
} from '../../src/peekaboo/AnimalSystem';
import {
  AIM_SEC,
  BURROW_SEC,
  CHASE_MOVE_SEC,
  ChaseSystem,
  HOP_SEC,
  LOOK_SEC,
} from '../../src/peekaboo/ChaseSystem';
import {
  EMPTY_HINT_AT_SEC,
  EMPTY_TOTAL_SEC,
  EmptySpot,
} from '../../src/peekaboo/EmptySpot';
import {
  APPEAR_DELAY_SEC,
  HIDE_DUR_SEC,
  OUT_IDLE_SEC,
  CALL_DECAY_SEC,
  CHASE_OUT_IDLE_SEC,
  PEAK_AT_SEC,
  SIZE_VAR,
  SPEED_VAR,
  VOICE_VAR,
  SpotSystem,
  type SpotHitTester,
  type SpotRuntime,
} from '../../src/peekaboo/SpotSystem';

/** `Loop` と同じ固定タイムステップ。実機と同じ刻みで回す */
const DT = 1 / 60;

const OUCHI = SCENES[0];

interface Rig {
  spots: SpotSystem;
  animals: AnimalSystem;
  camera: THREE.PerspectiveCamera;
  /** n 秒ぶん、固定タイムステップで進める */
  advance(seconds: number, onFrame?: (frame: number) => void): void;
}

function rig(): Rig {
  const spots = new SpotSystem(OUCHI.spots, undefined, 12345);
  const animals = new AnimalSystem(spots, false);
  const camera = new THREE.PerspectiveCamera(66, 0.45, 0.05, 60);
  camera.position.set(0, 0.3, 7.2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    spots,
    animals,
    camera,
    advance(seconds, onFrame) {
      const frames = Math.round(seconds / DT);
      for (let i = 0; i < frames; i++) {
        onFrame?.(i);
        spots.update(DT);
        animals.update(DT, spots, camera);
      }
    },
  };
}

/**
 * 画面座標のニセ判定器。
 *
 * **実物の `ScreenProjector` は `HTMLElement` を要求するので node では作れない。**
 * ここで見たいのは「隣と重ならないように半径を縮める計算」なので、
 * 投影は 1ワールド = 100px の素直な写像にしてある。
 * 本物のカメラ行列を通した実測は E2E 側（`__peekaboo.getSpots()`）で見る。
 */
function fakeTester(scale = 100): SpotHitTester {
  return {
    project(world, out) {
      out.x = 206 + world.x * scale;
      out.y = 458 - world.y * scale;
      return true;
    },
    distancePx(world, screenX, screenY) {
      const out = { x: 0, y: 0 };
      this.project(world, out);
      return Math.hypot(out.x - screenX, out.y - screenY);
    },
  };
}

const NOHARA = findScene('nohara');

/**
 * 場面ひとつぶんの一式を、`SceneRoot` と同じ手順で組む。
 *
 * **`SceneRoot` と同じにしておくこと。** 片方だけ直すと、
 * テストは通るのに実機では違う、という一番たちの悪い形になる。
 */
/**
 * 絵を貼った動物（`CutoutAnimal`）を node で組むための、中身の無いテクスチャ。
 *
 * **画像は読めないが、読む必要も無い。**
 * `createCutoutAnimal` が見るのは `texture.image.width / height` だけで、
 * レイを飛ばす判定もジオメトリしか使わない。大きさは `npm run cutouts` が
 * 書き出した実測値（`CUTOUT_SIZES`）をそのまま使う。
 */
function fakeCutouts(scene: SceneConfig): Map<string, THREE.Texture> {
  const ids = new Set<string>();
  for (const spot of scene.spots) for (const id of spot.animals) ids.add(id);
  if (scene.runner) ids.add(scene.runner);

  const map = new Map<string, THREE.Texture>();
  for (const id of ids) {
    const size = CUTOUT_SIZES[id];
    if (!size) continue;
    const tex = new THREE.Texture();
    tex.image = { width: size[0], height: size[1] };
    map.set(id, tex);
  }
  return map;
}

function sceneRig(sceneId: string, seed = 12345, useCutouts = false): ChaseRig {
  const scene = findScene(sceneId);
  // **§6-1 のばらつきの種を固定する。** 既定は `Date.now()` なので、
  // 固定しないと「その回の乱数しだいで落ちる」テストができる（実際に踏んだ）
  const spots = new SpotSystem(scene.spots, scene.mode, seed);
  const animals = new AnimalSystem(spots, false, useCutouts ? fakeCutouts(scene) : new Map());

  let chase: ChaseSystem | null = null;
  if (scene.mode === 'chase' && scene.runner) {
    const start = spots.runtimes[0];
    const runner = animals.spawn(start, scene.runner);
    // モードBのヒントは「移動そのもの」（§4-5）。人間が決めた扱い（2026-09-05）
    if (runner) runner.showHint = false;
    chase = new ChaseSystem(spots, animals, { seed, startSpotId: start.config.id });
  }
  const empty = new EmptySpot(spots);
  spots.onEmpty((spot) => empty.trigger(spot, chase?.getAnswerSpot() ?? null));

  // **味つけも動かした状態で不変条件を見る**（2026-09-07）。
  // ここを繋がないと、隠れ場所を傾ける演出を足しても
  // 「隠れているのに体が見えている」のテストが素通りする
  const flavor = new Flavor(spots.runtimes, scene.flavor, { seed });
  // **`SceneRoot` と同じ配線。** ここを繋がないと、隠れ場所が
  // たまご／つぼみ に入れ替わらないまま検査してしまう
  flavor.onLeftover((spot, kind) => {
    if (spots.setShape(spot, kind)) animals.reanchorAll();
  });
  flavor.onLeftoverEnd((spot) => {
    if (spots.setShape(spot, spot.config.kind)) animals.reanchorAll();
  });

  const camera = new THREE.PerspectiveCamera(66, 0.49, 0.05, 60);
  camera.position.set(0, 0.3, 7.2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    spots,
    animals,
    camera,
    // モードAの場面では chase は無い。呼ばないこと
    chase: chase as ChaseSystem,
    empty,
    flavor,
    answer: () => (chase ? chase.getAnswerSpot() : spots.runtimes[0]),
    advance(seconds, onFrame) {
      const frames = Math.round(seconds / DT);
      for (let i = 0; i < frames; i++) {
        onFrame?.(i);
        spots.update(DT);
        chase?.update(DT);
        empty.update(DT);
        // `SceneRoot.update()` と同じ順番。`SpotSystem` のあと、`AnimalSystem` の前
        flavor.update(DT);
        animals.update(DT, spots, camera);
      }
    },
  };
}

/** モードA（その場に住む）の場面 */
const HIDEOUT_SCENES = SCENES.filter((s) => s.mode === 'hideout').map((s) => s.id);
/** 全場面 */
const ALL_SCENES = SCENES.map((s) => s.id);

interface ChaseRig extends Rig {
  chase: ChaseSystem;
  empty: EmptySpot;
  /** 場面ごとの味つけ（2026-09-07）。`advance` の中で毎フレーム動く */
  flavor: Flavor;
  /** うさぎが居る（or 向かっている）隠れ場所 */
  answer(): SpotRuntime;
}

/**
 * のはら（モードB / §4-5）の一式。
 *
 * **乱数の種を渡せるようにしてある。** `Math.random()` のままだと
 * 行き先の抽選が再現できず、落ちたときに何が起きたか追えない
 * （CLAUDE.md「遊びの乱数は独立したシードから引く」）。
 */
function chaseRig(seed = 12345): ChaseRig {
  const spots = new SpotSystem(NOHARA.spots, NOHARA.mode, seed);
  const animals = new AnimalSystem(spots, false);
  const start = spots.runtimes[0];
  const runner = animals.spawn(start, NOHARA.runner!);
  // **SceneRoot と同じ扱いにする。** モードBのヒントは「移動そのもの」（§4-5）
  if (runner) runner.showHint = false;
  const chase = new ChaseSystem(spots, animals, { seed, startSpotId: start.config.id });
  const empty = new EmptySpot(spots);
  spots.onEmpty((spot) => empty.trigger(spot, chase.getAnswerSpot()));
  const flavor = new Flavor(spots.runtimes, NOHARA.flavor, { seed });

  const camera = new THREE.PerspectiveCamera(66, 0.49, 0.05, 60);
  camera.position.set(0, 0.3, 7.2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    spots,
    animals,
    camera,
    chase,
    empty,
    flavor,
    answer: () => chase.getAnswerSpot(),
    advance(seconds, onFrame) {
      const frames = Math.round(seconds / DT);
      for (let i = 0; i < frames; i++) {
        onFrame?.(i);
        // **SceneRoot と同じ順番。** ここを変えると移動の開始が1フレームずれる
        spots.update(DT);
        chase.update(DT);
        empty.update(DT);
        flavor.update(DT);
        animals.update(DT, spots, camera);
      }
    },
  };
}

/** `obj` が `root` の中にいるか（自分自身を含む） */
function isDescendantOf(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    if (o === root) return true;
  }
  return false;
}

/**
 * 絵の、その位置に色があるか（`uv` は板の 0..1）。
 *
 * **板は四角いので、レイは透明な角にも当たる。**
 * それを「体が見えている」と数えると、実際には見えていないのに落ちる
 * （2026-09-07 に、のうじょうの こや で下端 7点がそうだった）。
 * マスは 1画素でも不透明なら '1' なので、**見えているものは見逃さない**。
 */
function isOpaqueAt(animalId: string, uv: { x: number; y: number }): boolean {
  const mask = CUTOUT_MASKS[animalId];
  if (!mask) return true; // マスが無ければ、見えていると見なす（厳しい側）
  const n = mask.length;
  const col = Math.min(n - 1, Math.max(0, Math.floor(uv.x * n)));
  // `uv.y` は板の下が 0。マスの行は絵の上から
  const row = Math.min(n - 1, Math.max(0, Math.floor((1 - uv.y) * n)));
  return mask[row][col] === '1';
}

/**
 * 出ている動物が、カメラから見えている割合。
 *
 * **見かけの矩形に格子を張って、いちばん手前が体かどうかで数える。**
 * 高さだけ見ていると気づけない（2026-09-06 の「絵と被って見えなくなる」）。
 */
function visibleRatio(
  slot: { built: { group: THREE.Object3D; hint: THREE.Object3D } },
  spots: SpotSystem,
  camera: THREE.Camera,
  ray: THREE.Raycaster,
  box: THREE.Box3,
  target: THREE.Vector3,
  dir: THREE.Vector3,
  cols: number,
  rows: number
): number {
  box.makeEmpty();
  for (const child of slot.built.group.children) {
    if (child === slot.built.hint) continue;
    box.expandByObject(child);
  }
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);

  let seen = 0;
  let total = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      target.set(
        box.min.x + ((box.max.x - box.min.x) * (c + 0.5)) / cols,
        box.min.y + ((box.max.y - box.min.y) * (r + 0.5)) / rows,
        (box.min.z + box.max.z) / 2
      );
      dir.subVectors(target, camPos).normalize();
      ray.set(camPos, dir);
      const hits = ray.intersectObject(spots.group, true);
      if (hits.length === 0) continue;
      total++;
      if (isDescendantOf(hits[0].object, slot.built.group)) seen++;
    }
  }
  return total === 0 ? 0 : seen / total;
}

describe('不変条件1 — 無反応を作らない', () => {
  // 波紋は DOM が要るので Playwright 側で見る（tests/e2e「画面のどこをタップしても波紋が出る」）。
  it.todo('隠れ場所から外れた場所を押しても、波紋が必ず出る');
  it('空の隠れ場所を押しても反応が返る（不変条件3b）', () => {
    const { spots, chase, empty, advance } = chaseRig();
    // うさぎが居ない箇所。**のはらでは5回に4回がここ**（§4-6）
    const emptySpots = spots.runtimes.filter((s) => s !== chase.getAnswerSpot());
    expect(emptySpots).toHaveLength(spots.runtimes.length - 1);

    for (const spot of emptySpots) {
      expect(spot.occupied, spot.config.id).toBe(false);
      // 空でも当たり判定は持っている（外すと不変条件3b を破る）
      expect(spot.config.hitRadiusPx).toBeGreaterThan(0);
      // **必ず true。** ここが false になると、のはらでいちばん多い操作が無反応になる
      expect(spots.tap(spot), spot.config.id).toBe(true);
      // 押した実感（§4-3 の 0.00s）
      expect(spot.shake, spot.config.id).toBeGreaterThan(0);
    }
    expect(empty.getStartedCount()).toBe(emptySpots.length);
    expect(empty.getTapCount()).toBe(emptySpots.length);
    // 応答を返したタップ数が、押した数と一致する
    expect(spots.getResponseCount()).toBe(emptySpots.length);

    // ふたが開く（§4-6 の 0.00s）
    advance(0.2);
    for (const spot of emptySpots) {
      expect(spot.extraOpen, spot.config.id).toBeGreaterThan(0.9);
      // **状態は変えない。** 中身が居ないのに appearing に入れると、
      // ふたが開いて何も出てこないまま out に居座る
      expect(spot.state, spot.config.id).toBe('hidden');
      expect(spot.reveal, spot.config.id).toBe(0);
    }
  });

  it('空の隠れ場所を押したあと、正解の隠れ場所が揺れる', () => {
    const { spots, chase, advance } = chaseRig();
    const answer = chase.getAnswerSpot();
    const miss = spots.runtimes.find((s) => s !== answer)!;

    spots.tap(miss);
    advance(EMPTY_HINT_AT_SEC - 0.05);
    expect(answer.callShake).toBe(0);

    advance(0.1);
    // **必ず正解を教える**（§4-6「1歳半に探させるのは早い」）
    expect(answer.callShake).toBeGreaterThan(0.9);
    // 明滅ではなく揺れ（不変条件6）。開いてはいない
    expect(answer.extraOpen).toBe(0);
    expect(answer.reveal).toBe(0);

    // **押した実感の「ぷるっ」より長く揺れること。**
    // 同じ 0.3秒で消していたときは、空振りの演出を見ている途中に終わって
    // 「どこが揺れたのか分からない」になった
    advance(1.0);
    expect(answer.callShake, '1秒後にはもう揺れていない').toBeGreaterThan(0.2);
    advance(CALL_DECAY_SEC);
    expect(answer.callShake, '揺れっぱなしになっている').toBe(0);
  });

  it('空の隠れ場所を連打しても、シーケンスは毎回最後まで走る', () => {
    // みずのなかの貝と同じ形の不具合を §4-6 で作らないこと。
    // 途中のタップで巻き戻すと、「ふたが開きかけては戻る」を繰り返して
    // 誰もいないことも正解の場所も、一度も見せられない
    const { spots, chase, empty, advance } = chaseRig();
    const miss = spots.runtimes.find((s) => s !== chase.getAnswerSpot())!;

    // 1本ぶんの中で押し続ける
    let maxOpen = 0;
    advance(EMPTY_TOTAL_SEC - 0.05, () => {
      expect(spots.tap(miss)).toBe(true);
      maxOpen = Math.max(maxOpen, miss.extraOpen);
    });

    // ふたは開ききった（貝は 0.037 までしか開かなかった）
    expect(maxOpen).toBe(1);
    // 連打しても走ったシーケンスは1本だけ。巻き戻していない
    expect(empty.getStartedCount()).toBe(1);
    // それでも押した回数ぶん、反応は返している（不変条件2）
    expect(empty.getTapCount()).toBeGreaterThan(50);

    // 押すのをやめれば、最後まで走りきる
    advance(0.3);
    expect(empty.getFinishedCount()).toBe(1);
    expect(miss.extraOpen).toBe(0);

    // 長く連打しても、**始めたぶんは必ず終わる**（走りっぱなしにしない）
    advance(EMPTY_TOTAL_SEC * 4, () => {
      spots.tap(miss);
    });
    advance(EMPTY_TOTAL_SEC);
    expect(empty.getFinishedCount()).toBe(empty.getStartedCount());
  });

  it('外したタップでも、いちばん近い隠れ場所が必ず揺れる', () => {
    const { spots } = rig();
    const tester = fakeTester();

    // 4箇所のどれからも遠い、画面の左上の隅
    expect(spots.pick(4, 4, tester)).toBeNull();

    const nudged = spots.nudgeNearest(4, 4, tester);
    // **null を返さないこと。** ここが null になると、外したタップは
    // 波紋だけになって「押したのに何も起きない」に近づく
    expect(nudged).not.toBeNull();
    expect(nudged!.shake).toBeGreaterThan(0);
    // 揺らすだけで、状態は変えない（押していない場所が開いたら因果が壊れる）
    expect(nudged!.state).toBe('hidden');
  });

  it('隠れ場所に当たったタップは、1回残らず応答を返す', () => {
    const { spots, advance } = rig();
    const tester = fakeTester();
    const target = spots.runtimes[0];
    const p = { x: 0, y: 0 };
    tester.project(target.worldPosition, p);

    let taps = 0;
    advance(2, () => {
      const hit = spots.pick(p.x, p.y, tester);
      expect(hit).toBe(target);
      spots.tap(hit!);
      taps++;
    });

    expect(spots.getResponseCount()).toBe(taps);
  });
});

describe('不変条件2 — どの瞬間に押しても反応する', () => {
  it('60Hz で連打しても、登場アニメが最後まで進む（進捗が 1.0 に達する）', () => {
    const { spots, advance } = rig();
    const spot = spots.runtimes[0];

    // **毎フレーム押す。** みずのなかの貝はこれで開き量が最大 0.037 だった
    let maxReveal = 0;
    advance(3, () => {
      spots.tap(spot);
      maxReveal = Math.max(maxReveal, spot.reveal);
    });

    expect(maxReveal).toBe(1);
    expect(spot.state).toBe('out');
  });

  it('連打しても、1回押しと同じ速さで出きる', () => {
    // 「1.0 に達する」だけだと、連打で 10秒かかっていても通ってしまう。
    // **完走までの時間**まで見ないと、貝と同じ「事実上ずっと閉じたまま」を捕まえられない
    // **「出きるまで」は最初に 1.0 に届いたフレーム。**
    // 「reveal < 1 だった最後のフレーム」で測ると、1回押しのほうは
    // そのあとの引っ込み（reveal が 0 に戻る）まで数えてしまう
    const timeToFull = (tapEveryFrame: boolean): number => {
      const r = rig();
      const spot = r.spots.runtimes[0];
      let frames = Infinity;
      if (!tapEveryFrame) r.spots.tap(spot);
      r.advance(3, (f) => {
        if (tapEveryFrame) r.spots.tap(spot);
        if (frames === Infinity && spot.reveal >= 1) frames = f;
      });
      return frames;
    };

    const singleFrames = timeToFull(false);
    const spamFrames = timeToFull(true);

    expect(spamFrames).toBe(singleFrames);
    // §4-3 の 0.50s（ため 0.15 ＋ 登場 0.35）。1フレームぶんの丸めを許す
    expect(spamFrames * DT).toBeLessThanOrEqual(PEAK_AT_SEC + DT);
  });

  it('登場中・退場中のタップも true を返す（声とアピールが止まらない）', () => {
    const { spots, advance } = rig();
    const spot = spots.runtimes[0];

    const seen = new Set<string>();
    let voices = 0;
    spots.onVoice(() => voices++);

    spots.tap(spot);
    // 1回押して、ひと巡り（登場 → out → 引っ込み → hidden）させながら
    // **全ての状態で押して、全部 true が返ること**を見る
    advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 1, () => {
      seen.add(spot.state);
      expect(spots.tap(spot)).toBe(true);
    });

    // ひと巡りぶんの状態を実際に通っていること（通らずに通過したテストにしない）
    expect(seen.has('appearing')).toBe(true);
    expect(seen.has('out')).toBe(true);
    expect(voices).toBeGreaterThan(0);
  });

  it('hiding 中に押すと appearing に戻り、reveal が 0 に落ちない', () => {
    const { spots, advance } = rig();
    const spot = spots.runtimes[0];

    spots.tap(spot);
    advance(PEAK_AT_SEC + OUT_IDLE_SEC + 0.1);
    expect(spot.state).toBe('hiding');

    const before = spot.reveal;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(1);

    spots.tap(spot);
    expect(spot.state).toBe('appearing');
    // **呼び戻しは途中から。** ここで 0 に戻すと、
    // 連打したときに一度も出きらなくなる（貝と同じ形の不具合）
    expect(spot.reveal).toBe(before);

    let min = before;
    advance(0.5, () => {
      min = Math.min(min, spot.reveal);
    });
    expect(min).toBeGreaterThanOrEqual(before - 1e-9);
    expect(spot.reveal).toBe(1);
  });

  it('移動中に押しても反応が返り、かつ移動が完了する（不変条件4b）', () => {
    const { spots, chase, advance } = chaseRig();
    const start = chase.getAnswerSpot();

    spots.tap(start);
    // 移動が始まるまで（§4-5 の 1.70s）
    advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + 0.05);
    expect(chase.isMoving()).toBe(true);

    // **移動中ずっと 60Hz で連打する。** それでも到着すること
    let responses = 0;
    let sawHop = false;
    advance(CHASE_MOVE_SEC + 0.3, () => {
      if (chase.getPhase() === 'hop') sawHop = true;
      for (const spot of spots.runtimes) {
        // どこを押しても必ず反応が返る（不変条件1・3b）
        expect(spots.tap(spot)).toBe(true);
        responses++;
      }
    });

    expect(sawHop).toBe(true);
    expect(responses).toBeGreaterThan(0);
    expect(chase.getTapsWhileMoving()).toBeGreaterThan(0);

    // **移動そのものは止まっていない。** 1周して別の場所に着いた
    expect(chase.getLaps()).toBeGreaterThanOrEqual(1);
    expect(chase.getPhase()).toBe('idle');
    const arrived = chase.getAnswerSpot();
    expect(arrived).not.toBe(start);
    expect(arrived.occupied).toBe(true);
    expect(start.occupied).toBe(false);
  });
});

describe('不変条件3 — 隠れていても必ず見えている', () => {
  it('hidden の状態でも、画面に出ている面積が 0 でない', () => {
    // ==========================================================================
    // **モードA（その場に住む）だけの条件。**
    // モードB（のはら / §4-5）のヒントは「移動そのもの」で、
    // 外したときは正解の場所が揺れて教える（§4-6）ので、
    // 草むらから体の一部を出さない。この扱いは**人間が決めた**（2026-09-05）。
    // 出していないことは「§4-5 移動モード」のテストで確かめている。
    // ==========================================================================
    const { spots, animals, advance } = rig();
    advance(0.5); // ヒントの揺れを1周ぶん回してから測る

    for (const spot of spots.runtimes) {
      const e = animals.getExposure(spot);
      expect(e, `${spot.config.id} に動物が居ない`).not.toBeNull();
      // **これが 0 になる壊れ方は、目で見て気づけない**（暗い画面で
      // 「まだ出ていないだけ」に見える）。だから数値で押さえる
      expect(e!.fraction, spot.config.id).toBeGreaterThan(0);
      // §4-2「はみ出しは体長の 15〜25%」
      expect(e!.fraction, spot.config.id).toBeGreaterThanOrEqual(0.15);
      expect(e!.fraction, spot.config.id).toBeLessThanOrEqual(0.25);
    }
  });

  it('隠れているあいだ、ヒント以外の体は縁から出ていない', () => {
    // 顔が見えていたら「ばあ！」が驚きにならない。
    // 上のテストだけだと「動物が丸ごと出ている」状態でも通ってしまう
    const { spots, animals, advance } = rig();
    advance(0.5);

    for (const spot of spots.runtimes) {
      const e = animals.getExposure(spot)!;
      expect(e.bodyFraction, spot.config.id).toBeLessThan(0.01);
    }
  });

  it('隠れているヒントが、隠れ場所に遮られずカメラから見えている', () => {
    // ==========================================================================
    // **上の2つのテストだけでは足りない。** 高さ（y）は足りていても、
    // ふたやレールがその手前に立っていれば1画素も見えない。
    // 実際にそうなっていた: はこ（ねこの尻尾）とカーテン（ことりの足）は
    // 縁より 20% 上に出ていたのに、閉じたふたとレールの裏で完全に隠れていた。
    // 上段の隠れ場所はカメラ（y=0.3）より上にあるので、下から見上げる形になる。
    //
    // 画素を比べるのは禁止（動物が常に動くので必ず落ちる）なので、
    // **カメラからヒントへレイを飛ばして、途中に何も無いこと**を見る。
    // GPU も画面も要らず、結果は毎回同じ。
    // ==========================================================================
    const { spots, animals, camera, advance } = rig();
    advance(0.5);

    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const box = new THREE.Box3();

    for (const spot of spots.runtimes) {
      const slot = animals.getSlot(spot.config.id)!;
      spots.group.updateWorldMatrix(true, true);

      box.setFromObject(slot.built.hint);
      box.getCenter(target);
      // ヒントの上寄り（縁からいちばん出ているあたり）を狙う
      target.y = box.max.y - (box.max.y - box.min.y) * 0.2;

      dir.subVectors(target, camera.position);
      const distance = dir.length();
      ray.set(camera.position, dir.normalize());
      // ヒントの手前で止める。当たったものがあれば、それが遮っている
      ray.far = distance - 0.02;

      // **ヒント自身の手前側は除く。** 狙っているのはヒントの内部の点なので、
      // ヒント自体の前面は必ず `far` の内側に入る。それを遮蔽と数えない
      const blockers = ray
        .intersectObject(spots.group, true)
        .filter((b) => !isDescendantOf(b.object, slot.built.hint));

      expect(
        blockers.map((b) => b.object.name || b.object.type),
        `${spot.config.id}: ヒントがカメラから見えていない`
      ).toEqual([]);
    }
  });

  it('隠れているとき、体はどこからも覗けない（隙間から見えない）', () => {
    // ==========================================================================
    // 「ヒントが見えている」の裏返し。**見えてはいけないものが見えていないか。**
    //
    // 隙間から中身が見える壊れ方を2回作った:
    //   - カーテンの中央に 0.10 空けていたら、体が縦一直線に丸見えだった
    //   - くさむらの左右の房が 0.05 離れていて、白いうさぎが縦に見えていた
    // どちらも「縁より上のはみ出し量」は正しく、**数値のテストは通っていた**。
    //
    // **顔の1点だけ狙っても足りない。** カメラは斜めから見ているので、
    // 顔へのレイはたまたま葉に当たって通ってしまう（実際に見逃した）。
    // 体の見かけの矩形に格子を張って、**どの向きから見ても、
    // いちばん手前に当たるのが体であってはいけない**ことを見る。
    // 画素は比べない（GPU も画面も要らず、結果は毎回同じ）。
    // ==========================================================================
    // **格子は細かく取ること。** 7×9 では、カーテンやくさむらの
    // 0.05 幅の隙間を「たまたま外して」通ってしまった。
    // カメラは斜めから見ているので、体の座標と隠れ場所の座標はずれる。
    // 隙間の幅（0.05）より細かい間隔になるところまで上げてある
    const COLS = 15;
    const ROWS = 15;

    for (const rigging of [rig(), chaseRig()]) {
      const { spots, animals, camera, advance } = rigging;
      advance(0.5);

      const ray = new THREE.Raycaster();
      const target = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const box = new THREE.Box3();

      for (const spot of spots.runtimes) {
        const slot = animals.getSlot(spot.config.id);
        if (!slot) continue; // のはらの空の箇所（不変条件3 の例外）
        spots.group.updateWorldMatrix(true, true);

        // ヒントは見えていて当たり前なので、体だけの矩形を取る
        box.makeEmpty();
        for (const child of slot.built.group.children) {
          if (child === slot.built.hint) continue;
          box.expandByObject(child);
        }

        const leaks: string[] = [];
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            target.set(
              box.min.x + ((box.max.x - box.min.x) * (c + 0.5)) / COLS,
              box.min.y + ((box.max.y - box.min.y) * (r + 0.5)) / ROWS,
              box.max.z
            );
            dir.subVectors(target, camera.position).normalize();
            ray.set(camera.position, dir);
            ray.far = Infinity;

            const hits = ray.intersectObject(spots.group, true);
            if (hits.length === 0) continue; // 体にも隠れ場所にも当たらない向き
            const first = hits[0].object;
            if (
              isDescendantOf(first, slot.built.group) &&
              !isDescendantOf(first, slot.built.hint)
            ) {
              leaks.push(`(${c},${r}) ${first.name || first.type}`);
            }
          }
        }

        expect(
          leaks,
          `${spot.config.id}: 隠れているのに体が ${leaks.length}/${COLS * ROWS} 点で見えている`
        ).toEqual([]);
      }
    }
  });

  it('隠れているとき、隠れ場所の下から体がはみ出していない', () => {
    // **上だけ見ていても気づけない。** うさぎ（体高 1.38）をくさむら（当時 1.05）に
    // 入れたとき、縁より上の量は 0.22 で正しかったのに、
    // 下から白い体が飛び出していた。実機の絵を見るまで分からなかった。
    for (const rigging of [rig(), chaseRig()]) {
      rigging.advance(0.5);
      for (const spot of rigging.spots.runtimes) {
        const e = rigging.animals.getExposure(spot);
        if (!e) continue; // のはらの空の箇所（不変条件3 の例外）
        expect(e.bottomFraction, `${spot.config.id} が下にはみ出している`).toBeLessThan(0.01);
      }
    }
  });

  it('ヒントの出す量は、体の高さを実測して決めている', () => {
    // 定数を信じない。耳や尻尾を足すと体の高さは変わるので、
    // 決め打ちにすると隠れ方が動物ごとにずれる。
    //
    // 縁から出る量 ＝ ヒントの長さ（体高の HINT_EXPOSURE 倍）
    //                − 沈めた量（HIDDEN_SINK は体高によらず一定）
    // なので、**体高で割ったときの値は動物ごとに違う**のが正しい。
    // ここが全部同じ値になっていたら、高さを実測せず決め打ちにしている
    // モードB はヒントを出さないので、ここはモードAだけを見る
    const seen = new Set<number>();
    for (const rigging of [rig()]) {
      for (const spot of rigging.spots.runtimes) {
        const e = rigging.animals.getExposure(spot);
        if (!e) continue;
        expect(e.animalHeight).toBeGreaterThan(0);

        const base = EXPECTED_HINT_EXPOSURE - HIDDEN_SINK / e.animalHeight;
        // 先端（鼻先・足）が少しはみ出すので、下回ることはない
        expect(e.fraction, spot.config.id).toBeGreaterThanOrEqual(base - 1e-6);
        // はみ出しても 12% まで。これを超えるならヒントの形が大きすぎる
        expect(e.fraction, spot.config.id).toBeLessThanOrEqual(base * 1.12);
        seen.add(Math.round(e.fraction * 1000));
      }
    }
    // 体高の違う動物が、違う割合で出ている（決め打ちなら1種類になる）
    expect(seen.size).toBeGreaterThan(1);
  });

  it('隠れ場所の開口部が、動物の断面の 0.86 倍以上を覆う（§4-2）', () => {
    const { spots, animals } = rig();
    for (const spot of spots.runtimes) {
      const fit = animals.getFit(spot)!;
      // 覆えていないと「隠れていない」状態になる
      expect(fit.mouthWidth, spot.config.id).toBeGreaterThanOrEqual(fit.animalWidth * 0.86);
    }
  });
});

describe('不変条件4 — 登場は 0.35秒以内に始まる', () => {
  it('タップから 0.35秒後には、動物が出はじめている', () => {
    const { spots, advance } = rig();
    const spot = spots.runtimes[0];

    spots.tap(spot);
    let startedAt = Infinity;
    advance(1, (f) => {
      if (startedAt === Infinity && spot.reveal > 0) startedAt = f * DT;
    });

    expect(startedAt).toBeLessThanOrEqual(0.35);
    // §4-3「0.15秒より速いと『ばあ』にならない。押したら即出るのは、ただのボタン」
    expect(startedAt).toBeGreaterThanOrEqual(APPEAR_DELAY_SEC - DT);
  });

  it('0.35秒の時点で、山（声と粒子）に届いている', () => {
    const { spots, advance } = rig();
    const spot = spots.runtimes[0];
    spots.tap(spot);
    advance(PEAK_AT_SEC + DT);
    expect(spot.reveal).toBe(1);
    expect(spot.state).toBe('out');
  });
});

describe('不変条件6 — 明滅は 1秒に3回まで', () => {
  it('連打しても、光る演出が 3回/秒 を超えない', () => {
    const { spots, animals, advance } = rig();
    const spot = spots.runtimes[0];

    // 光った時刻を全部記録して、**あらゆる1秒の窓**で数える。
    // 「合計回数 ÷ 秒数」だと、頭に固まって光っても通ってしまう
    const at: number[] = [];
    let t = 0;
    advance(5, () => {
      // 入力は一切間引かない（不変条件1）。抑えるのは出力側だけ
      if (animals.requestFlash(spot)) at.push(t);
      t += DT;
    });

    expect(at.length).toBeGreaterThan(0);
    for (let i = 0; i < at.length; i++) {
      const inWindow = at.filter((x) => x >= at[i] && x < at[i] + 1).length;
      expect(inWindow, `${at[i].toFixed(3)}秒からの1秒間`).toBeLessThanOrEqual(3);
    }
    // 1/3秒ちょうどにすると 0 / 0.333 / 0.667 / 1.000 で1秒に4回入る
    expect(FLASH_MIN_INTERVAL_SEC).toBeGreaterThan(1 / 3);
  });

  it('光を止めても、声とアピールは止まらない', () => {
    const { spots, animals, advance } = rig();
    const spot = spots.runtimes[0];
    let voices = 0;
    spots.onVoice(() => voices++);

    let suppressed = 0;
    advance(1, () => {
      spots.tap(spot);
      if (!animals.requestFlash(spot)) suppressed++;
    });

    // 明滅は落としているが
    expect(suppressed).toBeGreaterThan(0);
    // 声は返っている（不変条件2）
    expect(voices).toBeGreaterThan(0);
  });
});

describe('§4-1 状態遷移', () => {
  const cycle = (spot: SpotRuntime, advance: Rig['advance']): string[] => {
    const seen: string[] = [];
    advance(PEAK_AT_SEC + OUT_IDLE_SEC + HIDE_DUR_SEC + 0.5, () => {
      if (seen[seen.length - 1] !== spot.state) seen.push(spot.state);
    });
    return seen;
  };

  it('hidden → appearing → out → hiding → hidden をひと巡りする', () => {
    const { spots, advance } = rig();
    const spot = spots.runtimes[0];
    spots.tap(spot);
    expect(cycle(spot, advance)).toEqual(['appearing', 'out', 'hiding', 'hidden']);
  });

  it('out 中に押すと、出ている時間が伸びる', () => {
    const a = rig();
    a.spots.tap(a.spots.runtimes[0]);
    a.advance(PEAK_AT_SEC + 0.1);
    expect(a.spots.runtimes[0].state).toBe('out');
    const idleBefore = a.spots.runtimes[0].idle;

    a.spots.tap(a.spots.runtimes[0]);
    expect(a.spots.runtimes[0].idle).toBe(OUT_IDLE_SEC);
    expect(a.spots.runtimes[0].idle).toBeGreaterThan(idleBefore);
  });

  it('押していない隠れ場所は hidden のまま', () => {
    const { spots, advance } = rig();
    spots.tap(spots.runtimes[0]);
    advance(3);
    for (let i = 1; i < spots.runtimes.length; i++) {
      expect(spots.runtimes[i].state, spots.runtimes[i].config.id).toBe('hidden');
    }
  });
});

describe('§3-2 当たり判定どうしが重ならない', () => {
  it('隣との距離を見て半径を縮めるので、どの2つも重ならない', () => {
    const { spots } = rig();
    // 1ワールド = 40px。設定値 120px のままだと全部重なる縮尺
    const tester = fakeTester(40);
    spots.projectAll(tester);

    const pts = spots.runtimes.map((s) => {
      const p = { x: 0, y: 0 };
      tester.project(s.worldPosition, p);
      return p;
    });

    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        const sum = spots.radiusAt(i) + spots.radiusAt(j);
        expect(sum, `${spots.runtimes[i].config.id}-${spots.runtimes[j].config.id}`).toBeLessThan(d);
      }
    }
    // 縮んでいることそのものも確かめる（縮めずに通ったら、この縮尺ではおかしい）
    expect(spots.radiusAt(0)).toBeLessThan(spots.runtimes[0].config.hitRadiusPx);
  });

  it('広い画面では、設定した半径を超えて広がらない', () => {
    const { spots } = rig();
    const tester = fakeTester(400);
    spots.projectAll(tester);
    for (let i = 0; i < spots.runtimes.length; i++) {
      expect(spots.radiusAt(i)).toBe(spots.runtimes[i].config.hitRadiusPx);
    }
  });

  it('中心をちょうど押したら、その隠れ場所が当たる', () => {
    const { spots } = rig();
    const tester = fakeTester();
    for (const spot of spots.runtimes) {
      const p = { x: 0, y: 0 };
      tester.project(spot.worldPosition, p);
      expect(spots.pick(p.x, p.y, tester)).toBe(spot);
    }
  });
});

describe('1体ずつしか出さない（2026-09-07。人間が決めた）', () => {
  // ==========================================================================
  // 1歳半は画面を連打する。4体が同時に出ていると「自分が押したから出た」が
  // 読めなくなるので、**誰かが出ているあいだは新しく出さない**。
  //
  // **無反応にはしない。** ぷるっ（`shake`）・波紋・音は必ず返るので、
  // 不変条件1（無反応を作らない）と不変条件2（どの瞬間に押しても反応する）は
  // これまでどおり成り立つ。§4-1 の「押したら出る」だけを、人間の判断で
  // 「1体ずつ」に変えている。
  // ==========================================================================

  it.each(HIDEOUT_SCENES)('%s: まとめて押しても、出るのは1体だけ', (id) => {
    const { spots, advance } = sceneRig(id);
    for (const spot of spots.runtimes) spots.tap(spot);
    advance(PEAK_AT_SEC + DT);

    const out = spots.runtimes.filter((s) => s.state !== 'hidden');
    expect(out.map((s) => s.config.id).join(','), id).toHaveLength(out[0].config.id.length);
    expect(out).toHaveLength(1);
  });

  it.each(HIDEOUT_SCENES)('%s: 順番待ちでも、反応（ぷるっ）は必ず返る（不変条件1・2）', (id) => {
    const { spots, advance } = sceneRig(id);
    const before = spots.getResponseCount();
    for (const spot of spots.runtimes) {
      expect(spots.tap(spot), `${id}/${spot.config.id}`).toBe(true);
      expect(spot.shake, `${id}/${spot.config.id}`).toBeGreaterThan(0);
    }
    expect(spots.getResponseCount() - before).toBe(spots.runtimes.length);
    // 出せなかったぶんは数えてある（実測用）
    expect(spots.getBlockedCount()).toBe(spots.runtimes.length - 1);
    void advance;
  });

  it('連打しても、順番待ちのあいだは1体しか出ない', () => {
    // **毎フレーム全部を押す。** みずのなかの貝と同じ壊し方をしてみる
    const { spots, advance } = sceneRig('ouchi');
    let maxOut = 0;
    advance(6, () => {
      for (const spot of spots.runtimes) spots.tap(spot);
      maxOut = Math.max(maxOut, spots.runtimes.filter((s) => s.state !== 'hidden').length);
    });
    expect(maxOut).toBe(1);
  });

  it('その子が隠れきったら、次の子が出られる', () => {
    const { spots, advance } = sceneRig('ouchi');
    const [a, b] = spots.runtimes;

    spots.tap(a);
    advance(PEAK_AT_SEC + DT);
    expect(a.state).toBe('out');

    // 隠れきる前は出せない
    spots.tap(b);
    expect(b.state).toBe('hidden');

    advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.2);
    expect(a.state).toBe('hidden');

    // 隠れきったら出せる
    spots.tap(b);
    advance(PEAK_AT_SEC + DT);
    expect(b.state).toBe('out');
  });

  it('同じ子の呼び戻し（引っ込み中のタップ）は、これまでどおり通る（不変条件2）', () => {
    const { spots, advance } = sceneRig('ouchi');
    const a = spots.runtimes[0];
    spots.tap(a);
    advance(PEAK_AT_SEC + OUT_IDLE_SEC + 0.1);
    expect(a.state).toBe('hiding');

    spots.tap(a);
    expect(a.state).toBe('appearing');
    advance(0.5);
    expect(a.state).toBe('out');
    expect(a.reveal).toBe(1);
  });

  it('空の隠れ場所は、順番待ちに関係なく反応する（不変条件3b）', () => {
    // モードBの空きは「中身が居ない」ので、そもそも出さない。
    // 順番待ちの判定に巻き込まれていないことを見る
    const { spots, empty, advance } = chaseRig(7);
    const answer = spots.runtimes.find((s) => s.occupied)!;
    spots.tap(answer);
    advance(PEAK_AT_SEC + DT);

    const miss = spots.runtimes.find((s) => !s.occupied)!;
    const before = empty.getStartedCount();
    expect(spots.tap(miss)).toBe(true);
    expect(empty.getStartedCount()).toBe(before + 1);
  });
});

describe('§4-5 移動モード', () => {
  /** うさぎを n 周まわして、行き先の履歴を返す */
  function runLaps(rigging: ReturnType<typeof chaseRig>, laps: number): readonly string[] {
    const { spots, chase, advance } = rigging;
    for (let i = 0; i < laps; i++) {
      spots.tap(chase.getAnswerSpot());
      // 1周ぶん（§4-5 の 4.80秒）＋ 取りこぼさないための余白
      advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + CHASE_MOVE_SEC + 0.2);
    }
    expect(chase.getLaps()).toBe(laps);
    return chase.getHistory();
  }

  it('直前と同じ隠れ場所には戻らない（20周まわして 0 回）', () => {
    const history = runLaps(chaseRig(), 20);
    expect(history).toHaveLength(21); // 最初の居場所 ＋ 20周ぶんの行き先

    let immediateReturns = 0;
    for (let i = 1; i < history.length; i++) {
      if (history[i] === history[i - 1]) immediateReturns++;
    }
    // **0 回。** 同じ場所に戻ると「動いていない」に見える（§4-5）
    expect(immediateReturns, `履歴: ${history.join(' → ')}`).toBe(0);

    // 3回連続で同じ場所（A→B→A の往復）も避ける（§4-5）
    let pingPong = 0;
    for (let i = 2; i < history.length; i++) {
      if (history[i] === history[i - 2]) pingPong++;
    }
    expect(pingPong, `履歴: ${history.join(' → ')}`).toBe(0);

    // 順番を固定にしない（§4-5）。20周まわせば全部の草むらを踏む
    expect(new Set(history).size).toBe(NOHARA.spots.length);
  });

  it('種を変えても、即戻りは 0 回のまま', () => {
    // 1つの種でたまたま通っただけ、を防ぐ。
    // 即戻りが起きないのは抽選の運ではなく、候補から外してあるから
    for (const seed of [1, 7, 99, 4242, 987654]) {
      const history = runLaps(chaseRig(seed), 20);
      for (let i = 1; i < history.length; i++) {
        expect(history[i], `seed=${seed} 履歴: ${history.join(' → ')}`).not.toBe(history[i - 1]);
      }
    }
  });

  it('ばあ→移動→隠れ終わりが 6秒以内に完了する', () => {
    const { spots, chase, advance } = chaseRig();
    const start = chase.getAnswerSpot();

    spots.tap(start);
    let elapsed = 0;
    let done = Infinity;
    advance(8, () => {
      if (done === Infinity && chase.getLaps() === 1) done = elapsed;
      elapsed += DT;
    });

    // §4-5 の想定は 4.80秒。§11-4 の合格ラインは 6秒以内
    expect(done).toBeLessThanOrEqual(6);
    // 表どおりに 4.80秒であること（1フレームぶんの丸めを許す）
    const expected = PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + CHASE_MOVE_SEC;
    expect(expected).toBeCloseTo(4.8, 5);
    expect(done).toBeGreaterThanOrEqual(expected - DT * 2);
    expect(done).toBeLessThanOrEqual(expected + DT * 2);
  });

  it('§4-5 のタイミング表どおりに段階が進む', () => {
    // 表の各行を、実測した時刻で押さえる。
    // ここが落ちたら、設計書の表か実装のどちらかがずれている
    const { spots, chase, advance } = chaseRig();
    spots.tap(chase.getAnswerSpot());

    const firstAt = new Map<string, number>();
    let elapsed = 0;
    advance(6, () => {
      const phase = chase.getPhase();
      if (!firstAt.has(phase)) firstAt.set(phase, elapsed);
      elapsed += DT;
    });

    const tapToMove = PEAK_AT_SEC + CHASE_OUT_IDLE_SEC; // 1.70s
    const near = (actual: number | undefined, want: number, label: string) => {
      expect(actual, label).toBeDefined();
      expect(Math.abs(actual! - want), `${label} 実測 ${actual?.toFixed(3)}s / 表 ${want}s`).toBeLessThanOrEqual(2 * DT);
    };

    near(firstAt.get('aim'), tapToMove, '予告のはじまり（表 1.70s）');
    near(firstAt.get('hop'), tapToMove + AIM_SEC, 'ジャンプのはじまり（表 2.10s）');
    near(firstAt.get('look'), tapToMove + AIM_SEC + HOP_SEC, '到着（表 3.60s）');
    near(
      firstAt.get('burrow'),
      tapToMove + AIM_SEC + HOP_SEC + LOOK_SEC,
      'もぐりはじめ（表 3.90s）'
    );
    // 表の内訳がそのまま 4.80秒になっていること
    expect(AIM_SEC + HOP_SEC + LOOK_SEC + BURROW_SEC).toBeCloseTo(CHASE_MOVE_SEC, 5);
    expect(tapToMove + CHASE_MOVE_SEC).toBeCloseTo(4.8, 5);
  });

  it('跳んでいるあいだ、弧を描いて上下する（直線の平行移動にしない）', () => {
    // §4-5「直線の平行移動は『滑って移動した』に見えて、
    // 1歳半の目には追いづらい。上下動があると視線が乗る」
    const { spots, chase, animals, advance } = chaseRig();
    spots.tap(chase.getAnswerSpot());

    const slot = animals.getOnlySlot()!;
    const world = new THREE.Vector3();
    const heights: number[] = [];
    advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + AIM_SEC + HOP_SEC + 0.05, () => {
      if (chase.getPhase() === 'hop') {
        slot.built.group.getWorldPosition(world);
        heights.push(world.y);
      }
    });

    expect(heights.length).toBeGreaterThan(60);

    // 山の数を数える。§4-5 の「3〜4回の弧」
    let peaks = 0;
    for (let i = 1; i < heights.length - 1; i++) {
      if (heights[i] > heights[i - 1] && heights[i] >= heights[i + 1]) peaks++;
    }
    expect(peaks).toBeGreaterThanOrEqual(3);
    expect(peaks).toBeLessThanOrEqual(4);

    // 弧の高さが出ていること（直線なら 0 に近くなる）
    const lo = Math.min(...heights);
    const hi = Math.max(...heights);
    expect(hi - lo).toBeGreaterThan(0.5);
  });

  it('移動中の水平方向は等速（加減速をつけない）', () => {
    // §4-5「移動中の速度は一定にする。加減速をつけると追いづらい」
    const { spots, chase, animals, advance } = chaseRig();
    spots.tap(chase.getAnswerSpot());

    const slot = animals.getOnlySlot()!;
    const world = new THREE.Vector3();
    const xs: number[] = [];
    advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + AIM_SEC + HOP_SEC + 0.05, () => {
      if (chase.getPhase() === 'hop') {
        slot.built.group.getWorldPosition(world);
        xs.push(world.x);
      }
    });

    const steps: number[] = [];
    for (let i = 1; i < xs.length; i++) steps.push(Math.abs(xs[i] - xs[i - 1]));
    const lo = Math.min(...steps);
    const hi = Math.max(...steps);
    // 完全な等速。丸め誤差ぶんしか散らばらない
    expect(hi - lo).toBeLessThan(1e-6);
  });

  it('うさぎは常に1箇所にだけ居る', () => {
    // ここが崩れると「空の場所が3つ」という前提（§4-6）ごと壊れる
    const rigging = chaseRig();
    const { spots, chase, advance } = rigging;
    for (let lap = 0; lap < 6; lap++) {
      spots.tap(chase.getAnswerSpot());
      advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + CHASE_MOVE_SEC + 0.2, () => {
        const occupied = spots.runtimes.filter((s) => s.occupied);
        expect(occupied.length).toBeLessThanOrEqual(1);
      });
      expect(spots.runtimes.filter((s) => s.occupied)).toHaveLength(1);
    }
  });

  it('移動が終わると、うさぎは移動先に完全に隠れる（ヒントを出さない）', () => {
    // **モードBはヒントを出さない。** 出さなくてよいと人間が決めた（2026-09-05）。
    // 理由: 外したときに正解の草むらが揺れて教えるので（§4-6）、
    // 草から体の一部を出す必要がない。§4-5 の表の「ヒント＝移動そのもの」とも合う。
    const { spots, chase, animals, advance } = chaseRig();
    spots.tap(chase.getAnswerSpot());
    advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + CHASE_MOVE_SEC + 0.3);

    const home = chase.getAnswerSpot();
    expect(chase.getPhase()).toBe('idle');
    expect(home.state).toBe('hidden');

    const slot = animals.getSlot(home.config.id)!;
    // 跳んでいる最中の「driven」が解けている（次のタップで普通に出られる）
    expect(slot.driven).toBe(false);
    expect(slot.showHint).toBe(false);
    expect(slot.built.hint.visible).toBe(false);

    // **体は1点も見えていない。** ヒントを消したぶん、ここは厳しく見る
    const e = animals.getExposure(home)!;
    expect(e.fraction).toBe(0);
    expect(e.bottomFraction).toBeLessThan(0.01);
  });

  it('移動先を押せば、そこから出てくる（次の周が回る）', () => {
    const { spots, chase, advance } = chaseRig();
    spots.tap(chase.getAnswerSpot());
    advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + CHASE_MOVE_SEC + 0.3);

    const home = chase.getAnswerSpot();
    expect(spots.tap(home)).toBe(true);
    advance(PEAK_AT_SEC + DT);
    // 移動先でも、ふつうに「ばあ！」ができる
    expect(home.reveal).toBe(1);
    expect(home.state).toBe('out');
  });
});

describe('全場面 — どの場面でも不変条件が成り立つ', () => {
  // ==========================================================================
  // **場面を足したら、ここが自動で見る。**
  // おうちとのはらだけを見ていたときに、そと・うみ・のうじょう の
  // 動物が隠れ場所に入りきらない（下からはみ出す・隙間から見える）のを
  // 何度も見落とした。1場面ずつ書かず、`SCENES` を回すこと。
  // ==========================================================================

  it.each(HIDEOUT_SCENES)('%s: 隠れ場所がちょうど4箇所ある（§5-3）', (id) => {
    // 4箇所より多くすると1つあたりが小さくなり、1歳半の指では押しにくくなる
    expect(findScene(id).spots).toHaveLength(4);
  });

  it('のはらだけ5箇所（人間が決めた）', () => {
    // §5-3 は「4箇所より多くしない」だが、モードBは「どこへ行ったかを追う」
    // 遊びなので、行き先が1つ多いほうが追いがいがある。**人間が決めた**（2026-09-05）。
    // 代わりに当たり判定は 101.4px → 90.1px に縮む（`data/scenes.ts` の実測）。
    // モードAの場面は4箇所のままであることを、上のテストが見張っている
    expect(findScene('nohara').spots).toHaveLength(5);
  });

  it('同じ動物が2つの場面に出ていない', () => {
    // 場面が違っても同じ動物が出てくると「新しい場所」に見えない。
    // 常駐と走り手（モードB）の両方を数える
    const used: string[] = [];
    for (const scene of SCENES) {
      for (const spot of scene.spots) used.push(...spot.animals);
      if (scene.runner) used.push(scene.runner);
    }
    const dup = used.filter((v, i) => used.indexOf(v) !== i);
    expect(dup, `重複: ${dup.join(', ')}`).toEqual([]);
    // 使っている動物が、定義してある動物とずれていないことも見る
    for (const id of used) expect(ANIMALS.some((a) => a.id === id), id).toBe(true);
  });

  it('輪郭の指定が同じ動物が2体いない', () => {
    // **色だけ違う動物は「同じ動物」に見える**（§5-2）。
    // はりねずみを、ねずみと同じ「丸い耳＋とがった鼻」で作っていたときに
    // 実際にそう見えた。体の作り・頭の上・鼻・尾・表面の組み合わせで見る
    const seen = new Map<string, string>();
    for (const a of ANIMALS) {
      const key = [a.bodyPlan, a.headTop, a.snout, a.tail, a.coat ?? 'plain'].join('/');
      const other = seen.get(key);
      expect(other, `${a.id} と ${other} が同じ輪郭（${key}）`).toBeUndefined();
      seen.set(key, a.id);
    }
  });

  it.each(ALL_SCENES)('%s: どの隠れ場所を押しても反応が返る（不変条件1・3b）', (id) => {
    const { spots } = sceneRig(id);
    for (const spot of spots.runtimes) {
      expect(spots.tap(spot), `${id}/${spot.config.id}`).toBe(true);
      expect(spot.shake, `${id}/${spot.config.id}`).toBeGreaterThan(0);
    }
    expect(spots.getResponseCount()).toBe(spots.runtimes.length);
  });

  it.each(HIDEOUT_SCENES)('%s: 押すと必ず out まで到達する（§4-1）', (id) => {
    // **1体ずつ押す**（2026-09-07 に人間が決めた「1体ずつしか出さない」）。
    // まとめて押すと、2体目から先は順番待ちになるのが正しい姿。
    // それは下の「別の子が出ているあいだは…」で見る
    const { spots, advance } = sceneRig(id);
    for (const spot of spots.runtimes) {
      spots.tap(spot);
      advance(PEAK_AT_SEC + DT);
      expect(spot.state, `${id}/${spot.config.id}`).toBe('out');
      expect(spot.reveal, `${id}/${spot.config.id}`).toBe(1);
      // 次の子のために、引っ込みきるまで待つ
      advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.2);
      expect(spot.state, `${id}/${spot.config.id}`).toBe('hidden');
    }
  });

  it.each(HIDEOUT_SCENES)('%s: 隠れていても縁から見えている（不変条件3 / §4-2）', (id) => {
    const { spots, animals, advance } = sceneRig(id);
    advance(0.5);
    for (const spot of spots.runtimes) {
      const e = animals.getExposure(spot);
      expect(e, `${id}/${spot.config.id} に動物が居ない`).not.toBeNull();
      expect(e!.fraction, `${id}/${spot.config.id}`).toBeGreaterThanOrEqual(0.15);
      expect(e!.fraction, `${id}/${spot.config.id}`).toBeLessThanOrEqual(0.25);
    }
  });

  it.each(ALL_SCENES)('%s: 隠れ場所の上下から体がはみ出していない', (id) => {
    const { spots, animals, advance } = sceneRig(id);
    advance(0.5);
    for (const spot of spots.runtimes) {
      const e = animals.getExposure(spot);
      if (!e) continue; // モードBの空の3箇所
      expect(e.bodyFraction, `${id}/${spot.config.id} の顔が縁から見えている`).toBeLessThan(0.01);
      expect(e.bottomFraction, `${id}/${spot.config.id} が下にはみ出している`).toBeLessThan(0.01);
    }
  });

  it.each([
    ...ALL_SCENES.map((id) => [id, false] as const),
    ...ALL_SCENES.map((id) => [id, true] as const),
  ])('%s（絵=%s）: 隠れているあいだ、体はどこからも覗けない', (id, useCutouts) => {
    // **絵を貼った版（道A）も見ること。**
    // 手続き生成だけ見ていたら、うみ の すいめん で
    // **クマノミが丸ごと画面に出ていた**（2026-09-07 に実機で発覚）。
    // 板は z = animalZ + 0.26 に立つので、手続き生成の体（z = -0.4〜0.0）より
    // 前に出る。前板がその手前に無い隠れ場所では、そのまま見えてしまう。
    // 格子は隙間の幅より細かく。7×9 では 0.05 幅の隙間をすり抜けた
    const COLS = 15;
    const ROWS = 15;
    const { spots, animals, camera, advance } = sceneRig(id, 12345, useCutouts);
    advance(0.5);

    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const box = new THREE.Box3();

    for (const spot of spots.runtimes) {
      const slot = animals.getSlot(spot.config.id);
      if (!slot) continue;
      spots.group.updateWorldMatrix(true, true);

      box.makeEmpty();
      for (const child of slot.built.group.children) {
        if (child === slot.built.hint) continue;
        box.expandByObject(child);
      }

      const leaks: string[] = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          target.set(
            box.min.x + ((box.max.x - box.min.x) * (c + 0.5)) / COLS,
            box.min.y + ((box.max.y - box.min.y) * (r + 0.5)) / ROWS,
            box.max.z
          );
          dir.subVectors(target, camera.position).normalize();
          ray.set(camera.position, dir);
          ray.far = Infinity;
          const hits = ray.intersectObject(spots.group, true);
          if (hits.length === 0) continue;
          const first = hits[0].object;
          if (isDescendantOf(first, slot.built.group) && !isDescendantOf(first, slot.built.hint)) {
            // 絵を貼った動物は、板の透明なところに当たっても見えていない
            const uv = hits[0].uv;
            if (useCutouts && uv && !isOpaqueAt(slot.config.id, uv)) continue;
            leaks.push(`(${c},${r})`);
          }
        }
      }
      expect(
        leaks.length,
        `${id}/${spot.config.id}（絵=${useCutouts}）: 隠れているのに体が ${leaks.length}/${COLS * ROWS} 点で見えている ${leaks.join(' ')}`
      ).toBe(0);
    }
  });

  /**
   * **出きったときに、体がカメラから見えていること。**
   *
   * この不変条件はテストが無く、実機で「ねことうしの隠れ場所が開いた時に
   * 画像と被って見えなくなっている」と報告されて初めて分かった（2026-09-06）。
   *
   * 原因は、絵を貼った動物には厚みが無く、置き場（animalZ = −0.20）に
   * ぴったり立つこと。手続き生成の動物は厚み 0.4 を持っていて z = −0.4〜0.0 を
   * 占めていたので、前板（z = +0.22）との隙間が詰まっていた。
   * **「縁より上に出ている高さ」は 1.29 あって正常だった。**
   * 高さだけ見ていると気づけない。カメラから見て当たるかで見る。
   */
  it.each([...HIDEOUT_SCENES.map((id) => [id, false] as const), ...HIDEOUT_SCENES.map((id) => [id, true] as const)])(
    '%s（絵=%s）: 出きったとき、体がカメラから見えている',
    (id, useCutouts) => {
      const COLS = 9;
      const ROWS = 9;
      /** 見かけの矩形のうち、これだけの割合が体でなければならない */
      const NEED = 0.55;

      const { spots, animals, camera, advance } = sceneRig(id, 12345, useCutouts);
      advance(0.5);
      const ray = new THREE.Raycaster();
      const target = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const box = new THREE.Box3();

      for (const spot of spots.runtimes) {
        const slot = animals.getSlot(spot.config.id);
        if (!slot) continue;
        // **1体ずつ出す**（2026-09-07 の「1体ずつしか出さない」）。
        // まとめて押すと2体目から順番待ちになり、隠れたまま測ってしまう
        spots.tap(spot);
        advance(PEAK_AT_SEC + DT);
        // **出ているあいだの、いちばん見えていない瞬間で判定する。**
        // 出たあとの癖（§6-2）で位置が動くので、1点だけ見ても足りない
        let worst = 1;
        let worstAt = 0;
        for (let step = 0; step < 8; step++) {
          spots.group.updateWorldMatrix(true, true);
          const r = visibleRatio(slot, spots, camera, ray, box, target, dir, COLS, ROWS);
          if (r < worst) {
            worst = r;
            worstAt = step;
          }
          advance(0.18);
        }
        expect(
          worst,
          `${id}/${spot.config.id}: 出ているあいだ、体が ${(worst * 100).toFixed(0)}% しか見えていない瞬間がある（${(worstAt * 0.18).toFixed(2)}s）`
        ).toBeGreaterThanOrEqual(NEED);
        advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.2);
      }
    }
  );

  it.each([
    ...ALL_SCENES.map((id) => [id, false] as const),
    ...ALL_SCENES.map((id) => [id, true] as const),
  ])('%s（絵=%s）: 出きった動物が、ほかの隠れ場所に重ならない', (id, useCutouts) => {
    // ==========================================================================
    // **上の段の隠れ場所に覆いかぶさらないこと**（2026-09-07 に実機で指摘）。
    // 「猿が『ばあっ！』すると上の隠れ場所と被っています」
    //
    // 出きった動物は縁より `height * OUT_LIFT` 上に出る。絵を隠れ場所いっぱいに
    // 合わせた結果、下の段の動物が上の段に食い込んでいた。
    // 実測（直す前）: さる→きげあーす 0.92×0.39 / きかぶ→おおいわ 1.04×0.45 /
    // つぼ→かいそう 0.95×0.31 / ほら→くさ 1.19×0.05 / おけご→わら 0.73×0.19
    // ==========================================================================
    const { spots, animals, advance } = sceneRig(id, 12345, useCutouts);
    advance(0.5);

    const abox = new THREE.Box3();
    const obox = new THREE.Box3();
    for (const spot of spots.runtimes) {
      const slot = animals.getSlot(spot.config.id);
      if (!slot) continue;
      spots.tap(spot);
      // 出きったあと、癖（§6-2）が乗りきるところまで見る
      advance(PEAK_AT_SEC + 0.5);
      spots.group.updateWorldMatrix(true, true);

      abox.makeEmpty();
      for (const child of slot.built.group.children) {
        if (child === slot.built.hint) continue;
        abox.expandByObject(child);
      }
      for (const other of spots.runtimes) {
        if (other === spot) continue;
        obox.setFromObject(other.shape.group);
        const ox = Math.min(abox.max.x, obox.max.x) - Math.max(abox.min.x, obox.min.x);
        const oy = Math.min(abox.max.y, obox.max.y) - Math.max(abox.min.y, obox.min.y);
        expect(
          ox > 0 && oy > 0,
          `${id}/${spot.config.id} が ${other.config.id} に ${ox.toFixed(2)}×${oy.toFixed(2)} 重なっている`
        ).toBe(false);
      }
      advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.3);
    }
  });

  it.each(HIDEOUT_SCENES)('%s: ヒントがカメラから遮られずに見えている', (id) => {
    const { spots, animals, camera, advance } = sceneRig(id);
    advance(0.5);
    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const box = new THREE.Box3();

    for (const spot of spots.runtimes) {
      const slot = animals.getSlot(spot.config.id)!;
      spots.group.updateWorldMatrix(true, true);
      box.setFromObject(slot.built.hint);
      box.getCenter(target);
      target.y = box.max.y - (box.max.y - box.min.y) * 0.2;

      dir.subVectors(target, camera.position);
      const distance = dir.length();
      ray.set(camera.position, dir.normalize());
      ray.far = distance - 0.02;

      const blockers = ray
        .intersectObject(spots.group, true)
        .filter((b) => !isDescendantOf(b.object, slot.built.hint));
      expect(
        blockers.map((b) => b.object.name || b.object.type),
        `${id}/${spot.config.id}: ヒントが見えていない`
      ).toEqual([]);
    }
  });

  it.each(HIDEOUT_SCENES)('%s: 隠れ場所が動物の断面の 0.86 倍以上を覆う（§4-2）', (id) => {
    const { spots, animals } = sceneRig(id);
    for (const spot of spots.runtimes) {
      const fit = animals.getFit(spot)!;
      expect(fit.mouthWidth, `${id}/${spot.config.id}`).toBeGreaterThanOrEqual(
        fit.animalWidth * 0.86
      );
    }
  });

  it.each(HIDEOUT_SCENES)('%s: 4体のヒントが全部違う形（§4-2）', (id) => {
    // 同じ形が2つあると、どの場所に誰が居るかを形で覚えられない
    const parts = findScene(id).spots.map((spot) => {
      const animal = ANIMALS.find((a) => a.id === spot.animals[0]);
      return animal?.hintPart;
    });
    expect(new Set(parts).size, `${id}: ${parts.join(' / ')}`).toBe(parts.length);
  });

  it.each(ALL_SCENES)('%s: 当たり判定どうしが重ならない（§3-2）', (id) => {
    const { spots } = sceneRig(id);
    const tester = fakeTester(40); // 設定値のままなら全部重なる縮尺
    spots.projectAll(tester);
    const pts = spots.runtimes.map((s) => {
      const p = { x: 0, y: 0 };
      tester.project(s.worldPosition, p);
      return p;
    });
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        expect(
          spots.radiusAt(i) + spots.radiusAt(j),
          `${id}: ${spots.runtimes[i].config.id}-${spots.runtimes[j].config.id}`
        ).toBeLessThan(d);
      }
    }
  });
});

describe('場面ごとの味つけ（2026-09-07。人間が決めた「スペシャル」）', () => {
  it('味つけを指定していない場面では、何も起きない', () => {
    // **既定は「何もしない」。** 場面を足したときに、うっかり演出が付かない
    const { spots } = sceneRig('ouchi');
    const flavor = new Flavor(spots.runtimes, undefined);
    for (let f = 0; f < 60 * 3; f++) flavor.update(DT);

    expect(flavor.getPropCount()).toBe(0);
    expect(flavor.getCrossingCount()).toBe(0);
    expect(flavor.getFootstepCount()).toBe(0);
    expect(flavor.getMaxTiltRad()).toBe(0);
    expect(flavor.group.children).toHaveLength(0);
  });

  it.each(ALL_SCENES)('%s: 味つけは隠れ場所を動かさない（当たり判定がずれない）', (id) => {
    // 当たり判定は `worldPosition`（設定した座標）を投影して決まる。
    // 見た目だけ動かすと「押したのに反応しない」に近づく（みずのなかの岩）。
    // **傾けるのは許す**（中心が動かないので判定はずれない）
    const { spots, flavor, advance } = sceneRig(id);
    const before = spots.runtimes.map((s) => s.group.position.clone());
    const world = spots.runtimes.map((s) => s.worldPosition.clone());

    for (const spot of spots.runtimes) spots.tap(spot);
    advance(4);

    for (let i = 0; i < spots.runtimes.length; i++) {
      const s = spots.runtimes[i];
      expect(s.group.position.distanceTo(before[i]), `${id}/${s.config.id}`).toBe(0);
      expect(s.worldPosition.distanceTo(world[i]), `${id}/${s.config.id}`).toBe(0);
    }
    void flavor;
  });

  it.each(ALL_SCENES)('%s: 味つけの傾きでも、隠れている体は覗けない（不変条件3）', (id) => {
    // ==========================================================================
    // **これが「場面ごとの味つけ」でいちばん危ないところ。**
    // 隠れ場所を傾けると、隠しているふたと動物の見かけの関係が変わる。
    // 実測（2026-09-07）: **うみ の かいそう は 0.75° で体が見えた。**
    // だから常時のゆれ（`sway`）は飾りだけにして、隠れ場所を回すのは
    // ため のもぞもぞ（1.7°）と地ひびき（2.9°）だけにしてある。
    // ここでは**その2倍**を掛けて、余裕が残っていることまで見る。
    // 新しい場面に `wobble` / `quake` を付けたら、ここが落ちて教える。
    // ==========================================================================
    const COLS = 15;
    const ROWS = 15;
    const tilt = maxSpotTiltRad(findScene(id).flavor) * 2;
    const { spots, animals, camera, advance } = sceneRig(id);
    advance(0.5);
    if (tilt === 0) return; // 隠れ場所を回さない場面。上の全場面テストが見ている

    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const box = new THREE.Box3();

    for (const sign of [1, -1]) {
      for (const spot of spots.runtimes) spot.group.rotation.z = tilt * sign;
      spots.group.updateWorldMatrix(true, true);

      for (const spot of spots.runtimes) {
        const slot = animals.getSlot(spot.config.id);
        if (!slot) continue;
        box.makeEmpty();
        for (const child of slot.built.group.children) {
          if (child === slot.built.hint) continue;
          box.expandByObject(child);
        }
        let leaks = 0;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            target.set(
              box.min.x + ((box.max.x - box.min.x) * (c + 0.5)) / COLS,
              box.min.y + ((box.max.y - box.min.y) * (r + 0.5)) / ROWS,
              box.max.z
            );
            dir.subVectors(target, camera.position).normalize();
            ray.set(camera.position, dir);
            ray.far = Infinity;
            const hits = ray.intersectObject(spots.group, true);
            if (hits.length === 0) continue;
            const first = hits[0].object;
            if (isDescendantOf(first, slot.built.group) && !isDescendantOf(first, slot.built.hint)) {
              leaks++;
            }
          }
        }
        expect(
          leaks,
          `${id}/${spot.config.id}: ${((tilt * sign * 180) / Math.PI).toFixed(2)}° 傾けたら ${leaks}/${COLS * ROWS} 点で体が見えた`
        ).toBe(0);
      }
    }
  });

  it.each(ALL_SCENES)('%s: 味つけが足すものは、必ず隠れ場所より奥にある', (id) => {
    // 手前に置くと、隠れている動物を覆って「見えている」を壊せてしまう。
    // **奥にあれば原理的に起きない。** 位置で保証する。
    // **作った直後だけでなく、走らせたあとも見る**（あぶく・足あと・花と卵は
    // あとから足されるので、作った直後だけ見ていても意味がない）
    const scene = findScene(id);
    const { spots, flavor, advance } = sceneRig(id);
    const minSpotZ = Math.min(...scene.spots.map((s) => s.position[2]));

    const check = (when: string) => {
      for (const child of flavor.group.children) {
        expect(child.position.z, `${id} の飾りが隠れ場所より手前（${when}）`).toBeLessThan(minSpotZ);
      }
    };
    check('作った直後');
    // 出して引っ込めるところまで回す（花・卵が残る）
    for (const spot of spots.runtimes) spots.tap(spot);
    advance(6);
    check('1周したあと');
    advance(20);
    check('しばらく置いたあと');
  });

  it('風は左から右へ渡る（いっせいに傾かない）', () => {
    // 全部同じ位相にすると、風ではなく地震に見えた
    const { spots } = sceneRig('soto');
    const flavor = new Flavor(spots.runtimes, { sway: 'wind' }, { seed: 7 });
    for (let f = 0; f < 60 * 2; f++) flavor.update(DT);

    expect(flavor.getPropCount()).toBe(PROP_COUNT);
    const tilts = flavor.group.children.map((c) => c.rotation.z);
    const spread = Math.max(...tilts) - Math.min(...tilts);
    expect(spread).toBeGreaterThan(0.05);
    expect(flavor.getMaxPropTiltRad()).toBeLessThanOrEqual(WIND_AMP_RAD + 1e-6);
    flavor.dispose();
  });

  it('水のゆれは、風より深く、上限を超えない', () => {
    const { spots } = sceneRig('umi');
    const flavor = new Flavor(spots.runtimes, { sway: 'water' }, { seed: 7 });
    let max = 0;
    for (let f = 0; f < 60 * 30; f++) {
      flavor.update(DT);
      max = Math.max(max, flavor.getMaxPropTiltRad());
    }
    expect(max).toBeGreaterThan(WIND_AMP_RAD);
    expect(max).toBeLessThanOrEqual(WATER_AMP_RAD + WATER_AMP2_RAD + 1e-6);
    flavor.dispose();
  });

  it('もぞもぞは ため のあいだだけ（出ているあいだは傾かない）', () => {
    const { spots } = sceneRig('ouchi');
    const flavor = new Flavor(spots.runtimes, { wobble: true }, { seed: 3 });
    const spot = spots.runtimes[0];

    spots.tap(spot);
    let duringTame = 0;
    let afterTame = 0;
    for (let f = 0; f < 60 * 3; f++) {
      spots.update(DT);
      flavor.update(DT);
      const tilt = Math.abs(spot.group.rotation.z);
      if (spot.state === 'appearing' && spot.delay > 0) duringTame = Math.max(duringTame, tilt);
      else afterTame = Math.max(afterTame, tilt);
    }
    expect(duringTame).toBeGreaterThan(0);
    expect(duringTame).toBeLessThanOrEqual(WOBBLE_AMP_RAD + 1e-6);
    expect(afterTame).toBe(0);
    flavor.dispose();
  });

  it('地ひびきは出きった瞬間に始まり、0.45秒で止まる', () => {
    const { spots } = sceneRig('kyoryu');
    const flavor = new Flavor(spots.runtimes, { quake: true }, { seed: 3 });
    const spot = spots.runtimes[0];

    spots.tap(spot);
    let startedAt = Infinity;
    let endedAt = Infinity;
    for (let f = 0; f < 60 * 3; f++) {
      spots.update(DT);
      flavor.update(DT);
      if (startedAt === Infinity && flavor.isQuaking()) startedAt = f * DT;
      if (startedAt !== Infinity && endedAt === Infinity && !flavor.isQuaking()) endedAt = f * DT;
    }
    // §4-3 の山（0.50s）で始まる。1フレームぶんの丸めを許す
    expect(startedAt).toBeGreaterThanOrEqual(PEAK_AT_SEC - DT);
    expect(startedAt).toBeLessThanOrEqual(PEAK_AT_SEC + DT);
    expect(endedAt - startedAt).toBeLessThanOrEqual(QUAKE_SEC + DT);
    flavor.dispose();
  });

  it('足音は ため のあいだに2回だけ', () => {
    const { spots } = sceneRig('kyoryu');
    const flavor = new Flavor(spots.runtimes, { footstep: true }, { seed: 3 });
    const spot = spots.runtimes[0];
    const at: number[] = [];
    flavor.onFootstep(() => at.push(spot.reveal));

    spots.tap(spot);
    for (let f = 0; f < 60 * 3; f++) {
      spots.update(DT);
      flavor.update(DT);
    }
    expect(at).toHaveLength(FOOTSTEP_AT_SEC.length);
    // **出はじめる前に鳴りきる。** 出てから鳴ると「誰が歩いたのか」が分からない
    for (const reveal of at) expect(reveal).toBe(0);
    flavor.dispose();
  });

  it('横切るものは、画面の外から入って外へ抜ける（途中で消えない）', () => {
    const { spots } = sceneRig('soto');
    const flavor = new Flavor(spots.runtimes, { crossing: 'butterfly' }, { seed: 11 });
    const obj = flavor.group.children[0];

    let minX = Infinity;
    let maxX = -Infinity;
    let visibleFrames = 0;
    for (let f = 0; f < Math.round((CROSS_SEC + CROSS_GAP_SEC * 2) / DT); f++) {
      flavor.update(DT);
      if (!obj.visible) continue;
      visibleFrames++;
      minX = Math.min(minX, obj.position.x);
      maxX = Math.max(maxX, obj.position.x);
    }
    expect(flavor.getCrossingCount()).toBeGreaterThanOrEqual(1);
    expect(visibleFrames).toBeGreaterThan(0);
    // 端から端まで。**途中で消えたら、見ている子には「消えた」に見える**
    expect(minX).toBeLessThanOrEqual(-CROSS_X * 0.9);
    expect(maxX).toBeGreaterThanOrEqual(CROSS_X * 0.9);
    flavor.dispose();
  });

  it('捨てたら、傾きが戻って何も残らない', () => {
    const { spots } = sceneRig('kyoryu');
    const flavor = new Flavor(spots.runtimes, { quake: true, sway: 'wind', crossing: 'butterfly' }, { seed: 3 });
    spots.tap(spots.runtimes[0]);
    for (let f = 0; f < 60; f++) {
      spots.update(DT);
      flavor.update(DT);
    }
    flavor.dispose();

    expect(flavor.group.children).toHaveLength(0);
    for (const s of spots.runtimes) expect(s.group.rotation.z).toBe(0);
  });
});

describe('§6-1 毎回変わるもの（速さ・大きさ・声）', () => {
  /** ばらつきの乱数を固定した SpotSystem。**共有の乱数に相乗りしない**（§6-1） */
  const seeded = (seed: number) => new SpotSystem(OUCHI.spots, undefined, seed);

  it('登場の速さは回ごとに変わる（±10% を超えない）', () => {
    const spots = seeded(12345);
    const spot = spots.runtimes[0];
    const seen = new Set<number>();

    // 出る → 引っ込む を繰り返して、そのたびの speedVar を集める
    for (let i = 0; i < 40; i++) {
      spots.tap(spot);
      seen.add(spot.speedVar);
      expect(spot.speedVar).toBeGreaterThanOrEqual(1 - SPEED_VAR);
      expect(spot.speedVar).toBeLessThanOrEqual(1 + SPEED_VAR);
      // 次のタップまで、いったん hidden に戻す
      for (let f = 0; f < 60 * 4; f++) spots.update(DT);
      expect(spot.state).toBe('hidden');
    }

    // 「毎回変わる」が効いていること。同じ値ばかりなら §6-1 は死んでいる
    expect(seen.size).toBeGreaterThanOrEqual(30);
  });

  it('速さが変わっても、山（§4-3 の 0.50s）は必ず同じ時刻に来る', () => {
    // **これが §6-1 のいちばん危ないところ。**
    // 速さをそのまま伸ばすと、登場が 0.35秒 を超えて不変条件4 が壊れ、
    // §4-5 の 1周 4.80s もその回ごとにずれる（実際に安全テスト5件が落ちた）。
    // 速くなったぶんは ため を伸ばして吸収する。
    const frames: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const spots = seeded(seed);
      const spot = spots.runtimes[0];
      spots.tap(spot);
      let at = Infinity;
      for (let f = 0; f < 60; f++) {
        spots.update(DT);
        if (at === Infinity && spot.reveal >= 1) at = f + 1;
      }
      frames.push(at);
    }

    const peakFrames = Math.round(PEAK_AT_SEC / DT);
    for (const f of frames) expect(f).toBe(peakFrames);
  });

  it('ため の無い呼び戻しでは、遅い側に振らない（不変条件4）', () => {
    // `hiding` → `appearing` は ため を挟まないので、吸収先が無い。
    // ここで遅い側に振ると、そのぶん登場が 0.35秒 を超える
    for (let seed = 1; seed <= 60; seed++) {
      const spots = seeded(seed);
      const spot = spots.runtimes[0];
      spots.tap(spot);
      // out を過ぎて hiding の途中まで進める
      for (let f = 0; f < 60 * 3; f++) {
        spots.update(DT);
        if (spot.state === 'hiding') break;
      }
      for (let f = 0; f < 6; f++) spots.update(DT);
      expect(spot.state).toBe('hiding');

      spots.tap(spot);
      expect(spot.speedVar).toBeLessThanOrEqual(1);
      expect(spot.speedVar).toBeGreaterThanOrEqual(1 - SPEED_VAR);
    }
  });

  it('大きさのばらつきは、隠れているあいだ効かない（§4-2）', () => {
    // 隠れているときの見え方は不変条件3 が数値で押さえてある。
    // そこに ±10% を掛けると、はみ出し量がその回ごとに変わって
    // 「見えている」の判定が運任せになる
    const { spots, animals, camera, advance } = rig();
    const spot = spots.runtimes[0];
    const slot = animals.getSlot(spot.config.id);
    expect(slot).not.toBeNull();
    if (!slot) return;

    animals.update(DT, spots, camera);
    expect(slot.built.group.scale.x).toBeCloseTo(slot.fitScale, 10);

    spots.tap(spot);
    // 山の直後は §4-4 のオーバーシュート（1.15倍）が乗っているので、
    // 落ち着く（`POP_SETTLE_SEC` 0.22s）まで待ってから測る
    advance(PEAK_AT_SEC + 0.3);
    const out = slot.built.group.scale.x / slot.fitScale;
    expect(out).toBeGreaterThanOrEqual(1 - SIZE_VAR - 1e-6);
    expect(out).toBeLessThanOrEqual(1 + SIZE_VAR + 1e-6);

    // 引っ込みきったら、また 1倍に戻っている
    advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.2);
    expect(spot.state).toBe('hidden');
    expect(slot.built.group.scale.x).toBeCloseTo(slot.fitScale, 10);
  });

  it('声のピッチは ±5% を超えない（別人の声にしない）', () => {
    const spots = seeded(777);
    const spot = spots.runtimes[0];
    for (let i = 0; i < 40; i++) {
      spots.tap(spot);
      expect(spot.voiceVar).toBeGreaterThanOrEqual(1 - VOICE_VAR);
      expect(spot.voiceVar).toBeLessThanOrEqual(1 + VOICE_VAR);
      for (let f = 0; f < 60 * 4; f++) spots.update(DT);
    }
  });
});

describe('味つけ〈中〉〈大〉（2026-09-07。人間が「弱い」と言って足した）', () => {
  it('横切るものは、ときどき隠れ場所にとまって、そこを揺らして教える', () => {
    const { spots } = sceneRig('soto');
    const flavor = new Flavor(
      spots.runtimes,
      { crossing: 'butterfly', crossingLands: true },
      { seed: 5 }
    );

    // **1回の抽選に頼らない。** とまるのは 2回に1回なので、
    // 何往復かぶん回して「いつかは必ずとまる」ことを見る
    let sawPerch = false;
    let shookAtPerch = false;
    for (let f = 0; f < Math.round(60 * (CROSS_SEC + PERCH_SEC + CROSS_GAP_SEC) * 8); f++) {
      flavor.update(DT);
      const perched = flavor.getPerchedSpotId();
      if (!perched) continue;
      sawPerch = true;
      // とまった場所が揺れている（§4-2 のヒントと同じ「ここだよ」）
      const spot = spots.runtimes.find((s) => s.config.id === perched);
      if (spot && spot.callShake > 0) shookAtPerch = true;
    }
    expect(sawPerch).toBe(true);
    expect(shookAtPerch).toBe(true);
    expect(flavor.getLandingCount()).toBeGreaterThanOrEqual(1);
    // **1回の横断でとまるのは1回まで。** 行き先を消し忘れると何十回もとまり直す
    expect(flavor.getLandingCount()).toBeLessThanOrEqual(flavor.getCrossingCount());
    flavor.dispose();
  });

  it('とまっても、最後は必ず画面の外へ抜ける（止まったままにならない）', () => {
    const { spots } = sceneRig('soto');
    const flavor = new Flavor(
      spots.runtimes,
      { crossing: 'butterfly', crossingLands: true },
      { seed: 5 }
    );
    const obj = flavor.group.children[0];

    let leftScreen = 0;
    for (let f = 0; f < Math.round((60 * (CROSS_SEC + PERCH_SEC + CROSS_GAP_SEC)) * 4); f++) {
      flavor.update(DT);
      if (!obj.visible) leftScreen++;
    }
    // 渡り終えて消えるフレームがある＝とまりっぱなしになっていない
    expect(leftScreen).toBeGreaterThan(0);
    flavor.dispose();
  });

  it('あぶくは上がり続け、押すと割れる', () => {
    const { spots } = sceneRig('umi');
    const flavor = new Flavor(spots.runtimes, { bubbles: true }, { seed: 9 });
    expect(flavor.getBubbles().count).toBe(BUBBLE_COUNT);

    for (let f = 0; f < 120; f++) flavor.update(DT);
    const before = flavor.group.children.map((c) => c.position.y);
    for (let f = 0; f < 120; f++) flavor.update(DT);
    const after = flavor.group.children.map((c) => c.position.y);
    // **上がっている**（1つでも上に動いていればよい。上端で戻るものがあるため）
    expect(after.some((y, i) => y > before[i])).toBe(true);

    // まん前を押したら割れる。**当たり判定は画面座標**（§7-3）
    const target = flavor.group.children[0];
    const tester = {
      project: () => true,
      distancePx: (world: THREE.Vector3) => (world.equals(target.position) ? 0 : 999),
    };
    expect(flavor.tap(100, 100, tester)).toBe(true);
    expect(flavor.getBubbles().popped).toBe(1);
    // **ふくらんでから消える。** ただ消すと「割れた」ではなく「消えた」に見える
    const scaleBefore = target.scale.x;
    for (let f = 0; f < 6; f++) flavor.update(DT);
    expect(target.visible).toBe(true);
    expect(target.scale.x).toBeGreaterThan(scaleBefore);
    for (let f = 0; f < 20; f++) flavor.update(DT);
    expect(target.visible).toBe(false);
    // 同じあぶくを続けて割れない（消えているあいだは当たらない）
    expect(flavor.tap(100, 100, tester)).toBe(false);
    flavor.dispose();
  });

  it('あぶきを押しても、隠れ場所のタップは1回も減らない（不変条件1）', () => {
    // あぶくが当たり判定を横取りしたら、「押したのに動物が出ない」ができる
    const { spots, flavor } = sceneRig('umi');
    const tester = fakeTester();
    let responses = 0;
    for (const spot of spots.runtimes) {
      const p = { x: 0, y: 0 };
      tester.project(spot.worldPosition, p);
      flavor.tap(p.x, p.y, tester);
      const hit = spots.pick(p.x, p.y, tester);
      expect(hit, spot.config.id).not.toBeNull();
      if (hit) responses += spots.tap(hit) ? 1 : 0;
    }
    expect(responses).toBe(spots.runtimes.length);
  });

  it('みんなで鳴くのは、全部が隠れているときだけ', () => {
    const { spots } = sceneRig('noujou');
    const flavor = new Flavor(spots.runtimes, { chorus: true }, { seed: 4 });

    // 1箇所を出したまま待つ → 鳴きはじめない
    spots.tap(spots.runtimes[0]);
    for (let f = 0; f < 60 * 2; f++) {
      spots.update(DT);
      flavor.update(DT);
    }
    expect(spots.runtimes[0].state).not.toBe('hidden');
    expect(flavor.getChorus().running).toBe(false);
  });

  it('みんなで鳴くとき、ふたは開けない（隠れている体が見えるため）', () => {
    // **実測（2026-09-07）: のうじょうの わら は extraOpen 0.10 で体が見えた。**
    // 開ける演出は空の隠れ場所にだけ許される（§4-6 / §4-5 の到着）
    const { spots } = sceneRig('noujou');
    const flavor = new Flavor(spots.runtimes, { chorus: true }, { seed: 4 });

    const calls: string[] = [];
    flavor.onCall((spot) => calls.push(spot.config.id));

    let maxOpen = 0;
    for (let f = 0; f < Math.round(60 * CHORUS_EVERY_SEC * 1.5); f++) {
      spots.update(DT);
      flavor.update(DT);
      for (const s of spots.runtimes) maxOpen = Math.max(maxOpen, s.extraOpen);
    }
    expect(flavor.getChorus().runs).toBeGreaterThanOrEqual(1);
    // 全員が1回ずつ鳴く
    expect(calls).toHaveLength(spots.runtimes.length);
    expect(new Set(calls).size).toBe(spots.runtimes.length);
    expect(maxOpen).toBe(0);
    flavor.dispose();
  });

  it('足あとは、跳ねるたびに増えて、放っておくと消える', () => {
    const { spots } = sceneRig('nohara');
    const flavor = new Flavor(spots.runtimes, { footprints: true }, { seed: 2 });

    for (let i = 0; i < 4; i++) flavor.dropFootprint(i * 0.5, 0);
    expect(flavor.getFootprintCount()).toBe(4);
    // **隠れ場所より手前に置く**（奥だと くさむら に隠れて見えない）
    expect(flavor.frontGroup.children).toHaveLength(4);
    for (const c of flavor.frontGroup.children) expect(c.position.z).toBeGreaterThan(0);

    for (let f = 0; f < 60 * 5; f++) flavor.update(DT);
    expect(flavor.getFootprintCount()).toBe(0);
    expect(flavor.frontGroup.children).toHaveLength(0);
    flavor.dispose();
  });

  it('足あとは増え続けない（跳ね続けても上限で止まる）', () => {
    const { spots } = sceneRig('nohara');
    const flavor = new Flavor(spots.runtimes, { footprints: true }, { seed: 2 });
    for (let i = 0; i < 200; i++) flavor.dropFootprint(i * 0.01, 0);
    expect(flavor.getFootprintCount()).toBeLessThanOrEqual(FOOTPRINT_MAX);
    flavor.dispose();
  });

  it('たまご／つぼみは、隠れ場所そのものと入れ替わる（次の1回で戻る）', () => {
    // ==========================================================================
    // 2026-09-07 に人間が決めた形。
    // 「卵が小さく残っているが何にも意味がない。卵になった場合は
    //   隠れ場所ごと無くして卵を新たな隠れ場所として設定するほうがいい」
    // ==========================================================================
    const { spots, animals, advance } = sceneRig('noujou');
    const spot = spots.runtimes[0];

    // たまごになるまで、出して引っ込めるを繰り返す
    let guard = 0;
    while (spot.shapeKind === spot.config.kind && guard++ < 30) {
      spots.tap(spot);
      advance(PEAK_AT_SEC + OUT_IDLE_SEC + HIDE_DUR_SEC + 0.3);
    }
    expect(spot.shapeKind, 'たまごに入れ替わらなかった').toBe('egg');
    // **当たり判定は動かない**（`worldPosition` 基準）
    expect(spot.worldPosition.toArray()).toEqual(spot.config.position);

    // たまごを押したら、いつもどおり動物が出る（§4-1）
    spots.tap(spot);
    advance(PEAK_AT_SEC + DT);
    expect(spot.state).toBe('out');
    expect(spot.reveal).toBe(1);
    expect(animals.getSlot(spot.config.id)).not.toBeNull();

    // 1回ぶんで終わり。**場面じゅうが たまご だらけにならない**
    advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.3);
    expect(spot.shapeKind).toBe(spot.config.kind);
  });

  it('たまごに入れ替わっても、隠れている体は覗けない（不変条件3）', () => {
    const kind = 'egg' as const;
    // 新しい形は、ふつうの隠れ場所と同じ検査を通ること。
    // **格子は隙間の幅より細かく**（7×9 では 0.05 幅の隙間をすり抜けた）
    const COLS = 15;
    const ROWS = 15;
    const { spots, animals, camera, advance } = sceneRig('noujou');
    advance(0.5);

    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const box = new THREE.Box3();

    for (const spot of spots.runtimes) {
      expect(spots.setShape(spot, kind), spot.config.id).toBe(true);
      animals.reanchor(spot);
      advance(0.3);

      const slot = animals.getSlot(spot.config.id);
      if (!slot) continue;
      spots.group.updateWorldMatrix(true, true);
      box.makeEmpty();
      for (const child of slot.built.group.children) {
        if (child === slot.built.hint) continue;
        box.expandByObject(child);
      }

      let leaks = 0;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          target.set(
            box.min.x + ((box.max.x - box.min.x) * (c + 0.5)) / COLS,
            box.min.y + ((box.max.y - box.min.y) * (r + 0.5)) / ROWS,
            box.max.z
          );
          dir.subVectors(target, camera.position).normalize();
          ray.set(camera.position, dir);
          ray.far = Infinity;
          const hits = ray.intersectObject(spots.group, true);
          if (hits.length === 0) continue;
          if (isDescendantOf(hits[0].object, slot.built.group) && !isDescendantOf(hits[0].object, slot.built.hint)) {
            leaks++;
          }
        }
      }
      expect(leaks, `${kind}/${spot.config.id}: 隠れているのに体が ${leaks}/${COLS * ROWS} 点で見えている`).toBe(0);
    }
  });

  it('たまごに入れ替わっても、出きった体はカメラから見えている', () => {
    const kind = 'egg' as const;
    const COLS = 9;
    const ROWS = 9;
    const NEED = 0.55;
    const { spots, animals, camera, advance } = sceneRig('noujou');
    advance(0.5);

    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const box = new THREE.Box3();

    for (const spot of spots.runtimes) {
      expect(spots.setShape(spot, kind), spot.config.id).toBe(true);
      animals.reanchor(spot);
      const slot = animals.getSlot(spot.config.id);
      if (!slot) continue;

      spots.tap(spot);
      advance(PEAK_AT_SEC + DT);
      let worst = 1;
      for (let step = 0; step < 6; step++) {
        spots.group.updateWorldMatrix(true, true);
        worst = Math.min(worst, visibleRatio(slot, spots, camera, ray, box, target, dir, COLS, ROWS));
        advance(0.18);
      }
      expect(
        worst,
        `${kind}/${spot.config.id}: 出ているあいだ、体が ${(worst * 100).toFixed(0)}% しか見えていない瞬間がある`
      ).toBeGreaterThanOrEqual(NEED);
      advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.3);
    }
  });

  it('影は、隠れているあいだしか出ない（出てきた動物にかぶらない）', () => {
    // ==========================================================================
    // **影だけは隠れ場所の手前に置く。** ふたに映る影なので、奥だと見えない。
    // 手前に置いてよい理由は位置ではなく**時間**で、
    // 「隠れているあいだしか出さない」がその保証そのもの。ここで見張る。
    // ==========================================================================
    const { spots, animals } = sceneRig('ouchi');
    const flavor = new Flavor(spots.runtimes, { shadowPeek: true }, { seed: 6 });

    const shapes = new Map<string, THREE.Object3D>();
    for (const spot of spots.runtimes) {
      const id = animals.getSlot(spot.config.id)?.config.id;
      if (id) shapes.set(id, new THREE.Object3D());
    }
    flavor.setShadowShapes(shapes, (spotId) => animals.getSlot(spotId)?.config.id ?? null);

    let sawShadow = false;
    let badFrames = 0;
    for (let f = 0; f < Math.round(60 * SHADOW_EVERY_SEC * 4); f++) {
      // ときどき押して、出ている最中を必ず通す
      if (f % 240 === 0) spots.tap(spots.runtimes[(f / 240) % spots.runtimes.length]);
      spots.update(DT);
      flavor.update(DT);

      const id = flavor.getShadowSpotId();
      if (!id) continue;
      sawShadow = true;
      const spot = spots.runtimes.find((s) => s.config.id === id);
      // 影が出ているのに、その場所が隠れていない＝動物にかぶっている
      if (!spot || spot.state !== 'hidden') badFrames++;
    }
    expect(sawShadow).toBe(true);
    expect(flavor.getShadowCount()).toBeGreaterThanOrEqual(1);
    expect(badFrames).toBe(0);
    flavor.dispose();
  });

  it('影は、いまその隠れ場所に居る動物の輪郭になる（§6-2 で入れ替わっても）', () => {
    // **丸ふたつで作らないこと。** 「雪だるまみたいで何の意味もない」と
    // 実機で言われた（2026-09-07）。影が中身の輪郭でなければ、
    // 期待も驚きも生まれない
    const { spots, animals } = sceneRig('ouchi');
    const flavor = new Flavor(spots.runtimes, { shadowPeek: true }, { seed: 6 });

    const shapes = new Map<string, THREE.Object3D>();
    const owner = new Map<THREE.Object3D, string>();
    for (const spot of spots.runtimes) {
      const id = animals.getSlot(spot.config.id)?.config.id;
      if (!id) continue;
      const obj = new THREE.Object3D();
      shapes.set(id, obj);
      owner.set(obj, id);
    }
    flavor.setShadowShapes(shapes, (spotId) => animals.getSlot(spotId)?.config.id ?? null);
    // 影の見た目は、動物のぶんだけ手前の入れ物に入る
    expect(flavor.frontGroup.children).toHaveLength(shapes.size);

    let checked = 0;
    for (let f = 0; f < Math.round(60 * SHADOW_EVERY_SEC * 3); f++) {
      spots.update(DT);
      flavor.update(DT);
      const spotId = flavor.getShadowSpotId();
      if (!spotId) continue;
      const shown = flavor.frontGroup.children.filter((c) => c.visible);
      expect(shown).toHaveLength(1);
      // 出ている影は、その隠れ場所に**いま**居る動物のもの
      expect(owner.get(shown[0])).toBe(animals.getSlot(spotId)?.config.id);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    flavor.dispose();
  });

  it('もう1匹は、本人の居場所と行き先には出ない（§4-5 を邪魔しない）', () => {
    // ==========================================================================
    // **`AnimalSystem` のスロットを使わない脇役。**
    // 使うと `ChaseSystem` と同じ隠れ場所を取り合って、
    // 跳ねているうさぎが草むらに吸い込まれる（§4-5 の `driven` と同じ話）。
    // ここでは「本人の居場所と行き先には出ない」「移動中は出ない」を見る。
    // ==========================================================================
    const { spots, chase, advance } = chaseRig(31);
    const flavor = new Flavor(spots.runtimes, { cameo: true }, { seed: 12 });

    const dummy = new THREE.Object3D();
    flavor.setCameo(dummy, 1, () => ({
      busy: chase.isMoving(),
      avoidSpotId: chase.getAnswerSpot().config.id,
    }));

    let sawCameo = false;
    let bad = 0;
    advance(CAMEO_EVERY_SEC * 4, () => {
      flavor.update(DT);
      const id = flavor.getCameoSpotId();
      if (!id) return;
      sawCameo = true;
      // 本人の行き先に出ていたら、取り合いになっている
      if (id === chase.getAnswerSpot().config.id) bad++;
      // 移動中に出たままなら、跳ねているところに割り込んでいる
      if (chase.isMoving()) bad++;
    });

    expect(sawCameo).toBe(true);
    expect(flavor.getCameoCount()).toBeGreaterThanOrEqual(1);
    expect(bad).toBe(0);
    flavor.dispose();
  });

  it('もう1匹が出ている場所を押したら、その子が引っ込む（空振りにしない）', () => {
    // 実機で「うさぎがたまに顔を出すが、そこを押しても隠れている場所は
    // 同じでよくわからない」と言われた（2026-09-07）。
    // 押した先に居るのに §4-6 の空振りが出るのは、因果が合わない
    const { spots, chase, advance } = chaseRig(31);
    const flavor = new Flavor(spots.runtimes, { cameo: true }, { seed: 12 });
    const dummy = new THREE.Object3D();
    flavor.setCameo(dummy, 1, () => ({
      busy: chase.isMoving(),
      avoidSpotId: chase.getAnswerSpot().config.id,
    }));

    let tapped = false;
    advance(CAMEO_EVERY_SEC * 3, () => {
      flavor.update(DT);
      const id = flavor.getCameoSpotId();
      if (!id || tapped) return;
      // 出ている場所を押す → 引っ込む
      expect(flavor.tapCameo(id)).toBe(true);
      tapped = true;
    });
    expect(tapped).toBe(true);
    expect(flavor.getCameoTapCount()).toBe(1);
    // 押していない場所では起きない
    expect(flavor.tapCameo('kusa1')).toBe(false);
    flavor.dispose();
  });

  it('もう1匹は、出しっぱなしにならない（必ず引っ込む）', () => {
    const { spots, chase, advance } = chaseRig(31);
    const flavor = new Flavor(spots.runtimes, { cameo: true }, { seed: 12 });
    const dummy = new THREE.Object3D();
    flavor.setCameo(dummy, 1, () => ({
      busy: chase.isMoving(),
      avoidSpotId: chase.getAnswerSpot().config.id,
    }));

    let longest = 0;
    let run = 0;
    advance(CAMEO_EVERY_SEC * 4, () => {
      flavor.update(DT);
      if (flavor.getCameoSpotId()) run++;
      else {
        longest = Math.max(longest, run);
        run = 0;
      }
    });
    expect(longest).toBeGreaterThan(0);
    // 出ている時間は決められた長さを超えない（1フレームぶんの丸めを許す）
    expect(longest * DT).toBeLessThanOrEqual(CAMEO_TOTAL_SEC + DT);
    flavor.dispose();
  });

  it('味つけを足しても、出きった動物はカメラから見えている（2026-09-06 の再発防止）', () => {
    // 花・卵・あぶく・足あとを、動物の手前に置いてしまうと、
    // 「ねことうしの隠れ場所が開いた時に画像と被って見えなくなっている」が再発する
    for (const id of HIDEOUT_SCENES) {
      const { spots, animals, advance } = sceneRig(id);
      advance(1);
      for (const spot of spots.runtimes) spots.tap(spot);
      advance(PEAK_AT_SEC + 0.3);
      for (const spot of spots.runtimes) {
        const e = animals.getExposure(spot);
        expect(e, `${id}/${spot.config.id}`).not.toBeNull();
      }
    }
  });
});

describe('§6-2 出かたの癖（`AnimalConfig.style`）', () => {
  it('癖は 25体ぶん指定してあり、種類が2つ以上ある', () => {
    // **書いてあるのに誰も読んでいない状態が長く続いた**（2026-09-07 まで）。
    // どの動物も同じ出かたをしていたのが「味つけが弱い」の一因
    const styles = new Set(ANIMALS.map((a) => a.style));
    expect(styles.size).toBeGreaterThanOrEqual(3);
    for (const a of ANIMALS) expect(a.style, a.id).toBeTruthy();
  });

  it.each(HIDEOUT_SCENES)('%s: 癖があっても、隠れているときの位置は同じ', (id) => {
    // **癖は両端で何も足さない。** ここが崩れると、不変条件3 のはみ出し量が
    // 動物ごとに変わって、隠れているのに体が見える回ができる
    const { spots, animals, advance } = sceneRig(id);
    advance(0.5);
    for (const spot of spots.runtimes) {
      const slot = animals.getSlot(spot.config.id);
      if (!slot) continue;
      expect(slot.built.group.position.x, `${id}/${spot.config.id}`).toBeCloseTo(0, 10);
      expect(slot.built.group.rotation.z, `${id}/${spot.config.id}`).toBeCloseTo(0, 10);
      expect(slot.built.group.position.y, `${id}/${spot.config.id}`).toBeCloseTo(slot.hiddenY, 10);
    }
  });

  it.each(HIDEOUT_SCENES)('%s: 癖があっても、出きったときの位置は同じ', (id) => {
    // **1体ずつ**（2026-09-07 の「1体ずつしか出さない」）
    const { spots, animals, advance } = sceneRig(id);
    advance(0.5);
    for (const spot of spots.runtimes) {
      const slot = animals.getSlot(spot.config.id);
      if (!slot) continue;
      // **出きった瞬間**で測る。そのあとは出ているあいだの癖（§6-2）が
      // 乗るので、位置は動いてよい（下の「動きすぎない」で見る）
      spots.tap(spot);
      advance(PEAK_AT_SEC + DT);
      expect(spot.reveal, `${id}/${spot.config.id}`).toBe(1);
      expect(slot.built.group.position.x, `${id}/${spot.config.id}`).toBeCloseTo(0, 10);
      expect(slot.built.group.rotation.z, `${id}/${spot.config.id}`).toBeCloseTo(0, 10);
      expect(slot.built.group.position.y, `${id}/${spot.config.id}`).toBeCloseTo(slot.outY, 10);
      advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.2);
    }
  });

  it('癖が違えば、出ている途中の見え方が実際に違う', () => {
    // 「読んでいない」に戻ったことを捕まえる。**途中が同じなら癖は死んでいる**
    const { spots, animals, advance } = sceneRig('dobutsuen');
    advance(0.5);
    for (const spot of spots.runtimes) spots.tap(spot);
    // 山の手前、いちばん差が出るあたりで見る
    advance(APPEAR_DELAY_SEC + 0.18);

    const shape = spots.runtimes.map((spot) => {
      const slot = animals.getSlot(spot.config.id);
      if (!slot) return null;
      const span = slot.outY - slot.hiddenY;
      return {
        id: slot.config.id,
        style: slot.config.style,
        // 「どれだけ出ているか」を 0..1 に直す。癖が効いていれば値が割れる
        lift: (slot.built.group.position.y - slot.hiddenY) / span,
      };
    });
    const lifts = shape.filter((v) => v !== null).map((v) => v!.lift);
    expect(lifts.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...lifts) - Math.min(...lifts)).toBeGreaterThan(0.05);

    // きりん（peek）は「顔だけ先に、ゆっくり」なので、いちばん出ていない
    const kirin = shape.find((v) => v?.id === 'kirin');
    expect(kirin?.style).toBe('peek');
    expect(kirin!.lift).toBe(Math.min(...lifts));
  });
});

describe('§6-2 同じ隠れ場所から別の動物が出る', () => {
  /** モードAの場面を、入れ替えつき（`SpotShuffle`）で組む */
  function shuffleRig(sceneId: string, chance: number, seed = 4242, useCutouts = false) {
    const scene = findScene(sceneId);
    const spots = new SpotSystem(scene.spots, scene.mode);
    const animals = new AnimalSystem(spots, false, useCutouts ? fakeCutouts(scene) : new Map());
    const shuffle = new SpotShuffle(spots, animals, { seed, chance });
    const camera = new THREE.PerspectiveCamera(66, 0.49, 0.05, 60);
    camera.position.set(0, 0.3, 7.2);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const advance = (seconds: number) => {
      const frames = Math.round(seconds / DT);
      for (let i = 0; i < frames; i++) {
        spots.update(DT);
        animals.update(DT, spots, camera);
      }
    };
    /** いまどの場所に誰が居るか */
    const layout = () =>
      spots.runtimes.map((s) => animals.getSlot(s.config.id)?.config.id ?? null);
    return { spots, animals, shuffle, camera, advance, layout };
  }

  /** 1周: 全部押して、出て、引っ込むまで */
  /**
   * 全部の隠れ場所を1周ぶん出して引っ込める。
   *
   * **1体ずつ押す**（2026-09-07 の「1体ずつしか出さない」）。
   * まとめて押すと2体目から順番待ちになり、入れ替えの抽選が回らない
   */
  function cycle(rig: ReturnType<typeof shuffleRig>): void {
    for (const spot of rig.spots.runtimes) {
      rig.spots.tap(spot);
      rig.advance(3.2);
    }
  }

  it('同じ隠れ場所から、2種類以上の動物が出る', () => {
    const rig = shuffleRig('ouchi', 1.0);
    const seen = rig.spots.runtimes.map(() => new Set<string>());

    for (let i = 0; i < 12; i++) {
      const now = rig.layout();
      now.forEach((id, idx) => {
        if (id) seen[idx].add(id);
      });
      cycle(rig);
    }
    rig.layout().forEach((id, idx) => {
      if (id) seen[idx].add(id);
    });

    for (let i = 0; i < seen.length; i++) {
      expect(
        seen[i].size,
        `${rig.spots.runtimes[i].config.id} から ${[...seen[i]].join('/')} しか出ていない`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('**同時に同じ動物が2箇所に出ることはない**', () => {
    // 入れ替え（交換）なので原理的に起きないが、実装が片側だけ書き換えると起きる。
    // `reassign()` で「片方だけ直すと元の場所から生えてくる」を踏んでいるので見張る
    const rig = shuffleRig('umi', 1.0);
    for (let i = 0; i < 30; i++) {
      const ids = rig.layout().filter((x): x is string => x !== null);
      expect(new Set(ids).size, `${i} 周目に重複: ${ids.join('/')}`).toBe(ids.length);
      cycle(rig);
    }
  });

  it('入れ替えたあとも、隠れていれば縁から見えている（不変条件3）', () => {
    // **絵を貼った動物は隠れ場所ごとに大きさが変わる**ので、
    // 入れ替えたときに anchor() を通し忘れると、前の場所の大きさのまま残る
    for (const useCutouts of [false, true]) {
      const rig = shuffleRig('noujou', 1.0, 99, useCutouts);
      for (let i = 0; i < 8; i++) cycle(rig);
      rig.advance(0.5);
      for (const spot of rig.spots.runtimes) {
        const e = rig.animals.getExposure(spot);
        expect(e, `${spot.config.id} に動物が居ない`).not.toBeNull();
        expect(e!.fraction, `${spot.config.id}（絵=${useCutouts}）`).toBeGreaterThanOrEqual(0.15);
        expect(e!.fraction, `${spot.config.id}（絵=${useCutouts}）`).toBeLessThanOrEqual(0.25);
        const fit = rig.animals.getFit(spot)!;
        expect(fit.mouthWidth, `${spot.config.id} が開口に収まらない`).toBeGreaterThanOrEqual(
          fit.animalWidth * 0.86
        );
      }
    }
  });

  it('4回に1回くらいしか入れ替えない（覚えた場所が毎回崩れない）', () => {
    const rig = shuffleRig('soto', SWAP_CHANCE);
    for (let i = 0; i < 40; i++) cycle(rig);
    const rolled = rig.shuffle.getRolledCount();
    const swapped = rig.animals.getSwapCount();
    expect(rolled).toBeGreaterThan(50);
    const rate = swapped / rolled;
    expect(rate, `実測 ${(rate * 100).toFixed(1)}%`).toBeGreaterThan(0.15);
    expect(rate, `実測 ${(rate * 100).toFixed(1)}%`).toBeLessThan(0.35);
  });

  it('出ている最中には入れ替わらない', () => {
    const rig = shuffleRig('ouchi', 1.0);
    rig.spots.tap(rig.spots.runtimes[0]);
    rig.advance(0.6); // 出きったところ
    const before = rig.layout();
    const swapsBefore = rig.animals.getSwapCount();
    rig.advance(0.8); // まだ出ている
    expect(rig.animals.getSwapCount()).toBe(swapsBefore);
    expect(rig.layout()).toEqual(before);
  });

  it('モードB（のはら）では入れ替えない', () => {
    const scene = findScene('nohara');
    expect(scene.mode).toBe('chase');
    const { animals } = chaseRig();
    // のはら は SceneRoot が SpotShuffle を作らない。走り手が動かしているので、
    // ここが動かすと2つの書き手が取り合う
    expect(animals.getSwapCount()).toBe(0);
  });
});

describe('§4-6 「こっちこっち〜」（2026-09-06 に人間が決めた）', () => {
  it('正解の場所が揺れはじめたのと同じ瞬間に、1回だけ知らせる', () => {
    const { spots, empty, answer, advance } = chaseRig();
    advance(0.5);

    const calls: { spot: string; answer: string | null }[] = [];
    empty.onHint((spot, ans) => calls.push({ spot: spot.config.id, answer: ans?.config.id ?? null }));

    const correct = answer();
    const wrong = spots.runtimes.find((s) => s !== correct)!;

    spots.tap(wrong);
    // 揺れは §4-6 の 0.50s。**その手前では鳴らない**
    advance(0.4);
    expect(calls.length, '0.4秒の時点で鳴っている').toBe(0);

    advance(0.2);
    expect(calls.length, '0.6秒までに1回鳴っていない').toBe(1);
    expect(calls[0].answer).toBe(correct.config.id);

    // ひと通り走りきっても、増えない
    advance(1.0);
    expect(calls.length).toBe(1);
  });

  it('押した場所そのものが正解だったときは鳴らない', () => {
    const { spots, empty, answer, advance } = chaseRig();
    advance(0.5);
    const calls: string[] = [];
    empty.onHint((spot) => calls.push(spot.config.id));

    // 正解の場所は空ではないので、そもそも §4-6 は起きない。
    // **起きても鳴らない**ことまで見る（揺らす相手が自分自身になるため）
    spots.tap(answer());
    advance(1.5);
    expect(calls.length).toBe(0);
  });
});

describe('§6-3 サプライズ「ばあっ！」', () => {
  /** テストから抽選だけを回す。カメラは要らない（`update` を呼ばなければ作らない） */
  function surpriseRig(seed = 20260906, chance = SURPRISE_CHANCE) {
    const s = new Surprise({ seed, chance, reducedMotion: false });
    const tex = new THREE.Texture();
    tex.image = { width: 329, height: 461 };
    s.setTextures(new Map([['neko', tex]]));
    return s;
  }

  it('だいたい3回に1回出る（人間が決めた頻度。§6-3 の 1/10〜1/30 より高い）', () => {
    const s = surpriseRig();
    let fired = 0;
    for (let i = 0; i < 600; i++) {
      // 最短間隔を跨がせる。ここを詰めると「間隔の制限」を測ることになる
      s.update(MIN_GAP_FOR_TEST, camera());
      if (s.maybeTrigger('neko')) fired++;
    }
    const rate = fired / 600;
    // **抽選の当たり（0.5）と、実際に出る割合（1/3）は別物。**
    // 出た次の回を必ず外すので、長い目で見た割合は p / (1 + p) に寄る。
    // ここで見るのは**実際に出る割合**のほう
    expect(rate, `実測 ${(rate * 100).toFixed(1)}%`).toBeGreaterThan(0.28);
    expect(rate, `実測 ${(rate * 100).toFixed(1)}%`).toBeLessThan(0.38);
  });

  it('2回続けては出ない', () => {
    const s = surpriseRig();
    let prev = false;
    for (let i = 0; i < 600; i++) {
      s.update(MIN_GAP_FOR_TEST, camera());
      const now = s.maybeTrigger('neko');
      expect(now && prev, `${i} 回目で2連続`).toBe(false);
      prev = now;
    }
  });

  it('絵が無い動物では出ない（不変条件7）', () => {
    const s = surpriseRig();
    for (let i = 0; i < 100; i++) {
      s.update(MIN_GAP_FOR_TEST, camera());
      expect(s.maybeTrigger('inu')).toBe(false);
    }
    expect(s.getFiredCount()).toBe(0);
  });

  it('出ているあいだに押しても、いつもどおり動物が出る（不変条件2）', () => {
    // サプライズは three の板で、DOM の入力を塞がない。
    // ここでは「隠れ場所の側が何も止められていない」ことを見る
    const { spots, animals, advance } = rig();
    const s = surpriseRig();
    advance(0.5);
    s.update(0.016, camera());
    expect(s.maybeTrigger('neko')).toBe(true);

    // **どの隠れ場所も、押せば必ず応答が返る**（サプライズは入力を塞がない）
    const before = spots.getResponseCount();
    for (const spot of spots.runtimes) spots.tap(spot);
    expect(spots.getResponseCount() - before).toBe(spots.runtimes.length);

    // 出ているあいだも、登場は最後まで走る。
    // **1体ずつ**（2026-09-07 の「1体ずつしか出さない」）
    for (const spot of spots.runtimes) {
      spots.tap(spot);
      advance(0.8);
      expect(animals.getExposure(spot)!.fraction, spot.config.id).toBeGreaterThan(0.5);
      advance(OUT_IDLE_SEC + HIDE_DUR_SEC + 0.2);
    }
  });

  it('走っているあいだ、色を変えない（不変条件6）', () => {
    const s = surpriseRig();
    const cam = camera();
    s.update(0.016, cam);
    expect(s.maybeTrigger('neko')).toBe(true);
    for (let t = 0; t < SURPRISE_TOTAL_SEC; t += DT) {
      s.update(DT, cam);
      const mesh = s.group.children[0] as THREE.Mesh | undefined;
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      expect(mat.color.getHex()).toBe(0xffffff);
    }
  });

  it('4方向すべてから出る（人間が決めた。2026-09-06）', () => {
    const s = surpriseRig();
    const seen = new Map<SurpriseDirection, number>();
    let prev: SurpriseDirection | null = null;
    for (let i = 0; i < 400; i++) {
      s.update(MIN_GAP_FOR_TEST, camera());
      if (!s.maybeTrigger('neko')) continue;
      const d = s.getDirection();
      // **同じ向きを2回続けない。** 続くと4方向にした意味が無くなる
      expect(d === prev, `${i} 回目で ${d} が2連続`).toBe(false);
      prev = d;
      seen.set(d, (seen.get(d) ?? 0) + 1);
    }
    for (const d of ['bottom', 'top', 'left', 'right'] as const) {
      expect(seen.get(d) ?? 0, `${d} が一度も出ていない`).toBeGreaterThan(5);
    }
  });

  it('上から出るときだけ上下を反転する（覗き込んで見せるため）', () => {
    const s = surpriseRig();
    const cam = camera();
    let checked = 0;
    for (let i = 0; i < 400 && checked < 8; i++) {
      s.update(MIN_GAP_FOR_TEST, cam);
      if (!s.maybeTrigger('neko')) continue;
      s.update(DT, cam);
      const mesh = s.group.children[0] as THREE.Mesh;
      const flipped = mesh.scale.y < 0;
      expect(flipped, `${s.getDirection()} の反転が違う`).toBe(s.getDirection() === 'top');
      checked++;
      // 走りきらせてから次へ
      for (let t = 0; t < SURPRISE_TOTAL_SEC + 0.1; t += DT) s.update(DT, cam);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('どの向きでも、出きったときに入ってきた側の縁にそろっている', () => {
    // 画面の外に置いたまま「出た」ことになっていないかを見る。
    //
    // **左右は、向こう側が画面からはみ出してよい**（2026-09-06、人間が決めた）。
    // 「左右の絵が小さい」と言われて 1.5倍にした結果、横に広い動物は
    // 画面幅の 1.9倍まで許している。はみ出しても「大きいものが横から来た」
    // に見えるが、**入ってくる側の縁にそろっていないと**、ただ画面の外に
    // 置きっぱなしなのと区別がつかない。そこを見る
    const s = surpriseRig();
    const cam = camera();
    const viewH = 2 * 3.0 * Math.tan((cam.fov * Math.PI) / 360);
    const viewW = viewH * cam.aspect;
    let checked = 0;
    for (let i = 0; i < 400 && checked < 8; i++) {
      s.update(MIN_GAP_FOR_TEST, cam);
      if (!s.maybeTrigger('neko')) continue;
      // 上がりきるまで進める
      for (let t = 0; t < 0.4; t += DT) s.update(DT, cam);
      const mesh = s.group.children[0] as THREE.Mesh;
      const geo = mesh.geometry as THREE.PlaneGeometry;
      const w = geo.parameters.width;
      const h = geo.parameters.height;
      const overlapX =
        Math.min(mesh.position.x + w / 2, viewW / 2) - Math.max(mesh.position.x - w / 2, -viewW / 2);
      const overlapY =
        Math.min(mesh.position.y + h / 2, viewH / 2) - Math.max(mesh.position.y - h / 2, -viewH / 2);
      const dir = s.getDirection();
      const vertical = dir === 'bottom' || dir === 'top';
      // 入ってくる側の縁に、動物の縁がそろっていること
      const near =
        dir === 'left'
          ? mesh.position.x - w / 2 + viewW / 2
          : dir === 'right'
            ? viewW / 2 - (mesh.position.x + w / 2)
            : dir === 'bottom'
              ? mesh.position.y - h / 2 + viewH / 2
              : viewH / 2 - (mesh.position.y + h / 2);
      expect(Math.abs(near), `${dir}: 入ってきた側の縁にそろっていない`).toBeLessThan(0.02);

      // 画面に入っている割合。**上下は全部、左右は横だけ緩める**
      expect(overlapY / h, `${dir}: 縦が画面に入っていない`).toBeGreaterThan(0.98);
      expect(overlapX / w, `${dir}: 横が画面に入っていない`).toBeGreaterThan(vertical ? 0.98 : 0.5);
      checked++;
      for (let t = 0; t < SURPRISE_TOTAL_SEC + 0.1; t += DT) s.update(DT, cam);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('走りきったら止まり、捨てたら何も残らない', () => {
    const s = surpriseRig();
    const cam = camera();
    s.update(0.016, cam);
    expect(s.maybeTrigger('neko')).toBe(true);
    for (let t = 0; t < SURPRISE_TOTAL_SEC + 0.1; t += DT) s.update(DT, cam);
    expect(s.isRunning()).toBe(false);
    s.dispose();
    expect(s.group.children.length).toBe(0);
  });
});
