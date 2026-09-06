/**
 * 絵の大きさ（**自動生成。手で書き換えないこと**）
 *
 * `npm run cutouts` が `public/animals/<id>.webp` を作るときに一緒に書く。
 * 単体テストが、画像を読まずに絵の縦横比を再現するために使う。
 * アプリ本体は使わない（実行時はテクスチャから読む）。
 */
export const CUTOUT_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  buta: [383, 512],
  chocho: [613, 512],
  harinezumi: [421, 456],
  hitsuji: [404, 456],
  inu: [373, 512],
  kaeru: [454, 420],
  kani: [616, 388],
  kirin: [137, 512],
  kotori: [291, 512],
  kumanomi: [272, 463],
  neko: [329, 461],
  nezumi: [380, 512],
  niwatori: [272, 512],
  pengin: [353, 512],
  putera: [451, 512],
  raion: [295, 512],
  risu: [258, 512],
  saru: [342, 512],
  sutego: [261, 386],
  tako: [467, 466],
  tirano: [326, 512],
  torikera: [325, 442],
  usagi: [200, 512],
  ushi: [341, 512],
  zou: [452, 512],
};
