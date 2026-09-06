/**
 * 音まわり（§2 音 / §10 core/AudioBus.ts）
 *
 *  - 初期状態はミュート。ブラウザの自動再生制限対策も兼ねる
 *  - 最初のタップで水中の環境音がフェードインする
 *  - 設定でオフに固定できる（localStorage に保存）
 *  - 音量は控えめ（-18dBFS 目安）、突発音は作らない
 *
 * public/audio が空でも音が出るよう、素材が無ければ WebAudio で合成する。
 *  - 環境音: ノイズをローパスに通した水中のこもった音。ゆっくり揺らす
 *  - ぽちゃ: 低いサイン波を短く落とす + ごく短いノイズ
 *  - 泡  : 高めのサイン波を上げながら短く鳴らす
 * どれも立ち上がりに時間をかけ、クリックノイズが出ないようにしてある。
 */

/*
 * --------------------------------------------------------------------------
 * 出どころ: 水族館アプリ「みずのなか」の `src/core/AudioBus.ts`（816行）。
 * 実機（iOS のホーム画面アプリを含む）で検証済みなので書き直していない。
 * **水槽専用だった声だけを外した**（ばくん／餌の名前／カニ・カメ・エビ・貝）。
 * 残した `baa` は、みずのなかの「いないいないばあの岩」で使っていたものと
 * 同じクリップで、このアプリではそれが主役になる。
 * --------------------------------------------------------------------------
 */

// 素材のパスは公開時の base に合わせて解決する（GitHub Pages 対策）
import { BAA_WAV_BASE64 } from '../audio/baaClip';
import { resolveAssetUrl } from './AssetLoader';

/** §2: -18dBFS 目安 */
const DEFAULT_VOLUME = 0.13;
/** 環境音のフェードイン時間（秒）。急に鳴らさない */
const AMBIENT_FADE_SEC = 2.5;
/**
 * 読み上げの最短間隔（秒）。
 * 餌は1回のタップで3〜6粒出るので、間隔を空けないと
 * 「ばくんばくんばくん…」と重なって騒がしくなる。
 *
 * 0.85 秒にしていたが、埋め込みの「ばくんばくん」は 1.10 秒あるので
 * 次が前に食い込んで言葉が潰れていた。クリップより少し長くする。
 */
const SPEAK_MIN_INTERVAL_SEC = 1.25;
/**
 * 単発音（ぽちゃ・泡）のピーク。master の手前の値。
 * 声の大きさをこれと比べられるよう定数にしてある。
 */
export const ONE_SHOT_PEAK = 0.5;
/**
 * 「ばくんばくん」の音量。master の手前の値。
 *
 * ここを `volume * 4.5` にしていたのが「声が聞こえない」の原因だった。
 * master のゲインがすでに volume なので volume が二重に掛かり、
 * 実効 -39.4dBFS(RMS) まで落ちていた。同じ経路のぽちゃは -26.8dBFS。
 * 12.6dB 差＝体感で 1/4 の音量で、鳴ってはいるが環境音に埋もれていた。
 *
 * 直すのに 3.2 倍にしてみたが、それも駄目だった。master は音量スライダー
 * そのものなので、その手前で 1 を超えると音量を上げた端末だけ歪む。
 * 大きさは素材側で作る（scripts/normalize-voice.cjs が RMS -6.9dBFS・
 * ピーク -0.4dBFS に揃える）ことにして、ここは 1 のままにしておく。
 * 結果、実効 -24.7dBFS でぽちゃより 2dB 大きい。
 */
export const VOICE_CLIP_GAIN = 1;
/** 環境音の大きさ（master の手前）。声を出すあいだ一時的に下げる */
const AMBIENT_LEVEL = 0.9;
const STORAGE_KEY = 'baa.audio';

/**
 * 収録してある声。埋め込みの base64 は src/audio/*Clip.ts。
 *  - baa: 動物が飛び出したときの「ばあっ！」（§4-3 / §4-4）
 *
 * **動物ごとの声を足すときは、みずのなかと同じやり方にする**:
 * `scripts/make-voice.cjs` で WAV を作って base64 の .ts にし、
 * ここの `loadVoiceBase64` に**動的 import** で足す。静的に埋め込むと
 * 初期バンドルが声の本数ぶん膨らみ、起動時間を押し戻す
 * （みずのなかで 3本足したら 847KB → 1,023KB になった）。
 */
export type VoiceClip = 'baa' | 'kocchi';

/**
 * 素材の要らない単発音（不変条件7）。すべて WebAudio で合成する。
 *  - plop   … 押した実感（§4-3 の 0.00s）
 *  - bubble … 登場の山に添える小さな音（§4-4）
 *  - hop    … ぴょん（§4-5 の跳ね）
 *  - rustle … 草をかき分けるワサワサ（§4-5 / §4-6）
 *  - huh    … 空振りの「あれ？」（§4-6。**落胆の音にしない**）
 */
export type OneShot = 'plop' | 'bubble' | 'hop' | 'rustle' | 'huh';

/**
 * 声の base64 を取り出す。
 *
 * 餌ごとの3本だけ動的 import にして、初期バンドルから外している。
 * ファイルは1つの文字列定数しか持たないので、分割されたチャンクも
 * その文字列ぶんしかない
 */
async function loadVoiceBase64(name: VoiceClip): Promise<string> {
  switch (name) {
    case 'baa':
      return BAA_WAV_BASE64;
    case 'kocchi': {
      // **動的 import にすること**（CLAUDE.md）。静的に足したら
      // 初期バンドルが 847KB → 1,023KB になった実測がある。
      // このファイルは文字列定数1つしか持たないので、分割された
      // チャンクもその文字列ぶんしかない
      const mod = await import('../audio/kocchiClip');
      return mod.KOCCHI_WAV_BASE64;
    }
  }
}

interface StoredAudioSettings {
  muted: boolean;
  volume: number;
}

export class AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientLfo: OscillatorNode | null = null;

  private muted = true;
  /** 設定でオフに固定されているか（最初のタップでも鳴らさない） */
  private disabled = false;
  private volume = DEFAULT_VOLUME;
  private unlocked = false;
  private pendingAmbient: string | null = null;
  /** 同じ音が重なりすぎないようにする（連打対策 §2） */
  private lastOneShot = 0;
  /** ワサワサの最短間隔用。ほかの単発音とは別枠にする */
  private lastRustle = 0;
  /** ワサワサのノイズ。毎回作らずに使い回す（§10-3） */
  private rustleBuffer: AudioBuffer | null = null;
  /**
   * 読み上げが渋滞しないようにする（出るたびに喋るため）。
   *
   * **声ごとに持つ。** 1本にしていると、直前に別の動物が喋っていたせいで
   * いま押した動物の「ばあっ！」が黙って捨てられる。
   * 声の種類が違えば言葉として潰れないので、別々に数える
   */
  private readonly lastSpeak: Record<VoiceClip, number> = { baa: 0, kocchi: 0 };

  /** クリップを鳴らし終える AudioContext 時刻。重ねて再生しないため */
  private voiceBusyUntil = 0;
  /** 読み上げの慣らしが済んだか（済んでいない端末では合成音で代役を立てる） */
  private speechPrimed = false;
  /**
   * 「ばあっ！」の音声。
   *
   * 端末の読み上げ（SpeechSynthesis）は、iOS のホーム画面アプリで
   * 例外も投げずに黙って無視されることがあり、実機で声が出なかった。
   * 効果音は同じ経路で確実に鳴っているので、声も音声ファイルにして
   * 同じ経路（WebAudio）で鳴らす。
   */
  private readonly voiceBuffers: Record<VoiceClip, AudioBuffer | null> = { baa: null, kocchi: null };

  /** 声の準備状況。?debug=1 に出して実機で切り分けられるようにする */
  private voiceState: 'yet' | 'ok' | 'ng' = 'yet';
  /** 読み込み中の声。同じものを二重に取りに行かない */
  private readonly voiceLoads = new Map<VoiceClip, Promise<boolean>>();

  constructor() {
    const stored = this.load();
    if (stored) {
      this.disabled = stored.muted;
      this.volume = stored.volume;
    }
  }

  /**
   * 最初のユーザー操作で呼ぶ。AudioContext を作って解禁する。
   * §2「最初のタップで水中音がフェードイン」
   */
  unlock(): void {
    if (this.unlocked || this.disabled) return;

    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    } catch {
      return; // 音が出せなくてもアプリは動く
    }

    this.unlocked = true;
    this.muted = false;

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    void ctx.resume().catch(() => {
      /* iOS で拒否されても静かに諦める */
    });

    // 無音から目標音量へゆっくり上げる
    this.rampMaster(this.volume, AMBIENT_FADE_SEC);

    if (this.pendingAmbient !== null) {
      this.startAmbient(this.pendingAmbient);
      this.pendingAmbient = null;
    }

    this.primeSpeech();
    void this.loadVoiceClip();
  }

  /**
   * 「ばくんばくん」を用意する。
   *
   * 音声はコードに埋め込んである（src/audio/bakunClip.ts）。
   * 別ファイルにすると「新しい JS は来たのに音声だけ古いキャッシュのまま」
   * という食い違いが起こりうるため。取得に失敗する経路そのものを無くす。
   */
  private async loadVoiceClip(): Promise<void> {
    // 起動時に要るのは2本だけ。餌ごとの「〇〇うまあ」は選ばれてから読む
    this.voiceState = (await this.ensureVoice('baa')) ? 'ok' : 'ng';
  }

  /**
   * 声を1本用意する。用意できたら true。
   *
   * いまは `baa` の1本だけなので静的に持っている。
   * **動物ごとの声を足すときは動的 import にすること**（上の VoiceClip の注記）。
   * 読み込みが間に合わなかった回だけ、読み上げか合成音が代役に立つ
   * （§2 無音にしない）。
   */
  async ensureVoice(name: VoiceClip): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (this.voiceBuffers[name]) return true;
    const pending = this.voiceLoads.get(name);
    if (pending) return pending;

    const task = (async (): Promise<boolean> => {
      try {
        const b64 = await loadVoiceBase64(name);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        this.voiceBuffers[name] = await ctx.decodeAudioData(bytes.buffer);
        return true;
      } catch {
        // デコードできない端末では読み上げ／合成音に落ちる（§2 エラー画面を出さない）
        return false;
      }
    })();
    this.voiceLoads.set(name, task);
    return task;
  }

  /**
   * 読み上げを一度だけ慣らしておく。
   *
   * iOS Safari は、ユーザー操作の中で一度も speak() を呼んでいないと、
   * その後の読み上げを黙って無視する。餌を食べるのはタップの後（非同期）で
   * 操作の外なので、解禁するこのタイミング（タップの中）で慣らす。
   *
   * 空文字を渡してはいけない。iOS では終了イベントが返らず speaking が
   * true のまま固まることがあり、以降の読み上げが全部スキップされる。
   * 実際それで「何も喋らない」状態になっていた。
   * 短い実文字を音量0で喋らせ、すぐ cancel して確実に空にする。
   */
  private primeSpeech(): void {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      // 一部の端末は最初の getVoices() が空で、これを呼ぶと読み込みが始まる
      synth.getVoices();
      const u = new SpeechSynthesisUtterance('あ');
      u.volume = 0;
      u.lang = 'ja-JP';
      synth.speak(u);
      synth.cancel();
      this.speechPrimed = true;
    } catch {
      /* 使えない端末では何もしない */
    }
  }

  /** ja-JP の声を選ぶ。無ければ既定の声に任せる。 */
  private pickJapaneseVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    try {
      const voices = synth.getVoices();
      return voices.find((v) => v.lang.toLowerCase().startsWith('ja')) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 読み上げが使えないときの「ばくん」。WebAudio で作る。
   *
   * iOS のホーム画面アプリでは読み上げが動かないことがある。
   * そのときに無音になると「食べた」が伝わらないので、
   * 母音のフォルマントを模した2音節を鳴らして代役にする。
   * 本物の声には聞こえないが、口の動きとしては伝わる。
   */
  /** 読み込んだ声を鳴らす。鳴らせたら true。 */
  private playVoiceClip(name: VoiceClip): boolean {
    const ctx = this.ctx;
    const buffer = this.voiceBuffers[name];
    if (!ctx || !this.master || !buffer) return false;
    // まだ前の声が鳴っている最中なら重ねない。
    // 重なると言葉として聞き取れなくなる（§2 突発音を作らない）
    if (ctx.currentTime < this.voiceBusyUntil) return true;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      // master がすでに音量を持っているので、ここでは掛けない（VOICE_CLIP_GAIN の説明）
      const t0 = ctx.currentTime;
      // 先頭の「ば」は破裂音で、いきなり鳴らすとプチッと言う。
      // 8ms だけ立ち上げる。子音の勢いは残る長さにしてある
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(VOICE_CLIP_GAIN, t0 + 0.008);
      src.connect(gain);
      gain.connect(this.master);
      src.start(t0);
      const until = t0 + buffer.duration;
      this.voiceBusyUntil = until;

      // 喋っているあいだだけ環境音を下げる。
      // 環境音は 320Hz のローパスなので言葉と帯域はあまり重ならないが、
      // 下げると「今きこえているのは声だ」と分かりやすくなる。
      // 急に切ると音が波打って気になるので、ゆるやかに戻す
      const ambient = this.ambientGain;
      if (ambient) {
        ambient.gain.cancelScheduledValues(t0);
        ambient.gain.setValueAtTime(ambient.gain.value, t0);
        ambient.gain.linearRampToValueAtTime(AMBIENT_LEVEL * 0.35, t0 + 0.08);
        ambient.gain.setValueAtTime(AMBIENT_LEVEL * 0.35, until);
        ambient.gain.linearRampToValueAtTime(AMBIENT_LEVEL, until + 0.4);
      }
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
      return true;
    } catch {
      return false;
    }
  }

  /** 1音節ぶん。破裂音のノイズ + フォルマントを通した声帯の振動 */
  private syllable(at: number, pitch: number, formant: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    // 声帯: のこぎり波を帯域通過させて母音らしくする
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(pitch * 1.15, at);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.85, at + dur);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(formant, at);
    band.Q.value = 4;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.5, at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    osc.connect(band);
    band.connect(gain);
    gain.connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      band.disconnect();
      gain.disconnect();
    };

    // 破裂音（子音の立ち上がり）。ごく短いノイズ
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.02));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.25, at);
    nGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    noise.connect(nGain);
    nGain.connect(this.master);
    noise.start(at);
    noise.onended = () => {
      noise.disconnect();
      nGain.disconnect();
    };
  }

  /** 水中の環境音を流す。url が読めなければ合成音にフォールバックする。 */
  playAmbient(url: string | null): void {
    if (this.disabled) return;
    if (!this.unlocked) {
      // まだ解禁前。最初のタップで流す
      this.pendingAmbient = url;
      return;
    }
    this.startAmbient(url);
  }

  private startAmbient(url: string | null): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.stopAmbient();

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    this.ambientGain = gain;

    // 水中のこもった音。ノイズをローパスに通す
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.7;
    filter.connect(gain);

    const source = ctx.createBufferSource();
    source.buffer = this.makeNoiseBuffer(ctx, 4);
    source.loop = true;
    source.connect(filter);
    source.start();
    this.ambientSource = source;

    // ゆっくりした揺らぎ（水の動き）。周期20秒なので明滅とは無関係
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 90;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
    this.ambientLfo = lfo;

    gain.gain.setTargetAtTime(AMBIENT_LEVEL, ctx.currentTime, AMBIENT_FADE_SEC / 3);

    // 素材があればそちらに差し替える（合成音は鳴らしたまま裏で読み込む）
    if (url) void this.tryLoadAmbientFile(url);
  }

  private async tryLoadAmbientFile(url: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const res = await fetch(resolveAssetUrl(url));
      if (!res.ok) return;
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      if (!this.ambientGain || this.ctx !== ctx) return;

      // 合成音を止めて、素材に差し替える
      this.ambientSource?.stop();
      this.ambientSource?.disconnect();
      this.ambientLfo?.stop();
      this.ambientLfo = null;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.ambientGain);
      source.start();
      this.ambientSource = source;
    } catch {
      // 素材が無いのは想定内。合成音のまま続ける
    }
  }

  private stopAmbient(): void {
    try {
      this.ambientSource?.stop();
    } catch {
      /* すでに止まっている */
    }
    this.ambientSource?.disconnect();
    this.ambientSource = null;
    try {
      this.ambientLfo?.stop();
    } catch {
      /* すでに止まっている */
    }
    this.ambientLfo?.disconnect();
    this.ambientLfo = null;
    this.ambientGain?.disconnect();
    this.ambientGain = null;
  }

  /**
   * 単発音（§7-2 タップ音「ぽちゃ」／食べたときの泡）。
   * どれも短く、控えめに。突発音にならないよう立ち上がりを鈍らせる。
   */
  /**
   * 短い言葉を喋る（餌を食べた瞬間の「ばくん」）。
   *
   * WebAudio の合成音と違い、読み上げは端末の音声エンジンに任せる。
   * 使えない端末では黙って何もしない（§2 エラー画面を出さない）。
   *
   * 気をつけていること:
   *  - ミュート中・音を解禁する前は喋らない（不変条件9）
   *  - 連打しても渋滞しないよう最短間隔を空け、
   *    まだ喋っている最中なら重ねない。§2「突発音を作らない」に反するため
   *  - 環境音は -18dBFS 目安だが、声はそれでは聞こえないので少し上げる
   */
  /**
   * 動物が飛び出した瞬間の「ばあっ！」（§4-3 の山 / §4-4）。
   *
   * **`speak()` を通さない。** あちらは読み上げ用の入口で、
   * 最短間隔 1.25秒 の制限が掛かっている。それだと
   * 別の隠れ場所を続けて押したときに声が落ちて、
   * 「押したのに ばあっ！ が返らない」回ができる（実際そうなっていた）。
   *
   * ここは**録音した1本を鳴らすだけ**。重なりは `playVoiceClip` の
   * `voiceBusyUntil` が防ぐので、言葉が潰れることはない。
   * まだデコードが終わっていない初回だけ、合成音が代役に立つ（§2 無音にしない）。
   */
  playVoice(clip: VoiceClip = 'baa'): void {
    if (this.muted || this.disabled || !this.unlocked) return;
    if (this.playVoiceClip(clip)) return;
    void this.ensureVoice(clip);
    this.fallbackVoice(clip);
  }

  speak(text: string, clip: VoiceClip = 'baa'): void {
    if (this.muted || this.disabled || !this.unlocked) return;

    const now = performance.now() / 1000;
    if (now - this.lastSpeak[clip] < SPEAK_MIN_INTERVAL_SEC) return;
    this.lastSpeak[clip] = now;

    // 音声ファイルがあればそれを鳴らす。効果音と同じ経路なので、
    // 効果音が聞こえている端末では必ず声も出る。
    if (this.playVoiceClip(clip)) return;
    // まだ読めていない声は、ここで読み始める。
    // 今回は読み上げか合成音が代役に立つ（§2 無音にしない）
    void this.ensureVoice(clip);

    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth || !this.speechPrimed) {
      this.fallbackVoice(clip);
      return;
    }

    try {
      // 前の発話が残っていたら捨てる。
      // speaking / pending を見て「喋っている最中なら諦める」にしていたが、
      // iOS は一度詰まると speaking が true のまま戻らず、以降ずっと
      // 無音になった。諦めるのではなく、こちらから空にして仕切り直す。
      synth.cancel();

      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      const voice = this.pickJapaneseVoice(synth);
      if (voice) u.voice = voice;
      // 幼児向けに、少し高くて元気な声にする
      u.pitch = 1.5;
      u.rate = 1.05;
      // 読み上げは master を通らない（端末の音声エンジンが直接鳴らす）。
      // volume を掛けると二重に下がるうえ、ここで絞る意味も無い
      u.volume = 0.9;

      // 実際に声が出たか見張る。読み上げが動かない端末（iOS のホーム画面
      // アプリなど）では speak() が例外も投げずに黙って無視されるので、
      // 始まらなければ合成音で代役を立てる。
      let started = false;
      u.onstart = () => {
        started = true;
      };
      window.setTimeout(() => {
        if (!started) this.fallbackVoice(clip);
      }, 450);

      synth.speak(u);
    } catch {
      this.fallbackVoice(clip);
    }
  }

  /**
   * 読み上げが使えないときの代役。
   * 声の種類が増えたら、ここで種類ごとに違う形に分ける
   * （みずのなかは「ばあ」と「ばくん」で母音とフォルマントを変えていた）。
   */
  private fallbackVoice(_clip: VoiceClip): void {
    this.peekVoice();
  }

  /**
   * 読み上げが使えないときの「ばあっ！」。WebAudio で作る。
   *
   * **上がって開く**1音節にする。
   * 隠れ場所から飛び出す合図なので、短く・高め・語尾を上げる。
   * 突発音にならないよう 10ms で立ち上げる（§2）
   */
  private peekVoice(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    // 「ば」= 開いた母音。フォルマントを上へ滑らせて「あっ！」の勢いを出す
    this.syllable(ctx.currentTime, 260, 900, 0.3);
  }

  /**
   * とても大きい動物が出るときの低く柔らかい音（§6-3 サプライズ）。
   *
   * 突発音は禁止なので、1.5秒かけて立ち上げ、2.5秒かけて消える。
   * 低い正弦波を2つ重ねただけ。素材は要らない（不変条件7）。
   * 大きさは `master` に任せる（ここで 1 を超えるゲインを掛けない）。
   */
  playSwell(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || this.disabled) return;

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    // §2: 突発音を作らない。ゆっくり膨らませてゆっくり消す
    gain.gain.exponentialRampToValueAtTime(0.32, now + 1.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.0);
    gain.connect(this.master);

    const oscs: OscillatorNode[] = [];
    // 低い2音。わずかにずらして「うねり」を作る
    for (const [freq, level] of [
      [58, 1],
      [87.5, 0.45],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      // ゆっくり下がる。近づいて離れていく感じ
      osc.frequency.linearRampToValueAtTime(freq * 0.88, now + 4.0);
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g);
      g.connect(gain);
      osc.start(now);
      osc.stop(now + 4.1);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
      oscs.push(osc);
    }
    oscs[0].onended = () => {
      gain.disconnect();
    };
  }

  playOneShot(name: OneShot): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || this.disabled) return;

    // 連打で音が重なりすぎないよう最小間隔を設ける。
    // ワサワサ（rustle）だけは別枠。ふたが開く音と跳ねる音は
    // 同じ瞬間に鳴ることがあり、片方が消えると動きと音がずれて聞こえる
    const now = ctx.currentTime;
    const gate = name === 'rustle' ? this.lastRustle : this.lastOneShot;
    const minGap = name === 'rustle' ? 0.18 : 0.05;
    if (now - gate < minGap) return;
    if (name === 'rustle') this.lastRustle = now;
    else this.lastOneShot = now;

    if (name === 'rustle') {
      this.playRustle(now);
      return;
    }

    const gain = ctx.createGain();
    gain.connect(this.master);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.connect(gain);

    if (name === 'hop') {
      // ぴょん。**短く、上がって終わる。** 落ちる音にすると
      // 「着地に失敗した」ように聞こえて、跳ねている絵と合わない（§4-5）
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(330, now);
      osc.frequency.exponentialRampToValueAtTime(760, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(ONE_SHOT_PEAK * 0.5, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (name === 'huh') {
      // §4-6 の「あれ？」。**落胆の音にしない。**
      // 下がってから少し上がる、とぼけた2音。ブザーにはしない
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.14);
      osc.frequency.exponentialRampToValueAtTime(430, now + 0.3);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(ONE_SHOT_PEAK * 0.42, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.42);
    } else if (name === 'plop') {
      // 低い音を短く落とす
      osc.frequency.setValueAtTime(420, now);
      osc.frequency.exponentialRampToValueAtTime(90, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(ONE_SHOT_PEAK, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.24);
    } else {
      // 泡は上がっていく短い音
      osc.frequency.setValueAtTime(680, now);
      osc.frequency.exponentialRampToValueAtTime(1500, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.16);
    }

    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  /** --- 設定 -------------------------------------------------------------- */

  /** 設定パネルからのオン・オフ（§2 設定でオフ固定可） */
  setMuted(muted: boolean): void {
    this.disabled = muted;
    this.muted = muted;
    this.save();

    if (!this.ctx || !this.master) return;
    if (muted) {
      this.rampMaster(0, 0.4);
    } else {
      void this.ctx.resume().catch(() => {});
      this.rampMaster(this.volume, 0.8);
      if (!this.ambientSource) this.startAmbient(this.pendingAmbient);
    }
  }

  isMuted(): boolean {
    return this.disabled;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.save();
    if (!this.muted) this.rampMaster(this.volume, 0.3);
  }

  getVolume(): number {
    return this.volume;
  }

  /**
   * 音まわりの状態。?debug=1 の表示に出す。
   * 「音が出ない」と言われたとき、ミュートなのか・解禁前なのか・
   * 読み上げが使えないのかを実機で切り分けられるようにするため。
   */
  debugState(): string {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    return [
      this.disabled ? 'off' : this.muted ? 'mute' : this.unlocked ? 'on' : 'wait',
      `声${this.voiceState}`,
      synth ? (this.speechPrimed ? 'tts' : 'tts?') : 'tts-none',
    ].join('/');
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  /** --- 内部 -------------------------------------------------------------- */

  private rampMaster(value: number, seconds: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value, now + seconds);
  }

  /**
   * 草をかき分ける「ワサワサ」（§4-5 / §4-6）。
   *
   * ノイズをバンドパスに通して、山を2つ作る。
   * **1回の連続したノイズにしないこと。** それだと「シュー」という
   * 空気の音になって、葉が擦れている感じにならない。
   * 帯域を 1.4kHz 付近に置いてあるのは、そこを外すと
   * 低いと「風」、高いと「砂」に聞こえるため。
   */
  private playRustle(now: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = this.rustleBuffer ?? (this.rustleBuffer = this.makeRustleBuffer(ctx));

      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.setValueAtTime(1200, now);
      band.frequency.linearRampToValueAtTime(2100, now + 0.18);
      band.Q.value = 0.9;

      const gain = ctx.createGain();
      // 2度こすれる。葉のあいだを手が通る感じ
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(ONE_SHOT_PEAK * 0.34, now + 0.03);
      gain.gain.linearRampToValueAtTime(ONE_SHOT_PEAK * 0.12, now + 0.13);
      gain.gain.linearRampToValueAtTime(ONE_SHOT_PEAK * 0.26, now + 0.2);
      gain.gain.linearRampToValueAtTime(0.0001, now + 0.36);

      src.connect(band);
      band.connect(gain);
      gain.connect(this.master);
      src.start(now);
      src.stop(now + 0.38);
      src.onended = () => {
        src.disconnect();
        band.disconnect();
        gain.disconnect();
      };
    } catch {
      /* 鳴らせなくてもアプリは動く（§2 エラー画面を出さない） */
    }
  }

  /** ワサワサ用の白いノイズ。0.5秒ぶんを作って使い回す（毎回作らない） */
  private makeRustleBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** ホワイトノイズより低域に寄せた（水中らしい）ノイズを作る */
  private makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      // 一次のローパス（ブラウンノイズ寄り）
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    // ループの継ぎ目を消す
    const fade = Math.floor(ctx.sampleRate * 0.25);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] *= t;
      data[length - 1 - i] *= t;
    }
    return buffer;
  }

  private load(): StoredAudioSettings | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredAudioSettings>;
      return {
        muted: parsed.muted === true,
        volume:
          typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1
            ? parsed.volume
            : DEFAULT_VOLUME,
      };
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ muted: this.disabled, volume: this.volume })
      );
    } catch {
      /* プライベートモード等で書けなくても無視する */
    }
  }

  dispose(): void {
    this.stopAmbient();
    this.master?.disconnect();
    this.master = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.unlocked = false;
  }
}
