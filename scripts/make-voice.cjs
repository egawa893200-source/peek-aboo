/**
 * 声の音声を作り直す。
 *
 *   npm i -D mespeak ffmpeg-static
 *   node scripts/make-voice.cjs [clip] [pitch] [speed]
 *
 * clip は bakun（既定）か baa。数値を先に渡した場合は bakun とみなす
 * （README に書いてある古い呼び方 `node scripts/make-voice.cjs 75 135` を壊さないため）。
 *
 * 端末の読み上げ（SpeechSynthesis）は iOS のホーム画面アプリで黙って
 * 無視されることがあり、実機で声が出なかった。そのため音声ファイルにして、
 * 効果音と同じ WebAudio の経路で鳴らしている。
 *
 * mespeak（eSpeak の JS 移植）には日本語の声が入っていないので、
 * スペイン語の声にローマ字を読ませている。母音がほぼ一致するので
 * 「バクン」に近い発音になる。
 *
 * 生成物は src/audio/bakunClip.ts（base64）。別ファイルではなくコードに
 * 埋め込むのは、「新しい JS は来たのに音声だけ古いキャッシュのまま」という
 * 食い違いを避けるため。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 収録する声。
 *
 * mespeak（eSpeak の JS 移植）には日本語の声が入っていないので、
 * スペイン語の声にローマ字を読ませている。
 *
 * baa（「ばあっ！」）は岩の住人が飛び出す合図なので、
 * ばくんばくんより高く・短くする。長いと出てくる動きに遅れて聞こえる。
 */
const CLIPS = {
  bakun: { text: 'bakun bakun', pitch: 75, speed: 135, seconds: 1.1, konst: 'BAKUN_WAV_BASE64', file: 'bakunClip.ts' },
  baa: { text: 'baaa', pitch: 96, speed: 118, seconds: 0.75, konst: 'BAA_WAV_BASE64', file: 'baaClip.ts' },
  // §4-6 の「こっちこっち〜」（2026-09-06）。外したときに正解の場所が揺れる、
  // その合図。**急かす声にしないこと**（外れを「失敗」にしない）ので、
  // ばあより低く・ゆっくりにしてある
  // **`kochi` と綴ると「こち こち」に聞こえる**（2026-09-07 に実機で指摘された）。
  // 促音「っ」は子音の閉鎖なので、綴りに閉鎖音を1つ入れないと出ない。
  // スペイン語の 'ch' は /tʃ/ の二重字なので、直前の 't' は独立した /t/ になり、
  // `kotchi` = /ko t.tʃi/ ＝ そのまま「こっち」になる。
  // 実測（10ms ごとの波形の山）: `kochi` は「こ」のあとに 40ms の谷しか無いが、
  // `kotchi` は 60ms + 70ms の谷が2つ入って閉鎖が聞こえる。
  // speed も 108 → 100 に落とした（§4-6「急かす声にしない」）。
  // 中身は 1.45秒 なので seconds は少し長めに取る
  kocchi: {
    text: 'kotchi kotchii',
    pitch: 88,
    speed: 100,
    seconds: 1.55,
    konst: 'KOCCHI_WAV_BASE64',
    file: 'kocchiClip.ts',
  },
  // 選べる餌を食べたときの「〇〇うまあ」（§7-1 / 2026-08-31）。
  // にんじんは 'ninjin' と綴るとスペイン語の j が /x/（ハ行）になるので 'ninyin'。
  // きのこ・いちごはローマ字のままでスペイン語の音とほぼ一致する
  ninjin: { text: 'ninyin umaa', pitch: 82, speed: 128, seconds: 1.2, konst: 'NINJIN_WAV_BASE64', file: 'ninjinClip.ts' },
  kinoko: { text: 'kinoko umaa', pitch: 82, speed: 128, seconds: 1.2, konst: 'KINOKO_WAV_BASE64', file: 'kinokoClip.ts' },
  ichigo: { text: 'ichigo umaa', pitch: 82, speed: 128, seconds: 1.2, konst: 'ICHIGO_WAV_BASE64', file: 'ichigoClip.ts' },
  // §17-4 カニ・カメをタップしたときの声（2026-08-31）。
  // スペイン語の声にローマ字を読ませる都合上、'chokki' の ch は /tʃ/ でそのまま合う
  kani: { text: 'kani san chokki chokki', pitch: 92, speed: 132, seconds: 1.6, konst: 'KANI_WAV_BASE64', file: 'kaniClip.ts' },
  kame: { text: 'kame san sui sui', pitch: 78, speed: 112, seconds: 1.6, konst: 'KAME_WAV_BASE64', file: 'kameClip.ts' },
  ebi: { text: 'ebi san pyon pyon', pitch: 98, speed: 138, seconds: 1.6, konst: 'EBI_WAV_BASE64', file: 'ebiClip.ts' },
  kai: { text: 'kai san pakaa', pitch: 86, speed: 120, seconds: 1.4, konst: 'KAI_WAV_BASE64', file: 'kaiClip.ts' },
};

const first = process.argv[2];
const name = first && Number.isNaN(Number(first)) ? first : 'bakun';
const clip = CLIPS[name];
if (!clip) throw new Error(`知らない clip: ${name}（${Object.keys(CLIPS).join(' / ')}）`);
const argOffset = first && Number.isNaN(Number(first)) ? 1 : 0;
const pitch = Number(process.argv[2 + argOffset] ?? clip.pitch);
const speed = Number(process.argv[3 + argOffset] ?? clip.speed);

const meSpeak = require('mespeak');
meSpeak.loadConfig(require('mespeak/src/mespeak_config.json'));
meSpeak.loadVoice(require('mespeak/voices/es.json'));

const raw = meSpeak.speak(clip.text, { pitch, speed, amplitude: 100, rawdata: 'buffer' });
if (!raw) throw new Error('音声を生成できなかった');

const tmp = path.join(require('os').tmpdir(), `${name}-src.wav`);
const out = path.join(require('os').tmpdir(), `${name}.wav`);
fs.writeFileSync(tmp, Buffer.from(raw));

// 無音を落とし、16kHz モノラルの PCM にする。
// mp3 ではなく PCM なのは、コーデックに依存せずどの端末でも鳴らすため。
//
// **ffmpeg が無い環境でも作れるようにしてある**（2026-09-06）。
// ffmpeg-static はインストール時にバイナリを落としてくるが、
// 開発コンテナでは install script が止められていて落ちてこない。
// mespeak が返すのは素の 16bit PCM WAV なので、切り詰めと間引きは JS で足りる。
// 音量は下の normalize-voice.cjs が揃えるので、loudnorm は要らない。
const ffmpegPath = (() => {
  try {
    const p = require('ffmpeg-static');
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

if (ffmpegPath) {
  execFileSync(ffmpegPath, [
    '-v', 'error', '-i', tmp, '-t', String(clip.seconds),
    '-af', 'silenceremove=start_periods=1:start_threshold=-40dB,loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out, '-y',
  ]);
} else {
  fs.writeFileSync(out, convertWav(fs.readFileSync(tmp), clip.seconds));
  console.log('（ffmpeg が無いので JS で変換した）');
}

/** 16bit PCM の WAV を、頭の無音を落として 16kHz モノラルに作り直す */
function convertWav(buf, seconds) {
  // WAV のチャンクを辿って fmt と data を拾う
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') data = buf.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV を読めなかった');
  if (fmt.bits !== 16) throw new Error(`16bit ではない WAV: ${fmt.bits}bit`);

  // モノラルにする（複数チャンネルなら平均）
  const frames = Math.floor(data.length / 2 / fmt.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = sum / fmt.channels / 32768;
  }

  // 頭の無音を落とす（-40dB ＝ 0.01）
  let start = 0;
  while (start < mono.length && Math.abs(mono[start]) < 0.01) start++;
  const trimmed = mono.subarray(start);

  // 16kHz へ。線形補間で足りる（16kHz の音声品質で差が出ない）
  const TARGET = 16000;
  const keep = Math.min(trimmed.length, Math.round(fmt.rate * seconds));
  const outLen = Math.max(1, Math.round((keep * TARGET) / fmt.rate));
  const pcm = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const src = (i * fmt.rate) / TARGET;
    const i0 = Math.floor(src);
    const i1 = Math.min(keep - 1, i0 + 1);
    const t = src - i0;
    const v = trimmed[i0] * (1 - t) + trimmed[i1] * t;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(TARGET, 24);
  header.writeUInt32LE(TARGET * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// 効果音と同じくらい聞こえる大きさに揃える。
// loudnorm だけでは -17dBFS(RMS) にしかならず、実機で環境音に埋もれた
const { normalizeWav } = require('./normalize-voice.cjs');
const b64 = normalizeWav(fs.readFileSync(out)).toString('base64');
const lines = b64.match(/.{1,96}/g) ?? [];
const dest = path.join(__dirname, '..', 'src', 'audio', clip.file);
const header = fs.existsSync(dest)
  ? fs.readFileSync(dest, 'utf8').split('export const')[0]
  : `/**\n * 「${name}」の音声（16kHz モノラル PCM の WAV を base64 にしたもの）。\n * scripts/make-voice.cjs が書き出す。手で編集しないこと。\n */\n`;
fs.writeFileSync(dest, `${header}export const ${clip.konst} =\n  '${lines.join("' +\n  '")}';\n`);

console.log(`${name}: pitch=${pitch} speed=${speed} → ${Math.round(b64.length / 1024)}KB を ${dest} に書き出した`);
