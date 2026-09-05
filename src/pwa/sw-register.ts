/**
 * Service Worker の登録（§3 PWA / §10 pwa/sw-register.ts）
 *
 * 動画・モデル・音をキャッシュしてオフラインでも起動できるようにする（§2）。
 * 新しい版が見つかったら黙って差し替える（registerType: 'autoUpdate'）。
 * 幼児が見ている最中に「更新しますか？」のような確認は出さない。
 *
 * 開発中は登録しない（古いキャッシュが残ると原因の切り分けができないため）。
 */

export function registerServiceWorker(): void {
  if (import.meta.env.DEV) return;

  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        onRegisterError() {
          /* 登録できなくてもアプリは普通に動く（§2 エラー画面を出さない） */
        },
      });
    })
    .catch(() => {
      /* PWA プラグインが無い構成でも落とさない */
    });
}
