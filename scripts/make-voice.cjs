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

// 無音を落とし、音量を揃え、16kHz モノラルの PCM にする。
// mp3 ではなく PCM なのは、コーデックに依存せずどの端末でも鳴らすため。
execFileSync(require('ffmpeg-static'), [
  '-v', 'error', '-i', tmp, '-t', String(clip.seconds),
  '-af', 'silenceremove=start_periods=1:start_threshold=-40dB,loudnorm=I=-16:TP=-1.5:LRA=11',
  '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out, '-y',
]);

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
