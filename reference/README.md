# 参照画像の置き場

**ここに置いた画像だけを対象にする。**（`docs/match-gate.md`）
ここに無い動物は、このラウンドでは一切触らない。

## 1. 生成したままの画像を置く場所

ChatGPT が出した**1枚に正面図と側面図が横並びになった画像**を、
そのまま次の名前で置く。

```
reference/raw/01-ushi.png
reference/raw/02-risu.png
reference/raw/03-hitsuji.png
reference/raw/04-tako.png
reference/raw/05-neko.png
reference/raw/06-inu.png
reference/raw/07-usagi.png
reference/raw/08-nezumi.png
reference/raw/09-kotori.png
reference/raw/10-kaeru.png
reference/raw/11-harinezumi.png
reference/raw/12-chocho.png
reference/raw/13-kumanomi.png
reference/raw/14-kani.png
reference/raw/15-pengin.png
reference/raw/16-buta.png
reference/raw/17-niwatori.png
```

- 番号は生成プロンプトの番号、名前は `src/data/animals.ts` の `id`
- 長辺 1600px 程度に縮小してよい（比率と色しか測らない）
- **`public/` に置かないこと。** そこに置くと Netlify がそのまま配信する

## 2. ここから先は自動

```bash
npm run ref-split     # 1枚を side.png / front.png に割る（未実装。画像が入ってから作る）
npm run ref-cut       # 白背景を落としてマスクを作る（同上）
npm run ref-measure   # 体型比率を人間がクリックして確定する（同上）
```

割ったあとの形:

```
reference/animals/<id>/side.png
reference/animals/<id>/front.png
reference/animals/<id>/side_mask.png
reference/proportions.json     ← M2 の目標値。人間がクリックして作る
reference/manifest.json        ← 対象と priority
```

## 3. アプリ側の撮影

```bash
npm run shot -- --pose reference           # 参照と同じ向き・平行投影で撮る
npm run shot -- --pose reference --verify  # 2回撮ってバイト単位で一致するか見る
```

`--verify` が通らないうちは、**見た目を一切いじらない**（`docs/match-gate.md` §3-1）。
