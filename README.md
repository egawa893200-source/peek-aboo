# ばあ！

1歳半の子どものための、いないいないばあアプリ。
隠れ場所を押すと動物が出て「ばあ！」と言い、少ししたらまた隠れる。

- 設計書: [`peekaboo-app-design.md`](./peekaboo-app-design.md)
- 実装のルール: [`CLAUDE.md`](./CLAUDE.md)

## いまの状態

**Phase 1 の「移植」まで。** 押すと波紋が出て「ばあ！」と声が返るところまで動く。
隠れ場所と動物はまだ無い（設計書 §12 Phase 1 の残りから）。

## 動かす

```bash
npm install
npm run dev     # http://localhost:5173
```

素材は1つも要らない。`public/` が空のままで動く（不変条件7）。

```bash
npm run typecheck   # 型チェック（src と tests の両方）
npm run test        # 単体テスト
npm run test:e2e    # ブラウザでの実動作
npm run verify      # 上記まとめて
```

初回は Playwright のブラウザが要る。

```bash
npx playwright install chromium
```

## 「みずのなか」から持ってきたもの

水族館アプリ「みずのなか」で作って**実機で検証済み**のコード。
ファイル冒頭に出どころと、外した部分を書いてある。

| ファイル | 元 | 変更 |
|---|---|---|
| `src/core/Loop.ts` | 同名 116行 | コメントのみ |
| `src/core/Input.ts` | 同名 141行 | コメントのみ |
| `src/core/ScreenProjector.ts` | 同名 50行 | コメントのみ |
| `src/core/WakeLock.ts` | 同名 193行 | そのまま |
| `src/core/QualityManager.ts` | 同名 185行 | コメントのみ |
| `src/core/AssetLoader.ts` | 同名 647行 | 水中用のテクスチャ生成と動画読込を外した |
| `src/core/AudioBus.ts` | 同名 816行 | 水槽用の声を外し、`baa` の1本だけ残した |
| `src/ui/ParentalGate.ts` | 同名 164行 | そのまま |
| `src/ui/Ripple.ts` | `feeding/Ripple.ts` 99行 | 置き場所のみ |
| `src/ui/styles.css` | 同名 638行 | 水槽用の UI を外した |
| `src/pwa/sw-register.ts` | 同名 26行 | そのまま |
| `src/audio/baaClip.ts` | 同名 | そのまま（「ばあ」の声。このアプリの主役） |
| `scripts/make-voice.cjs` | 同名 | そのまま |

`src/core/Renderer.ts` はコピーではない。あちらの 258行は大半が水中用の
ポスト処理の組み立てなので、**同じ判断（トーンマッピング・DPRクランプ・
info.autoReset）だけを引き継いだ短い版**を新しく書いてある。
`postprocessing` への依存も外した。

## 公開する（Netlify）

1. https://app.netlify.com で **Add new site → Import an existing project → GitHub**
2. このリポジトリを選ぶ（private でも一覧に出る。出ないときは
   *Configure the Netlify app on GitHub* からアクセスを許可する）
3. ビルド設定は `netlify.toml` から自動で読まれる（手入力は不要）
4. **Deploy site**
5. **Site configuration → General → Site details → Change site name** で
   URL に使う名前を決める。**個人が特定できる名前は避けること**

以降は `main` に push するたびに自動で公開される。

### 「Powered by Netlify」のバッジ

無料プランでは、Netlify が配信するページの右下にバッジを自動で挿入する
（こちらの HTML には無い）。`position: fixed` で z-index も高く、
こちらの CSS では動かせない。

**画面下部に UI を置くときは `src/ui/styles.css` の `--badge-reserve`
（48px）のぶん上に逃がすこと。** みずのなかでは、これを知らずに置いた
切替ボタンのいちばん右がバッジに塞がれて押せなくなった。

**未解決: バッジはリンクなので、押すと外部サイトに飛ぶ。**
1歳半が右下を触って外に出る可能性がある。消すには次のどちらかが要る。

| 方法 | 費用 | バッジ | private リポジトリ |
|---|---|---|---|
| Netlify 無料 | 無料 | **出る** | 可 |
| Netlify 有料 | 月額 | 出ない | 可 |
| **Cloudflare Pages 無料** | 無料 | **出ない** | 可 |

移す場合は `--badge-reserve` を `0px` にすればよい。他の変更は要らない。

## 素材の出典

まだ何も入っていない。追加したらここに記録すること
（ライセンスと、改変・表記の要否）。
