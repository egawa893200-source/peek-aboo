/**
 * 動物の定義（設計書 §5-1 / §5-2）
 *
 * **データだけを置く。ロジックを書かない。**
 * 手続き生成の見た目は `peekaboo/ProceduralAnimals.ts` が組み立てる。
 *
 * ==========================================================================
 * **輪郭で見分けがつくこと**が、色より優先（§5-2）。
 * みずのなかで体型を指定しなかったせいで、チョウチョウウオもメダカも
 * 同じ魚になった。ここでは1体ごとに
 *
 *   bodyPlan … 体の作り        headTop … 頭の上（耳・角・とさか・触角）
 *   snout    … 顔の前          tail    … 後ろ
 *   coat     … 表面（とげ・もこもこ・ぶち・しま）
 *   bodyHeight / bodyWidth … 縦横比
 *
 * を指定してある。**この表を読めば、どんな輪郭になるか分かる**のが狙い。
 *
 * **同じ動物を2つの場面に出さないこと。**
 * 場面が違っても、同じ動物が出てくると「新しい場所」に見えない。
 * `tests/unit/safety.test.ts` の「同じ動物が2つの場面に出ていない」が見張っている。
 * **輪郭が似ているだけでも同じに見える。** はりねずみは、ねずみと同じ
 * 「丸い耳＋とがった鼻」にしていたら、別の場面なのに同じ動物に見えた。
 *
 * `hintPart` は「隠れているときに縁から出ている部分」（§4-2）。
 * **同じ場面の4体は、必ず違う形にすること。**
 * どの場所に誰が居るかを形で覚えられるようにするため。
 * 顔は出さない。顔が見えていたら「ばあ！」が驚きにならない。
 *
 * **体の高さには上限がある。** 隠れているとき、体は隠れ場所の
 * `coverTopY` と `coverBottomY` のあいだに収まらないと、上か下からはみ出す。
 * はこ・カーテン・ふとん・とびら は 1.05 しか無いので、体高は 0.99 まで。
 * くさむら・いわ・きのほら・うえきばち・すいめん は下を深く取ってあるので
 * 1.4 くらいまで入る（うさぎがそこに住んでいる）。
 * 破ると `tests/unit/safety.test.ts` の「下から体がはみ出していない」が落ちる。
 * ==========================================================================
 */

import type { AnimalConfig, AnimalId } from '../types';

export const ANIMALS: readonly AnimalConfig[] = [
  /* --- おうち（モードA） -------------------------------------------------- */
  {
    id: 'neko',
    // 素材はまだ1つも無い。null なら手続き生成に落ちる（不変条件7）
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/neko.webp',
    scale: 1.0,
    // 彩度を落としすぎない。加算の光は載せていないので、この色がほぼそのまま出る
    // （みずのなかでは加算のリムライト最大 +1.7 が体色を白く消していた）
    color: '#e59a3c',
    bellyColor: '#fdf0dc',
    voice: 'baa',
    style: 'pop',
    hintPart: 'tail',
    bodyPlan: 'mammal',
    headTop: 'triangleEars',
    snout: 'none',
    tail: 'thin',
    bodyHeight: 0.92,
    bodyWidth: 0.60,
  },
  {
    id: 'inu',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/inu.webp',
    scale: 1.0,
    color: '#8a5a33',
    bellyColor: '#f2ddc2',
    voice: 'baa',
    style: 'slide',
    hintPart: 'ear',
    bodyPlan: 'mammal',
    // 垂れ耳＋突き出た鼻づら。ねこと混ざらないのはこの2つのおかげ
    headTop: 'floppyEars',
    snout: 'muzzle',
    tail: 'thin',
    bodyHeight: 0.96,
    bodyWidth: 0.60,
  },
  {
    id: 'nezumi',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/nezumi.webp',
    scale: 1.0,
    color: '#9aa6b4',
    bellyColor: '#e9eef5',
    voice: 'baa',
    style: 'peek',
    hintPart: 'nose',
    bodyPlan: 'mammal',
    // **体に対して大きすぎる丸い耳。** 控えめにすると、ねこと混ざる
    headTop: 'roundEars',
    snout: 'point',
    tail: 'thin',
    bodyHeight: 0.66,
    bodyWidth: 0.52,
  },
  {
    id: 'kotori',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/kotori.webp',
    scale: 1.0,
    color: '#57bfe3',
    bellyColor: '#fff6d2',
    voice: 'baa',
    style: 'flip',
    hintPart: 'foot',
    bodyPlan: 'bird',
    // 耳が無いことが特徴。遠目でも他の3体と混ざらない
    headTop: 'none',
    snout: 'beak',
    tail: 'feather',
    bodyHeight: 0.92,
    bodyWidth: 0.42,
  },

  /* --- のはら（モードB / §4-5） ------------------------------------------- */
  {
    id: 'usagi',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/usagi.webp',
    scale: 1.0,
    color: '#f0ece4',
    bellyColor: '#ffffff',
    voice: 'baa',
    style: 'pop',
    // モードBはヒントを出さない（§4-5「ヒント＝移動そのもの」）。
    // ここは形の指定として残してあるだけで、画面には出ない
    hintPart: 'ear',
    bodyPlan: 'mammal',
    // **いちばん背が高い。** 立った長い耳がそのままシルエットになるので、
    // 跳ねているあいだ、遠目でも「うさぎが動いている」と分かる
    headTop: 'longEars',
    snout: 'none',
    tail: 'puff',
    bodyHeight: 1.02,
    bodyWidth: 0.50,
  },

  /* --- そと（モードA） ---------------------------------------------------- */
  {
    id: 'kaeru',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/kaeru.webp',
    scale: 1.0,
    color: '#5fb356',
    bellyColor: '#e6f3c9',
    voice: 'baa',
    style: 'pop',
    hintPart: 'foot',
    // **目が頭の上に飛び出す**のがかえる。耳も鼻も尾も無い
    bodyPlan: 'frog',
    headTop: 'none',
    snout: 'none',
    tail: 'none',
    bodyHeight: 0.72,
    bodyWidth: 0.78,
  },
  {
    id: 'risu',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/risu.webp',
    scale: 1.0,
    color: '#c07a3e',
    bellyColor: '#f6e3c6',
    voice: 'baa',
    style: 'peek',
    hintPart: 'tail',
    bodyPlan: 'mammal',
    // **背中より高く立つふさふさの尾**が決め手。房のある耳も足す
    headTop: 'tuftEars',
    snout: 'point',
    tail: 'bushy',
    bodyHeight: 0.7,
    bodyWidth: 0.5,
  },
  {
    id: 'harinezumi',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/harinezumi.webp',
    scale: 1.0,
    color: '#8b7a63',
    bellyColor: '#efdcc2',
    voice: 'baa',
    style: 'slide',
    hintPart: 'nose',
    bodyPlan: 'mammal',
    // **耳を出さない。** ねずみと同じ「丸い耳＋とがった鼻」にしていたら、
    // 場面は違うのに同じ動物が出ているように見えた。
    // はりねずみの耳は毛に埋もれて見えないので、無いほうが正しくもある。
    // 見分けは「耳の有無」と「背中のとげ」の2つでつける
    headTop: 'none',
    snout: 'point',
    tail: 'none',
    coat: 'spiky',
    bodyHeight: 0.62,
    bodyWidth: 0.72,
  },
  {
    id: 'chocho',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/chocho.webp',
    scale: 1.0,
    color: '#f0c033',
    bellyColor: '#e87ba8',
    voice: 'baa',
    style: 'flip',
    hintPart: 'fin',
    // 羽が主役。胴は細くして目立たせない
    bodyPlan: 'insect',
    headTop: 'antennae',
    snout: 'none',
    tail: 'none',
    bodyHeight: 0.66,
    // 羽を広げると体幅の 1.64倍まで広がる。うえきばちの開口 1.15 に
    // 収めるため 0.66 まで絞ってある（§4-2 の 0.86倍の条件）
    bodyWidth: 0.38,
  },

  /* --- うみ（モードA） ---------------------------------------------------- */
  {
    id: 'kumanomi',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/kumanomi.webp',
    scale: 1.0,
    color: '#f0782a',
    bellyColor: '#fdf6ee',
    voice: 'baa',
    style: 'slide',
    hintPart: 'fin',
    // **横向きに作る。** 正面から見た魚は魚に見えない
    bodyPlan: 'fish',
    headTop: 'none',
    snout: 'none',
    tail: 'none',
    // 白い帯。無いと「オレンジの魚」で終わってしまう
    coat: 'banded',
    bodyHeight: 0.66,
    bodyWidth: 0.62,
  },
  {
    id: 'tako',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/tako.webp',
    scale: 1.0,
    color: '#d2597e',
    bellyColor: '#ffd9e2',
    voice: 'baa',
    style: 'pop',
    hintPart: 'tail',
    bodyPlan: 'octopus',
    headTop: 'none',
    snout: 'none',
    tail: 'none',
    bodyHeight: 0.86,
    bodyWidth: 0.70,
  },
  {
    id: 'kani',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/kani.webp',
    scale: 1.0,
    color: '#d9503c',
    bellyColor: '#ffd3b0',
    voice: 'baa',
    style: 'slide',
    hintPart: 'foot',
    // 平たく広い体＋はさみ＋目の柄。魚ともたことも混ざらない
    bodyPlan: 'crab',
    headTop: 'none',
    snout: 'none',
    tail: 'none',
    bodyHeight: 0.80,
    // はさみと脚で体幅の 1.8倍まで広がる。いわの開口 1.21 に収めるため絞る
    bodyWidth: 0.68,
  },
  {
    id: 'pengin',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/pengin.webp',
    scale: 1.0,
    color: '#2f3a4c',
    bellyColor: '#f7f9fb',
    voice: 'baa',
    style: 'peek',
    hintPart: 'nose',
    bodyPlan: 'bird',
    headTop: 'none',
    snout: 'beak',
    tail: 'none',
    // ことりと同じ「とり」だが、**縦に細長い**ので並べても混ざらない
    bodyHeight: 0.94,
    bodyWidth: 0.56,
  },

  /* --- のうじょう（モードA） ---------------------------------------------- */
  {
    id: 'ushi',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/ushi.webp',
    scale: 1.0,
    color: '#f2efe8',
    bellyColor: '#ffffff',
    voice: 'baa',
    style: 'slide',
    hintPart: 'tail',
    bodyPlan: 'mammal',
    // 角＋大きな鼻づら＋ぶち。3つ揃ってはじめて「うし」に見える
    headTop: 'horns',
    snout: 'muzzle',
    tail: 'thin',
    coat: 'spotted',
    bodyHeight: 0.94,
    bodyWidth: 0.58,
  },
  {
    id: 'buta',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/buta.webp',
    scale: 1.0,
    color: '#eda3ac',
    bellyColor: '#fbd6db',
    voice: 'baa',
    style: 'pop',
    hintPart: 'nose',
    bodyPlan: 'mammal',
    // **平たい鼻。** これだけでぶたに見える
    headTop: 'triangleEars',
    snout: 'flat',
    tail: 'curl',
    bodyHeight: 0.8,
    bodyWidth: 0.56,
  },
  {
    id: 'hitsuji',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/hitsuji.webp',
    scale: 1.0,
    color: '#efe7d8',
    bellyColor: '#fffdf7',
    voice: 'baa',
    style: 'peek',
    hintPart: 'ear',
    bodyPlan: 'mammal',
    headTop: 'floppyEars',
    snout: 'wide',
    tail: 'puff',
    // もこもこ。うしと同じ白系なので、**輪郭で分ける**
    coat: 'fluffy',
    bodyHeight: 0.86,
    bodyWidth: 0.8,
  },
  {
    id: 'niwatori',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/niwatori.webp',
    scale: 1.0,
    color: '#fbfbf7',
    bellyColor: '#f0e4c8',
    voice: 'baa',
    style: 'flip',
    hintPart: 'foot',
    bodyPlan: 'bird',
    // 赤いとさか。ことり・ぺんぎんと同じ「とり」を分ける決め手
    headTop: 'comb',
    snout: 'beak',
    tail: 'feather',
    bodyHeight: 0.92,
    bodyWidth: 0.42,
  },
  /* --- どうぶつえん（モードA） -------------------------------------------- */
  {
    id: 'raion',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/raion.webp',
    scale: 1.0,
    color: '#d9a25c',
    bellyColor: '#f5e0bd',
    voice: 'baa',
    style: 'pop',
    hintPart: 'tail',
    bodyPlan: 'mammal',
    headTop: 'roundEars',
    snout: 'muzzle',
    tail: 'thin',
    // **たてがみが顔をぐるりと囲む。** これが無いと大きいねこにしか見えない
    coat: 'mane',
    bodyHeight: 0.9,
    bodyWidth: 0.62,
  },
  {
    id: 'zou',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/zou.webp',
    scale: 1.0,
    color: '#a8adb5',
    bellyColor: '#d8dce1',
    voice: 'baa',
    style: 'slide',
    hintPart: 'nose',
    bodyPlan: 'mammal',
    // 大きな耳＋垂れた鼻。どちらか片方だけだと、ぞうに見えない
    headTop: 'bigEars',
    snout: 'trunk',
    tail: 'thin',
    bodyHeight: 1.00,
    bodyWidth: 0.62,
  },
  {
    id: 'kirin',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/kirin.webp',
    scale: 1.0,
    color: '#e0a943',
    bellyColor: '#f6e2b4',
    voice: 'baa',
    style: 'peek',
    hintPart: 'ear',
    // **首の長さが輪郭のすべて。** けものの作りでは胴が大きすぎる
    bodyPlan: 'longneck',
    headTop: 'horns',
    snout: 'muzzle',
    tail: 'thin',
    coat: 'spotted',
    bodyHeight: 1.25,
    bodyWidth: 0.32,
  },
  {
    id: 'saru',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/saru.webp',
    scale: 1.0,
    color: '#9c6544',
    bellyColor: '#f0d9bf',
    voice: 'baa',
    style: 'flip',
    hintPart: 'foot',
    bodyPlan: 'mammal',
    headTop: 'roundEars',
    snout: 'flat',
    // 体より長い尾。ねずみの thin と違って上へ巻き上がる
    tail: 'long',
    bodyHeight: 0.86,
    bodyWidth: 0.54,
  },

  /* --- きょうりゅう（モードA） -------------------------------------------- */
  {
    id: 'tirano',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/tirano.webp',
    scale: 1.0,
    color: '#7e8f5a',
    bellyColor: '#c3cf94',
    voice: 'baa',
    style: 'pop',
    hintPart: 'tail',
    // 二足。太い尾で釣り合う。**口は開けない**（§5-2）
    bodyPlan: 'dino',
    headTop: 'none',
    snout: 'muzzle',
    tail: 'none',
    bodyHeight: 1.00,
    bodyWidth: 0.52,
  },
  {
    id: 'torikera',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/torikera.webp',
    scale: 1.0,
    color: '#8c9a5e',
    bellyColor: '#d5dba6',
    voice: 'baa',
    style: 'slide',
    hintPart: 'nose',
    bodyPlan: 'mammal',
    // えりまきと3本の角。ティラノと同じ緑なので、**輪郭で分ける**
    headTop: 'frill',
    snout: 'wide',
    tail: 'thin',
    bodyHeight: 0.8,
    bodyWidth: 0.7,
  },
  {
    id: 'sutego',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/sutego.webp',
    scale: 1.0,
    color: '#6f8f52',
    bellyColor: '#cbdca0',
    voice: 'baa',
    style: 'peek',
    hintPart: 'fin',
    bodyPlan: 'mammal',
    headTop: 'none',
    snout: 'point',
    tail: 'thin',
    // 背板。左右に振ってあるので正面からも見える
    coat: 'plates',
    bodyHeight: 0.76,
    bodyWidth: 0.48,
  },
  {
    id: 'putera',
    modelUrl: null,
    // 道A: 参照画像そのものを貼る（2026-09-06）。無ければ手続き生成に落ちる
    cutoutUrl: '/animals/putera.webp',
    scale: 1.0,
    color: '#6c8494',
    bellyColor: '#cfdde5',
    voice: 'baa',
    style: 'flip',
    hintPart: 'foot',
    bodyPlan: 'bird',
    // 後ろへ伸びるとさか。にわとりの comb は上に立つので混ざらない
    headTop: 'crest',
    snout: 'beak',
    tail: 'none',
    // 翼が輪郭の主役
    coat: 'wings',
    bodyHeight: 0.86,
    bodyWidth: 0.62,
  },
];

const BY_ID = new Map<AnimalId, AnimalConfig>(ANIMALS.map((a) => [a.id, a]));

/**
 * id から引く。
 *
 * **見つからなくても例外を投げない**（不変条件7 / §2 エラー画面を出さない）。
 * 場面の定義に打ち間違いがあっても、動物が1体居ないだけでアプリは動き続ける。
 * 開発中だけコンソールに残す。
 */
export function findAnimal(id: AnimalId): AnimalConfig | null {
  const found = BY_ID.get(id);
  if (!found) {
    if (import.meta.env.DEV) console.warn(`知らない動物です: ${id}`);
    return null;
  }
  return found;
}
