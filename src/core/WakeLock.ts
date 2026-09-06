/**
 * 画面を消さない（§2 / §10 core/WakeLock.ts）
 *
 *  - Screen Wake Lock API を使う
 *  - 非対応（iOS Safari 16.3 以前など）ではサイレント動画のループで代用する
 *    再生中の動画があると OS が画面を消さない、という古くからの手
 *  - タブが裏に回ると OS がロックを解除するので、戻ってきたら取り直す
 *
 * 取れなくてもアプリは普通に動く。エラーは出さない（§2）。
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', fn: () => void): void;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export class WakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private fallbackVideo: HTMLVideoElement | null = null;
  private wanted = false;

  private readonly onVisibility = () => {
    // 復帰したら取り直す（OS が裏で解除しているため）
    if (this.wanted && document.visibilityState === 'visible') {
      void this.request();
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  async request(): Promise<void> {
    this.wanted = true;
    if (this.sentinel && !this.sentinel.released) return;

    const nav = navigator as Navigator & WakeLockNavigator;
    if (nav.wakeLock) {
      try {
        this.sentinel = await nav.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => {
          this.sentinel = null;
        });
        this.stopFallback();
        return;
      } catch {
        // 権限が無い／非対応。動画フォールバックへ
      }
    }
    this.startFallback();
  }

  async release(): Promise<void> {
    this.wanted = false;
    try {
      await this.sentinel?.release();
    } catch {
      /* すでに解除済み */
    }
    this.sentinel = null;
    this.stopFallback();
  }

  isActive(): boolean {
    return (this.sentinel !== null && !this.sentinel.released) || this.fallbackVideo !== null;
  }

  /** Wake Lock API を使えているか（設定パネルの表示用） */
  usesNativeLock(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  /**
   * 極小の無音動画をループ再生して、OS に画面を消させない。
   *
   * どちらの形式が再生できるかはブラウザによる:
   *   iOS Safari  → H.264/MP4（Wake Lock API が入る 16.4 より前で必要になるのはここ）
   *   Chrome 系   → VP8/WebM も MP4 も可
   * canPlayType で再生できると答えた方から順に試す。
   * 中身は 1px 相当でしか表示しないので、映像の内容には意味がない。
   */
  private startFallback(): void {
    if (this.fallbackVideo) return;

    const probe = document.createElement('video');
    const candidates: Array<{ type: string; src: string }> = [
      { type: 'video/mp4; codecs="avc1.42E01E"', src: SILENT_LOOP_MP4 },
      { type: 'video/webm; codecs="vp8"', src: SILENT_LOOP_WEBM },
    ].filter((c) => probe.canPlayType(c.type) !== '');

    void this.tryFallbackSources(candidates);
  }

  private async tryFallbackSources(
    candidates: Array<{ type: string; src: string }>
  ): Promise<void> {
    for (const candidate of candidates) {
      if (!this.wanted) return;
      const video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true');
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      // 画面外に置き、描画コストをかけない
      video.style.cssText =
        'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:-1px;top:-1px';
      video.src = candidate.src;
      document.body.appendChild(video);

      try {
        await video.play();
        this.fallbackVideo = video;
        return;
      } catch {
        // この形式は再生できなかった。次を試す
        video.removeAttribute('src');
        video.load();
        video.remove();
      }
    }
    // どれも再生できなかった。画面が消えるだけでアプリは動く（§2 エラーは出さない）
  }

  private stopFallback(): void {
    if (!this.fallbackVideo) return;
    this.fallbackVideo.pause();
    this.fallbackVideo.removeAttribute('src');
    this.fallbackVideo.load();
    this.fallbackVideo.remove();
    this.fallbackVideo = null;
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.release();
  }
}

/**
 * 無音・極小の MP4（ほぼ最小構成の1フレーム動画）。
 * Wake Lock API が無い端末で画面を消させないためだけに使う。
 */
const SILENT_LOOP_MP4 =
  'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAs1tZGF0AAACrAYF//' +
  '+o3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE0OCByMjY0MyA1YzY1NzA0IC0gSC4yNjQvTVBFRy00IEFWQyBjb2Rl' +
  'YyAtIENvcHlsZWZ0IDIwMDMtMjAxNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IG' +
  'NhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lf' +
  'cmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW' +
  '09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFk' +
  'X3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD' +
  '0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9' +
  'MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIG' +
  'ludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBt' +
  'aW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAA3//728P4FNjuZQQAAAu' +
  'Ztb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAKAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAA' +
  'AAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACGHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAA' +
  'AAAAEAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAoAAAAFoA' +
  'AAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAACgAAAAAAAEAAAAAAZBtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAACtIAA' +
  'AASABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABO21pbmYAAAAUdm1oZAAA' +
  'AAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAPtzdGJsAAAAl3N0c2QAAAAAAAAAAQ' +
  'AAAIdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAGP//AAAAMWF2Y0MBZAAK/+EAGGdkAAqs2V+ImgLQgAADAIAAAAMCg8SJZgEABmjr48siwAAAABhzdH' +
  'RzAAAAAAAAAAEAAAABAAAAQAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALGAAAAAQAAABRz' +
  'dGNvAAAAAAAAAAEAAAAwAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAA' +
  'AtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY1Ni40MC4xMDE=';

/** 同じ用途の VP8/WebM 版（Chrome 系はこちらでも動く） */
const SILENT_LOOP_WEBM =
  'data:video/webm;base64,' +
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAASDEU2bdLpNu4tTq4QVSalmU6yBoU27i1' +
  'OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEwTbuMU6uEHFO7a1OsggRt7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSa' +
  'lmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAp3AAAAAAABZUrmvVrgEAAAAAAABM14EBc8WI' +
  'dciV5aEXOQucgQAitZyDZW5nhoVWX1ZQOIOBASPjg4Q7msoA4KCwgSC6gSCagQJUsIE5VLqBIFWwjFW5gQFVt4ECVbiBAh' +
  'JUw2f6c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2MS4xLjEwMHNz1WPAi2PFiHXIleWhFzkLZ8igRaOHRU5DT0RFUkSH' +
  'k0xhdmM2MS4zLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAzLjAwMDAwMDAwMAAfQ7Z1QrjngQCjQfGBAA' +
  'CAUAkAnQEqIAAgAAAHCIWFiJmEiAIC7juEcSgh1r1bj2hLVbpN58KyG6//Mr/o/UYzQPPXsA/qj/uesD6AP6ze2wC+K5+W' +
  'aTo7r9PRwq9yDbtAN/yg/v05z/+vf/+LD/598P8ivzdOm6X/h2e0eZC+Y+v42RSnhvf4N/8/H/6ufg/D2w0X5Q9ZjbSEX5' +
  '3oKttP93m7Mp41xb+89AzytkfbPKMisXfNFXS7T/5KZF8w+AoYTjEfypdTZR/dKK45Rtz6GmwFd4i9v8s9bl41Z4uh1LaL' +
  '1mZg6lFwD5z10Wd40hYpY1MsU8Fqqgg/l26ObPDvqP4TXI0j7UEv54aYZALlI1qjXcUmJPtEGFAmxDiocE3pDM6FUqjHAN' +
  'ZpqGZ5yTxsmZOq9eVkirSHb99cS/oH51fYkJm6+LWR1wfpM7qI4tZJsqI5+Lls8x/3iPXdx/BQvfMf01vP0t/5cf7df/FU' +
  'QL+UP+GbfFL+68a1RMeXtwCPIlUN+MvZ6WLkAg54ptN/nzl9H6SAIKk0k75VeQxsbsJF5AU+Dl644slbh/ct4106HPkbaD' +
  'Xz/KXuOxlT8zM5F7zHPCA1AFH5iYVAH29KxDEwBvpancl+YK/zRh/GpJPsd/ZXugRmjiONRYlEgl0aQZZdkpOdGZXHOAQI' +
  'AKPVgQPoABEDAAAQEAAeS41pXl1TjVDcAP6HdE9uJACHAGsfcUzHxo0FGeHVM8FjoI2gAL8QFdDe9aRRqafLETSgWeFzhC' +
  '+3krkAAwXbSHN+AUusm6cDoKPogQfQAFEDAAcQEAAazA/iC/QPIGQgKqBqQAoP/YKANZxg/v+ItnD0F/1nRv+H+QjjO8Q2' +
  '233J3Oq/oPfuO2bQjDAgP6pVpubftW9htxykAwXUGZquUf5IqjEUCKeFaT84vTh3qA1gAAAcU7trkbuPs4EAt4r3gQHxgg' +
  'Gv8IED';
