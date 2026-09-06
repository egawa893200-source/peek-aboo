# 参照画像の置き場

**ここに置いた画像だけを対象にする。**（`docs/match-gate.md`）
ここに無い動物は、このラウンドでは一切触らない。

## 1. 生成したままの画像を置く場所

ChatGPT が出した**1枚に正面図と側面図が横並びになった画像**を、
そのまま次の名前で置く。

**拡張子に注意。** 受け取った16枚は `.png` という名前だったが、中身は
すべて JPEG（`ff d8 ff`）だった。名前が中身と食い違っていると、後から
「PNG なのでアルファがあるはず」と読んで静かに壊れるので、`.jpg` に直してある。

```
reference/raw/01-ushi.jpg
reference/raw/02-risu.jpg
reference/raw/03-hitsuji.jpg
reference/raw/04-tako.jpg
reference/raw/05-neko.jpg
reference/raw/06-inu.jpg
reference/raw/07-usagi.jpg
reference/raw/08-nezumi.jpg
reference/raw/09-kotori.jpg
reference/raw/10-kaeru.jpg
reference/raw/11-harinezumi.jpg
reference/raw/12-chocho.jpg
reference/raw/13-kumanomi.jpg
reference/raw/14-kani.jpg
reference/raw/15-pengin.jpg
reference/raw/16-buta.jpg
reference/raw/17-niwatori.jpg
```

- 番号は生成プロンプトの番号、名前は `src/data/animals.ts` の `id`
- 長辺 1600px 程度に縮小してよい（比率と色しか測らない）
- **`public/` に置かないこと。** そこに置くと Netlify がそのまま配信する

## 2. ここから先は自動

```bash
npm run ref-split     # 1枚を front.png / side.png に割り、白背景を落とす（実装済み）
npm run ref-measure   # 体型比率を人間がクリックして確定する（未実装）
```

`ref-cut`（白背景を落とす）は `ref-split` に含めた。**アルファがそのまま
マスクになる**ので、別ファイルの `*_mask.png` は作らない
（アプリ側の `npm run shot` も同じ形で撮っている）。

割ったあとの形:

```
reference/animals/<id>/front.png   ← アルファ付き。背景は透明
reference/animals/<id>/side.png    ← 同上。**必ず右を向いている**
reference/animals/contact-front.png  ← 目で確認するための一覧（16体ぶん）
reference/animals/contact-side.png
reference/animals/split-report.json  ← 1体ごとの処理結果
reference/proportions.json     ← M2 の目標値。人間がクリックして作る（未実装）
reference/manifest.json        ← 対象・priority・側面図の向き
```

**切り出しは自動でやらせ、目で確認する。**
`contact-front.png` と `contact-side.png` を開いて、
背景が抜けているか（市松模様が見えるか）、地面の線や文字が残っていないか、
2体が混ざっていないかを見ること。

### 受け取った16枚が、指定と違っていたところ

| | 指定 | 実際 | どうしたか |
|---|---|---|---|
| 形式 | PNG | **JPEG**（名前だけ .png） | `.jpg` に改名。白が 255 にならないので閾値で抜く |
| 側面図の向き | 右向き | **8枚が左向き** | `manifest.json` の `sideFacing` に記録し、左向きを反転して揃えた |
| 輪郭線 | 描かない | **描かれている** | シルエット（M1）には無害。配色（M3）では線の画素を除く必要がある |
| 影・地面 | 描かない | **地面の線が引かれている** | 行の合計と帯の厚みで見つけて、1つ上の行で埋め直す |
| 文字 | （番号のみ指示） | 左上に「No.1 Cow」 | 上の帯にまるごと収まる塊として落とす |

さらに **ねずみは、側面図のしっぽの先が正面図の足に触れていた**。
2体が1つの塊になるので、真ん中で前景がいちばん薄い5列を切って分けている
（`split-report.json` の `tieCut`）。

## 3. アプリ側の撮影

```bash
npm run shot -- --pose reference           # 参照と同じ向き・平行投影で撮る
npm run shot -- --pose reference --verify  # 2回撮ってバイト単位で一致するか見る
```

`--verify` が通らないうちは、**見た目を一切いじらない**（`docs/match-gate.md` §3-1）。
