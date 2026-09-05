/**
 * エントリポイント
 *
 * DOM 要素を集めて App に渡すだけ。ここにロジックを置かない。
 */

import './ui/styles.css';

import { App, type AppElements } from './app/App';
import { registerServiceWorker } from './pwa/sw-register';

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`必要な要素が見つかりません: #${id}`);
  return el;
}

const elements: AppElements = {
  backgroundLayer: requireEl('background-layer'),
  webglLayer: requireEl('webgl-layer'),
  overlayLayer: requireEl('overlay-layer'),
  ripples: requireEl('ripples'),
  uiRoot: requireEl('ui-root'),
  loadingRoot: requireEl('loading-root'),
};

const app = new App(elements);

// E2E テストと実機確認のため、デバッグ API は本番ビルドでも公開する
const debugApi = app.createDebugApi();
(window as unknown as { __peekaboo: ReturnType<App['createDebugApi']> }).__peekaboo = debugApi;

void app.start().catch((err) => {
  // 幼児向けなのでエラー画面は出さない。開発時のみコンソールに残す（不変条件7）。
  if (import.meta.env.DEV) console.error(err);
});

registerServiceWorker();

// 開発中のホットリロードでシーンが二重に走らないようにする
if (import.meta.hot) {
  import.meta.hot.dispose(() => app.dispose());
}
