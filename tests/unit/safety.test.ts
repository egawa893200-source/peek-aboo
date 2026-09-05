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

import { SCENES } from '../../src/data/scenes';
import {
  AnimalSystem,
  EXPECTED_HINT_EXPOSURE,
  FLASH_MIN_INTERVAL_SEC,
} from '../../src/peekaboo/AnimalSystem';
import {
  APPEAR_DELAY_SEC,
  HIDE_DUR_SEC,
  OUT_IDLE_SEC,
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
  // §4-6。モードB（Phase 3）が入ってから
  it.todo('空の隠れ場所を押しても反応が返る（不変条件3b）');
  it.todo('空の隠れ場所を押したあと、正解の隠れ場所が揺れる');

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

  // §4-5 の移動モードは Phase 3
  it.todo('移動中に押しても反応が返り、かつ移動が完了する（不変条件4b）');
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

  it('ヒントの出す量は、体の高さを実測して決めている', () => {
    // 定数を信じない。耳や尻尾を足すと体の高さは変わるので、
    // 決め打ちにすると隠れ方が動物ごとにずれる
    const { spots, animals } = rig();
    for (const spot of spots.runtimes) {
      const e = animals.getExposure(spot)!;
      expect(e.animalHeight).toBeGreaterThan(0);
      expect(e.fraction).toBeCloseTo(EXPECTED_HINT_EXPOSURE, 1);
    }
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
  // Phase 3（ChaseSystem）が入ってから
  it.todo('直前と同じ隠れ場所には戻らない（20周まわして 0 回）');
  it.todo('ばあ→移動→隠れ終わりが 6秒以内に完了する');
});
