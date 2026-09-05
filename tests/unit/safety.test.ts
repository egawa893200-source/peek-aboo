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

import { findScene, SCENES } from '../../src/data/scenes';
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
  CHASE_OUT_IDLE_SEC,
  PEAK_AT_SEC,
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
  const spots = new SpotSystem(OUCHI.spots);
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

interface ChaseRig extends Rig {
  chase: ChaseSystem;
  empty: EmptySpot;
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
  const spots = new SpotSystem(NOHARA.spots, NOHARA.mode);
  const animals = new AnimalSystem(spots, false);
  const start = spots.runtimes[0];
  animals.spawn(start, NOHARA.runner!);
  const chase = new ChaseSystem(spots, animals, { seed, startSpotId: start.config.id });
  const empty = new EmptySpot(spots);
  spots.onEmpty((spot) => empty.trigger(spot, chase.getAnswerSpot()));

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
    answer: () => chase.getAnswerSpot(),
    advance(seconds, onFrame) {
      const frames = Math.round(seconds / DT);
      for (let i = 0; i < frames; i++) {
        onFrame?.(i);
        // **SceneRoot と同じ順番。** ここを変えると移動の開始が1フレームずれる
        spots.update(DT);
        chase.update(DT);
        empty.update(DT);
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

describe('不変条件1 — 無反応を作らない', () => {
  // 波紋は DOM が要るので Playwright 側で見る（tests/e2e「画面のどこをタップしても波紋が出る」）。
  it.todo('隠れ場所から外れた場所を押しても、波紋が必ず出る');
  it('空の隠れ場所を押しても反応が返る（不変条件3b）', () => {
    const { spots, chase, empty, advance } = chaseRig();
    // うさぎが居ない3箇所。**のはらでは4回に3回がここ**（§4-6）
    const emptySpots = spots.runtimes.filter((s) => s !== chase.getAnswerSpot());
    expect(emptySpots).toHaveLength(3);

    for (const spot of emptySpots) {
      expect(spot.occupied, spot.config.id).toBe(false);
      // 空でも当たり判定は持っている（外すと不変条件3b を破る）
      expect(spot.config.hitRadiusPx).toBeGreaterThan(0);
      // **必ず true。** ここが false になると、のはらでいちばん多い操作が無反応になる
      expect(spots.tap(spot), spot.config.id).toBe(true);
      // 押した実感（§4-3 の 0.00s）
      expect(spot.shake, spot.config.id).toBeGreaterThan(0);
    }
    expect(empty.getStartedCount()).toBe(3);
    expect(empty.getTapCount()).toBe(3);
    // 応答を返したタップ数が、押した数と一致する
    expect(spots.getResponseCount()).toBe(3);

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
    // 揺れる前に、押した側の「ぷるっ」を減衰させきる
    advance(EMPTY_HINT_AT_SEC - 0.05);
    const before = answer.shake;

    advance(0.1);
    // **必ず正解を教える**（§4-6「1歳半に探させるのは早い」）
    expect(answer.shake).toBeGreaterThan(before);
    expect(answer.shake).toBeGreaterThan(0.5);
    // 明滅ではなく揺れ（不変条件6）。開いてはいない
    expect(answer.extraOpen).toBe(0);
    expect(answer.reveal).toBe(0);
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
        if (!slot) continue; // のはらの空の3箇所（不変条件3 の例外）
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
        if (!e) continue; // のはらの空の3箇所（不変条件3 の例外）
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
    const seen = new Set<number>();
    for (const rigging of [rig(), chaseRig()]) {
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

    // 順番を固定にしない（§4-5）。20周まわせば4箇所すべてを踏む
    expect(new Set(history).size).toBe(4);
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

  it('移動が終わると、うさぎは移動先に隠れてヒントが見えている', () => {
    // 不変条件3。**モードBの例外は「空になった場所」だけ**で、
    // うさぎが入っている場所は、体の一部が見えていること
    const { spots, chase, animals, advance } = chaseRig();
    spots.tap(chase.getAnswerSpot());
    advance(PEAK_AT_SEC + CHASE_OUT_IDLE_SEC + CHASE_MOVE_SEC + 0.3);

    const home = chase.getAnswerSpot();
    expect(chase.getPhase()).toBe('idle');
    expect(home.state).toBe('hidden');

    const e = animals.getExposure(home);
    expect(e).not.toBeNull();
    expect(e!.fraction).toBeGreaterThanOrEqual(0.15);
    expect(e!.fraction).toBeLessThanOrEqual(0.25);
    expect(e!.bodyFraction).toBeLessThan(0.01);
    // ヒントが出ている＝跳んでいる最中の「driven」が解けている
    expect(animals.getSlot(home.config.id)!.driven).toBe(false);
    expect(animals.getSlot(home.config.id)!.built.hint.visible).toBe(true);
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
