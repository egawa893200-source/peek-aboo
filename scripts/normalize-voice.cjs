/**
 * 「ばくんばくん」の WAV を、効果音と同じくらい聞こえる大きさに揃える。
 *
 * 一度、コード側のゲインを上げて大きくしようとして失敗している。
 * master のゲインは音量スライダーの値なので、そこを通る前に 1 を超える
 * ゲインを掛けると、音量を上げた端末だけ歪む。大きさは素材側で作り、
 * コード側のゲインは 1 以下（混ぜ具合だけ）にしておく。
 *
 * 声は波形のピークだけが高く平均は低い（子音の破裂音）ので、単純に
 * 定数倍するとピークが先に頭打ちになって大きくならない。tanh で
 * 頭を丸めながら持ち上げる（リミッター）。
 */

/** 16bit PCM の WAV を読む */
function readWav(buf) {
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('WAV ではない');
  let off = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      dataStart = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error('fmt / data チャンクが無い');
  if (fmt.bits !== 16) throw new Error(`16bit 以外は扱わない: ${fmt.bits}bit`);
  return { fmt, dataStart, dataLen };
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * @param {Buffer} buf 16bit PCM の WAV
 * @param {{targetRms?: number, ceiling?: number}} opts
 * @returns {Buffer} 同じ WAV のサンプルを書き換えたもの
 */
function normalizeWav(buf, opts = {}) {
  // 0.45 は、ぽちゃ（ピーク 0.5 の正弦波 = RMS 0.354）より 2dB ほど大きい。
  // 声は帯域が広く、環境音のノイズに埋もれやすいので同じでは足りない。
  // 天井 0.95 は、音量を最大にしても歪まないための余裕
  const targetRms = opts.targetRms ?? 0.45;
  const ceiling = opts.ceiling ?? 0.95;

  const { dataStart, dataLen } = readWav(buf);
  const n = dataLen / 2;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(dataStart + i * 2) / 32768;

  // tanh を通した後の RMS が目標になるゲインを二分探索で探す。
  // 解析的には解けないが、ゲインに対して単調なので確実に決まる
  const shaped = new Float64Array(n);
  const apply = (g) => {
    for (let i = 0; i < n; i++) shaped[i] = Math.tanh((x[i] * g) / ceiling) * ceiling;
    return rms(shaped);
  };
  let lo = 1;
  let hi = 64;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (apply(mid) < targetRms) lo = mid;
    else hi = mid;
  }
  apply(hi);

  const out = Buffer.from(buf);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, shaped[i]));
    out.writeInt16LE(Math.round(v * 32767), dataStart + i * 2);
  }
  return out;
}

module.exports = { normalizeWav, readWav, rms };
