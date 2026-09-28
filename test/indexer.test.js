// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { SealIndexer } = require('../indexer/indexer');

// A tiny in-memory chain that answers the same calls as the Esplora client.
function mockChain() {
  const blocks = [], txs = new Map();
  const opret = json => ({ scriptpubkey: '6a4c' + Buffer.from(JSON.stringify(json)).length.toString(16).padStart(2, '0') + Buffer.from(JSON.stringify(json)).toString('hex'), scriptpubkey_type: 'op_return', value: 0 });
  const out = (addr, value = 330) => ({ scriptpubkey: '5120' + '00'.repeat(32), scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: addr, value });
  let n = 0;
  const chain = {
    opret, out,
    block(list) {
      const height = blocks.length, hash = 'h' + height + '_' + (++n);
      blocks.push({ hash, txids: [] });
      for (const t of list) {
        const txid = 'tx' + (++n);
        const tx = { txid, vin: t.vin.map(([ptxid, vout, addr]) => ({ txid: ptxid, vout, prevout: { scriptpubkey_address: addr } })), vout: t.vout,
          status: { confirmed: true, block_height: height, block_hash: hash, block_time: 1000 + height } };
        txs.set(txid, tx); blocks[height].txids.push(txid);
      }
      return blocks[height].txids;
    },
    reorgFrom(height) { for (const b of blocks.splice(height)) for (const id of b.txids) txs.delete(id); },
    source: {
      tipHeight: async () => blocks.length - 1,
      blockHash: async h => { if (!blocks[h]) throw new Error('no block'); return blocks[h].hash; },
      blockTxids: async hash => blocks.find(b => b.hash === hash).txids,
      tx: async id => txs.get(id),
      outspends: async id => txs.get(id).vout.map((_, i) => {
        for (const t of txs.values()) if (t.vin.some(v => v.txid === id && v.vout === i)) return { spent: true, txid: t.txid, status: t.status };
        return { spent: false };
      }),
      addressTxs: async (addr, after) => {
        const all = [...txs.values()].filter(t => t.vin.some(v => v.prevout.scriptpubkey_address === addr) || t.vout.some(o => o.scriptpubkey_address === addr))
          .sort((a, b) => b.status.block_height - a.status.block_height);
        const start = after ? all.findIndex(t => t.txid === after) + 1 : 0;
        return all.slice(start, start + 25);
      },
    },
  };
  return chain;
}

const AUTH = 'tb1pauthority', ALICE = 'tb1palice', BOB = 'tb1pbob', MALLORY = 'tb1pmallory';
const { drawIndex } = require('../indexer/indexer');
const mintMarker = n => ({ p: 'crc-20', op: 'mint', tick: 'SEAL', n });
const xferMarker = ids => (ids ? { p: 'crc-20', op: 'transfer', tick: 'SEAL', ids } : { p: 'crc-20', op: 'transfer', tick: 'SEAL' });
const make = (c, supply = 1500) => new SealIndexer({ source: c.source, network: 'test', authority: AUTH, supply });
// the ids a mint should get, computed from the rule itself (free ids ascending, SHA256("<block>:<txid>:<k>") mod count)
async function expectedDraw(c, txid, n, taken, supply = 1500, skip = []) {
  const tx = await c.source.tx(txid), free = [];
  for (let id = 1; id <= supply; id++) if (!taken.includes(id)) free.push(id);
  const out = [];
  for (let k = 0; k < n && free.length; k++) { if (skip.includes(k)) continue; out.push(free.splice(drawIndex(tx.status.block_hash, txid, k, free.length), 1)[0]); }
  return out;
}

test('draw rule: fixed vector (docs/crc20-protocol.md)', () => {
  assert.strictEqual(drawIndex('0'.repeat(64), '1'.repeat(64), 0, 1500), 771);
  assert.strictEqual(drawIndex('0'.repeat(64), '1'.repeat(64), 1, 1499), 347);
});

test('mints: ids drawn from the block, authority required, bad outputs skipped', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['coinbase', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  const [m1] = c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(2)), c.out(ALICE), c.out(ALICE), c.out(AUTH, 90000)] }]);
  // no authority input: ignored
  c.block([{ vin: [['other', 0, MALLORY]], vout: [c.opret(mintMarker(1)), c.out(MALLORY)] }]);
  const ix = make(c);
  await ix.sync();
  const got = ix.idsOwnedBy([ALICE]), want = await expectedDraw(c, m1, 2, []);
  assert.deepStrictEqual(got, [...want].sort((a, b) => a - b));
  assert.strictEqual(ix.idsOwnedBy([MALLORY]).length, 0);
  assert.strictEqual(ix.status().minted, 2);
  // second mint: output 1 is under 330 sats (no seal, no draw), outputs 0 and 2 get seals; n above the cap is ignored
  const [m2] = c.block([{ vin: [[m1, 3, AUTH]], vout: [c.opret(mintMarker(3)), c.out(BOB), c.out(BOB, 200), c.out(BOB), c.out(AUTH, 80000)] }]);
  c.block([{ vin: [[m2, 4, AUTH]], vout: [c.opret(mintMarker(101)), c.out(BOB), c.out(AUTH, 70000)] }]);
  await ix.sync();
  const want2 = await expectedDraw(c, m2, 3, want, 1500, [1]);
  assert.deepStrictEqual(ix.idsOwnedBy([BOB]), [...want2].sort((a, b) => a - b));
  assert.strictEqual(ix.status().minted, 4);
  for (const id of want2) assert.ok([1, 3].includes(ix.item(id).vout));
});

test('supply runs out: the extra outputs get nothing', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(5)), c.out(ALICE), c.out(ALICE), c.out(ALICE), c.out(ALICE), c.out(ALICE)] }]);
  const ix = make(c, 3);
  await ix.sync();
  assert.deepStrictEqual(ix.idsOwnedBy([ALICE]), [1, 2, 3]);
  assert.strictEqual(ix.status().minted, 3);
});

test('transfers: implicit order, explicit ids, no marker, burn', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  const [m] = c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(3)), c.out(ALICE), c.out(ALICE), c.out(ALICE)] }]);
  const ix = make(c);
  await ix.sync();
  const at = v => Object.values(ix.state.items).find(i => i.txid === m && i.vout === v).id;
  const [s1, s2, s3] = [at(1), at(2), at(3)];
  // implicit: the k-th seal spent (input order) goes to marker + 1 + k
  const [t1] = c.block([{ vin: [[m, 2, ALICE], [m, 1, ALICE]], vout: [c.out(ALICE, 5000), c.opret(xferMarker()), c.out(BOB), c.out(MALLORY)] }]);
  await ix.sync();
  assert.strictEqual(ix.ownerOf(s2), BOB);
  assert.strictEqual(ix.ownerOf(s1), MALLORY);
  assert.strictEqual(ix.item(s2).txid, t1);
  // explicit ids still work; a seal spent with no marker goes to the first non-OP_RETURN output
  const [t2] = c.block([{ vin: [[t1, 2, BOB], [m, 3, ALICE]], vout: [c.out(ALICE, 700), c.opret(xferMarker([s2])), c.out(MALLORY)] }]);
  await ix.sync();
  assert.strictEqual(ix.ownerOf(s2), MALLORY);
  assert.strictEqual(ix.ownerOf(s3), ALICE);
  assert.strictEqual(ix.item(s3).txid, t2);
  // sent into an OP_RETURN slot: burned for good
  c.block([{ vin: [[t2, 2, MALLORY]], vout: [c.opret(xferMarker()), c.opret({ note: 'x' })] }]);
  await ix.sync();
  assert.strictEqual(ix.ownerOf(s2), null);
  assert.ok(ix.item(s2).burned);
  assert.deepStrictEqual(ix.item(s2).history.map(e => e.kind), ['mint', 'transfer', 'transfer', 'burn']);
  assert.strictEqual(ix.status().minted, 3);
});

test('mint and transfers in the same sync window', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  const [m] = c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(1)), c.out(ALICE)] }]);
  const [a] = c.block([{ vin: [[m, 1, ALICE]], vout: [c.opret(xferMarker()), c.out(BOB)] }]);
  c.block([{ vin: [[a, 1, BOB]], vout: [c.opret(xferMarker()), c.out(MALLORY)] }]);
  const ix = make(c);
  await ix.sync();
  const [id] = ix.idsOwnedBy([MALLORY]);
  assert.deepStrictEqual(ix.item(id).history.map(e => e.to), [ALICE, BOB, MALLORY]);
});

test('reorg: rebuilt aside, the old state is served until the new one is complete', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  const [m] = c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(1)), c.out(ALICE)] }]);
  c.block([{ vin: [[m, 1, ALICE]], vout: [c.opret(xferMarker()), c.out(BOB)] }]);
  const ix = make(c);
  await ix.sync();
  const [id] = ix.idsOwnedBy([BOB]);
  assert.ok(ix.healthy());
  c.reorgFrom(2);
  c.block([{ vin: [['cb2', 0, 'x']], vout: [c.out('tb1pmoney', 1000)] }]);
  c.block([]);
  // while the rebuild runs, readers still see the previous state and nobody trusts it for decisions
  const seen = [], orig = c.source.addressTxs;
  c.source.addressTxs = async (...a) => { seen.push({ bob: ix.idsOwnedBy([BOB]).length, healthy: ix.healthy() }); return orig(...a); };
  await ix.sync();
  assert.ok(seen.length && seen.every(s => s.bob === 1 && s.healthy === false));
  assert.strictEqual(ix.ownerOf(id), ALICE);
  assert.ok(ix.healthy());
});

test('a failed pass leaves the state untouched and marks it unhealthy', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(1)), c.out(ALICE)] }]);
  const ix = make(c);
  await ix.sync();
  c.block([]);
  const orig = c.source.addressTxs;
  c.source.addressTxs = async () => { throw new Error('network down'); };
  await assert.rejects(ix.sync());
  assert.strictEqual(ix.idsOwnedBy([ALICE]).length, 1);
  assert.ok(!ix.healthy());
  c.source.addressTxs = orig;
  await ix.sync();
  assert.ok(ix.healthy());
});

test('state survives a restart', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(1)), c.out(ALICE)] }]);
  let saved = null;
  const ix = new SealIndexer({ source: c.source, network: 'test', authority: AUTH, persist: s => { saved = JSON.parse(JSON.stringify(s)); } });
  await ix.sync();
  const [id] = ix.idsOwnedBy([ALICE]);
  const again = new SealIndexer({ source: c.source, network: 'test', authority: AUTH, state: saved });
  assert.strictEqual(again.ownerOf(id), ALICE);
  const other = new SealIndexer({ source: c.source, network: 'test', authority: 'tb1pnewauth', state: saved });
  assert.strictEqual(other.ownerOf(id), null); // different authority: fresh state
});

test('one pass and block by block give the same owners (seals with different histories in one transaction)', async () => {
  const build = () => {
    const c = mockChain();
    const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
    const [m] = c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(2)), c.out(ALICE), c.out(ALICE)] }]);
    const [h1] = c.block([{ vin: [[m, 2, ALICE]], vout: [c.opret(xferMarker()), c.out(ALICE)] }]);
    const [h2] = c.block([{ vin: [[h1, 1, ALICE]], vout: [c.opret(xferMarker()), c.out(ALICE)] }]);
    return { c, m, h2 };
  };
  const finish = ({ c, m, h2 }) => c.block([{ vin: [[h2, 1, ALICE], [m, 1, ALICE]], vout: [c.opret(xferMarker()), c.out(BOB), c.out(MALLORY)] }]);
  const a = build(), stepwise = make(a.c);
  await stepwise.sync(); finish(a); await stepwise.sync();
  const b = build(); finish(b);
  const onePass = make(b.c); await onePass.sync();
  for (const ix of [stepwise, onePass]) {
    assert.strictEqual(ix.idsOwnedBy([BOB]).length, 1);
    assert.strictEqual(ix.idsOwnedBy([MALLORY]).length, 1);
  }
  // the seal with the longer history (minted at output 2) is the first input, so it goes to Bob in both
  const second = x => Object.values(x.state.items).find(i => i.mintTxid && x.item(i.id).history[0].vout === 2).id;
  assert.strictEqual(stepwise.ownerOf(second(stepwise)), BOB);
  assert.strictEqual(onePass.ownerOf(second(onePass)), BOB);
});

test('a malformed OP_RETURN does not stop the indexer', async () => {
  const c = mockChain();
  const [fund] = c.block([{ vin: [['cb', 0, 'x']], vout: [c.out(AUTH, 100000)] }]);
  const [m] = c.block([{ vin: [[fund, 0, AUTH]], vout: [c.opret(mintMarker(1)), c.out(ALICE)] }]);
  c.block([{ vin: [[m, 1, ALICE]], vout: [{ scriptpubkey: '6a4d01', scriptpubkey_type: 'op_return', value: 0 }, c.out(BOB)] }]);
  const ix = make(c);
  await ix.sync();
  assert.strictEqual(ix.idsOwnedBy([BOB]).length, 1);
  assert.ok(ix.healthy());
});
