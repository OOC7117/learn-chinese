// Minimal MessagePack decoder (only what wordfreq's data files use: arrays, maps, strings, ints,
// nil/bool, floats). No dependencies. Spec: https://github.com/msgpack/msgpack/blob/master/spec.md

export function decodeMsgpack(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder('utf-8');
  let pos = 0;

  const str = (n) => {
    const s = text.decode(bytes.subarray(pos, pos + n));
    pos += n;
    return s;
  };
  const arr = (n) => {
    const out = new Array(n);
    for (let i = 0; i < n; i += 1) out[i] = read();
    return out;
  };
  const map = (n) => {
    const out = {};
    for (let i = 0; i < n; i += 1) {
      const key = read();
      out[key] = read();
    }
    return out;
  };

  function read() {
    const b = bytes[pos];
    pos += 1;
    if (b <= 0x7f) return b;
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);
    if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f);
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
    if (b >= 0xe0) return b - 0x100;
    let v;
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xca: v = view.getFloat32(pos); pos += 4; return v;
      case 0xcb: v = view.getFloat64(pos); pos += 8; return v;
      case 0xcc: v = bytes[pos]; pos += 1; return v;
      case 0xcd: v = view.getUint16(pos); pos += 2; return v;
      case 0xce: v = view.getUint32(pos); pos += 4; return v;
      case 0xd0: v = view.getInt8(pos); pos += 1; return v;
      case 0xd1: v = view.getInt16(pos); pos += 2; return v;
      case 0xd2: v = view.getInt32(pos); pos += 4; return v;
      case 0xd9: v = bytes[pos]; pos += 1; return str(v);
      case 0xda: v = view.getUint16(pos); pos += 2; return str(v);
      case 0xdb: v = view.getUint32(pos); pos += 4; return str(v);
      case 0xdc: v = view.getUint16(pos); pos += 2; return arr(v);
      case 0xdd: v = view.getUint32(pos); pos += 4; return arr(v);
      case 0xde: v = view.getUint16(pos); pos += 2; return map(v);
      case 0xdf: v = view.getUint32(pos); pos += 4; return map(v);
      default: throw new Error(`msgpack: unsupported type 0x${b.toString(16)} at ${pos - 1}`);
    }
  }
  return read();
}

/**
 * wordfreq "cB" files: [header, bucket0, bucket1, ...]; every word in bucket i (0-based) has frequency
 * 10^(-i/100) (i centibels below 1). Returns Map word -> { cb, zipf } (zipf = 9 - cb/100), plus the
 * rank (1 = most frequent; words in the same bucket share the rank of the bucket's first word).
 */
export function wordfreqTable(decoded) {
  const [header, ...buckets] = decoded;
  if (!header || header.format !== 'cB') throw new Error('not a wordfreq cB file');
  const out = new Map();
  let rank = 1;
  buckets.forEach((words, i) => {
    const cb = i; // data[1:][i] holds words of frequency 10^(-i/100) (wordfreq get_frequency_dict)
    for (const w of words) if (!out.has(w)) out.set(w, { cb, zipf: Math.round((9 - cb / 100) * 100) / 100, rank });
    rank += words.length;
  });
  return out;
}
