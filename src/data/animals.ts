/**
 * 動物の定義（設計書 §5-1 / §5-2）
 *
 * **データだけを置く。ロジックを書かない。**
 * 手続き生成の見た目は `peekaboo/ProceduralAnimals.ts` が組み立てる。
 *
 * 今回は「おうち」の常駐4体だけ（§5-3）。予備とサプライズ用の大物は
 * Phase 5 以降で足す。
 *
 * **`bodyHeight` / `bodyWidth` を必ず指定すること。**
 * みずのなかで体型を指定しなかったせいで、チョウチョウウオもメダカも
 * 同じ魚になった。見分けがつくかは色ではなく輪郭で決まる（§5-2）。
 *
 * `hintPart` は「隠れているときに縁から出ている部分」（§4-2）。
 * 4体で全部違う形にしてあるのは、**どの場所に誰が居るかを形で覚えられる**ようにするため。
 * 顔は出さない。顔が見えていたら「ばあ！」が驚きにならない。
 */

import type { AnimalConfig, AnimalId } from '../types';

export const ANIMALS: readonly AnimalConfig[] = [
  {
    id: 'neko',
    // 素材はまだ1つも無い。null なら手続き生成に落ちる（不変条件7）
    modelUrl: null,
    scale: 1.0,
    // 彩度を落としすぎない。加算の光は載せていないので、この色がほぼそのまま出る
    // （みずのなかでは加算のリムライト最大 +1.7 が体色を白く消していた）
    color: '#e59a3c',
    bellyColor: '#fdf0dc',
    voice: 'baa',
    style: 'pop',
    hintPart: 'tail',
    bodyHeight: 0.92,
    bodyWidth: 0.66,
  },
  {
    id: 'inu',
    modelUrl: null,
    scale: 1.0,
    color: '#8a5a33',
    bellyColor: '#f2ddc2',
    voice: 'baa',
    style: 'slide',
    hintPart: 'ear',
    // ねこより一回り大きく、横に広い。並べたときに背の順で見分けられる
    bodyHeight: 1.0,
    bodyWidth: 0.8,
  },
  {
    id: 'nezumi',
    modelUrl: null,
    scale: 1.0,
    color: '#9aa6b4',
    bellyColor: '#e9eef5',
    voice: 'baa',
    style: 'peek',
    hintPart: 'nose',
    // いちばん小さい。耳を大きくして、小ささを輪郭で見せる
    bodyHeight: 0.66,
    bodyWidth: 0.52,
  },
  {
    id: 'kotori',
    modelUrl: null,
    scale: 1.0,
    color: '#57bfe3',
    bellyColor: '#fff6d2',
    voice: 'baa',
    style: 'flip',
    hintPart: 'foot',
    // 縦横がほぼ同じ＝まん丸。耳が無いので、遠目でも他の3体と混ざらない
    bodyHeight: 0.62,
    bodyWidth: 0.6,
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
