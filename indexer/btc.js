// Minimal Bitcoin primitives for CRC-20: secp256k1 point math, BIP340/341 tagged hashes,
// bech32m addresses, covenant (seal) addresses and OP_RETURN marker decoding. No dependencies.
const crypto = require('crypto');

/* ---------- secp256k1 (affine, BigInt) ---------- */
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [x, y, r, s] = [mod(a, m), m, 1n, 0n];
  while (y) { const q = x / y; [x, y] = [y, x - q * y]; [r, s] = [s, r - q * s]; }
  return mod(r, m);
}
function pow(b, e, m = P) { let r = 1n; b = mod(b, m); while (e) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function add(a, b) {
  if (!a) return b; if (!b) return a;
  if (a[0] === b[0]) { if (mod(a[1] + b[1]) === 0n) return null; return dbl(a); }
  const l = mod((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = mod(l * l - a[0] - b[0]);
  return [x, mod(l * (a[0] - x) - a[1])];
}
function dbl(a) {
  const l = mod(3n * a[0] * a[0] * inv(2n * a[1]));
  const x = mod(l * l - 2n * a[0]);
  return [x, mod(l * (a[0] - x) - a[1])];
}
function mul(k, pt = G) { let r = null; for (; k; k >>= 1n, pt = dbl(pt)) if (k & 1n) r = add(r, pt); return r; }
// BIP340 lift_x: the point with this x coordinate and an even y
function liftX(x) {
  if (x >= P) throw new Error('x out of range');
  const c = mod(x ** 3n + 7n), y = pow(c, (P + 1n) / 4n);
  if (mod(y * y) !== c) throw new Error('not on curve');
  return [x, y & 1n ? P - y : y];
}

/* ---------- hashing / bytes ---------- */
const hex = b => Buffer.from(b).toString('hex');
const toBig = b => BigInt('0x' + hex(b));
const big32 = n => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const sha256 = b => crypto.createHash('sha256').update(b).digest();
function taggedHash(tag, msg) { const t = sha256(Buffer.from(tag)); return sha256(Buffer.concat([t, t, msg])); }
const compactSize = n => { if (n < 0xfd) return Buffer.from([n]); if (n <= 0xffff) return Buffer.from([0xfd, n & 0xff, n >> 8]); const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; };

/* ---------- bech32 / bech32m ---------- */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; }
  return chk;
}
const hrpExpand = h => [...[...h].map(c => c.charCodeAt(0) >> 5), 0, ...[...h].map(c => c.charCodeAt(0) & 31)];
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = [], maxv = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); } }
  if (pad && bits) out.push((acc << (to - bits)) & maxv);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & maxv))) return null;
  return out;
}
function segwitEncode(hrp, version, program) {
  const data = [version, ...convertBits(program, 8, 5, true)];
  const c = version === 0 ? 1 : 0x2bc830a3;
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ c;
  const chk = [0, 1, 2, 3, 4, 5].map(i => (pm >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...chk].map(d => CHARSET[d]).join('');
}
function segwitDecode(addr) {
  const a = String(addr).toLowerCase(), pos = a.lastIndexOf('1');
  if (pos < 1) return null;
  const hrp = a.slice(0, pos), data = [...a.slice(pos + 1)].map(c => CHARSET.indexOf(c));
  if (data.length < 7 || data.some(d => d < 0)) return null;
  const version = data[0], pm = polymod([...hrpExpand(hrp), ...data]);
  if (pm !== (version === 0 ? 1 : 0x2bc830a3)) return null;
  const program = convertBits(data.slice(1, -6), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) return null;
  return { hrp, version, program: Buffer.from(program) };
}

/* ---------- networks ---------- */
const NETWORKS = {
  mainnet: { hrp: 'bc', esplora: 'https://mempool.space/api' },
  testnet4: { hrp: 'tb', esplora: 'https://mempool.space/testnet4/api' },
  signet: { hrp: 'tb', esplora: 'https://mempool.space/signet/api' },
  regtest: { hrp: 'bcrt', esplora: '' },
};

/* ---------- taproot ---------- */
// BIP341 "nothing up my sleeve" internal key used by LEAF and BONS: no key-path spend is possible.
const NUMS = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
const LEAF_VERSION = 0xc0;

const tapLeafHash = script => taggedHash('TapLeaf', Buffer.concat([Buffer.from([LEAF_VERSION]), compactSize(script.length), script]));

// The Taproot output key of a wallet key used on its own (key path, no script tree), as bc1p wallets do
function keyPathOutput(internalKeyHex, network = 'mainnet') {
  const pk = Buffer.from(internalKeyHex, 'hex'), t = toBig(taggedHash('TapTweak', pk));
  if (t >= N) throw new Error('bad tweak');
  const Q = add(liftX(toBig(pk)), mul(t)), outputKey = big32(Q[0]);
  return { outputKey: hex(outputKey), scriptPubKey: '5120' + hex(outputKey), address: segwitEncode(NETWORKS[network].hrp, 1, outputKey) };
}
// P2TR output for an internal key and a single-leaf script tree
function taprootSingleLeaf(internalKeyHex, script, network = 'mainnet') {
  const pk = Buffer.from(internalKeyHex, 'hex'), leaf = tapLeafHash(script);
  const t = toBig(taggedHash('TapTweak', Buffer.concat([pk, leaf])));
  if (t >= N) throw new Error('bad tweak');
  const Q = add(liftX(toBig(pk)), mul(t));
  const outputKey = big32(Q[0]);
  return {
    outputKey: hex(outputKey),
    scriptPubKey: '5120' + hex(outputKey),
    address: segwitEncode(NETWORKS[network].hrp, 1, outputKey),
    leafHash: hex(leaf),
    controlBlock: hex(Buffer.concat([Buffer.from([LEAF_VERSION | Number(Q[1] & 1n)]), pk])),
    script: hex(script),
  };
}

// Covenant leaf script: <token const> OP_DROP [<csv> OP_CSV OP_DROP] <owner x-only> OP_CHECKSIG
function covenantScript(tokenConstHex, ownerXonlyHex, csv = 0) {
  const c = Buffer.from(tokenConstHex, 'hex'), k = Buffer.from(ownerXonlyHex, 'hex');
  if (c.length !== 32 || k.length !== 32) throw new Error('need 32-byte constant and x-only key');
  const parts = [Buffer.from([0x20]), c, Buffer.from([0x75])];
  if (csv) parts.push(pushNumber(csv), Buffer.from([0xb2, 0x75]));
  parts.push(Buffer.from([0x20]), k, Buffer.from([0xac]));
  return Buffer.concat(parts);
}
function pushNumber(n) { // minimal script number push
  if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]);
  const bytes = []; let v = n; while (v) { bytes.push(v & 0xff); v >>= 8; }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return Buffer.from([bytes.length, ...bytes]);
}
const covenantAddress = (tokenConstHex, ownerXonlyHex, network = 'mainnet', csv = 0) =>
  taprootSingleLeaf(NUMS, covenantScript(tokenConstHex, ownerXonlyHex, csv), network);

// SEAL v1 covenant: a Taproot output with no key path (NUMS) and two leaves
//   cosign  <SEAL const> OP_DROP <owner> OP_CHECKSIGVERIFY <platform> OP_CHECKSIG      every trade: owner and marketplace sign
//   escape  <SEAL const> OP_DROP <ESCAPE_BLOCKS> OP_CSV OP_DROP <owner> OP_CHECKSIG     the owner alone, once the seal has not moved for ESCAPE_BLOCKS
// The marketplace can never move a seal on its own; the owner never depends on the marketplace for longer than ESCAPE_BLOCKS.
const ESCAPE_BLOCKS = 4320; // about 30 days
const tapBranch = (a, b) => taggedHash('TapBranch', Buffer.compare(a, b) <= 0 ? Buffer.concat([a, b]) : Buffer.concat([b, a]));
function sealCovenant(tokenConstHex, ownerXonlyHex, platformXonlyHex, network = 'mainnet', csv = ESCAPE_BLOCKS) {
  const c = Buffer.from(tokenConstHex, 'hex'), o = Buffer.from(ownerXonlyHex, 'hex'), p = Buffer.from(platformXonlyHex, 'hex');
  if (c.length !== 32 || o.length !== 32 || p.length !== 32) throw new Error('need 32-byte constant and x-only keys');
  const head = Buffer.concat([Buffer.from([0x20]), c, Buffer.from([0x75])]);
  const cosign = Buffer.concat([head, Buffer.from([0x20]), o, Buffer.from([0xad, 0x20]), p, Buffer.from([0xac])]);
  const escape = Buffer.concat([head, pushNumber(csv), Buffer.from([0xb2, 0x75, 0x20]), o, Buffer.from([0xac])]);
  const hc = tapLeafHash(cosign), he = tapLeafHash(escape), root = tapBranch(hc, he), internal = Buffer.from(NUMS, 'hex');
  const t = toBig(taggedHash('TapTweak', Buffer.concat([internal, root])));
  if (t >= N) throw new Error('bad tweak');
  const Q = add(liftX(toBig(internal)), mul(t)), outputKey = big32(Q[0]), first = Buffer.from([LEAF_VERSION | Number(Q[1] & 1n)]);
  return {
    address: segwitEncode(NETWORKS[network].hrp, 1, outputKey), scriptPubKey: '5120' + hex(outputKey), outputKey: hex(outputKey), csv,
    cosign: { script: hex(cosign), leafHash: hex(hc), controlBlock: hex(Buffer.concat([first, internal, he])) },
    escape: { script: hex(escape), leafHash: hex(he), controlBlock: hex(Buffer.concat([first, internal, hc])) },
  };
}

// x-only key from a wallet public key (33-byte compressed or 32-byte x-only hex)
function xonly(pubkeyHex) {
  const b = Buffer.from(String(pubkeyHex || ''), 'hex');
  if (b.length === 32) return hex(b);
  if (b.length === 33 && (b[0] === 2 || b[0] === 3)) return hex(b.subarray(1));
  throw new Error('invalid public key');
}

/* ---------- OP_RETURN markers ---------- */
// Concatenate every data push of an OP_RETURN script (hex), or null if it is not one.
function opReturnData(scriptHex) {
  try { return opReturnDataUnsafe(scriptHex); } catch { return null; } // truncated pushes: not a marker
}
function opReturnDataUnsafe(scriptHex) {
  const s = Buffer.from(scriptHex || '', 'hex');
  if (s[0] !== 0x6a) return null;
  const out = [];
  for (let i = 1; i < s.length;) {
    const op = s[i++]; let len;
    if (op >= 1 && op <= 75) len = op;
    else if (op === 0x4c) len = s[i++];
    else if (op === 0x4d) { len = s.readUInt16LE(i); i += 2; }
    else if (op === 0x4e) { len = s.readUInt32LE(i); i += 4; }
    else continue; // OP_0 / small ints carry no bytes we care about
    if (i + len > s.length) return null;
    out.push(s.subarray(i, i + len)); i += len;
  }
  return Buffer.concat(out);
}
// CRC-20 JSON marker of an output, or null
function crc20Marker(scriptHex) {
  const d = opReturnData(scriptHex);
  if (!d || d[0] !== 0x7b) return null; // must start with '{'
  try {
    const j = JSON.parse(d.toString('utf8'));
    if (!j || typeof j !== 'object' || String(j.p).toLowerCase() !== 'crc-20' || typeof j.op !== 'string' || typeof j.tick !== 'string') return null;
    return j;
  } catch { return null; }
}

module.exports = {
  NETWORKS, NUMS, ESCAPE_BLOCKS, sealCovenant, tapBranch, sha256, taggedHash, tapLeafHash, taprootSingleLeaf, keyPathOutput, covenantScript, covenantAddress, xonly,
  segwitEncode, segwitDecode, opReturnData, crc20Marker, liftX, mul, hex,
};
