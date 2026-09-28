// ⌈seal⌉ indexer: follows the chain through an Esplora API and computes who owns each seal.
// Rules (docs/crc20-protocol.md, "SEAL v1"):
//  - mint: a tx that spends an output of the mint authority address and carries {"p":"crc-20","op":"mint","tick":"SEAL","n":N}.
//    Outputs marker + 1 … marker + N each receive a seal; which one is drawn from the confirming block:
//    k-th draw = SHA256("<block hash>:<txid>:<k>") mod (number of ids not minted yet), taken from those ids in ascending order.
//    Nobody, the marketplace included, knows which seals a mint gets before its block exists.
//  - transfer: a tx that spends outputs holding seals and carries {"p":"crc-20","op":"transfer","tick":"SEAL"}:
//    the k-th seal spent (by input order, then id) moves to the output at marker index + 1 + k.
//    With an explicit "ids" list, ids[k] moves to marker index + 1 + k instead.
//  - a seal spent without a transfer marker moves to the first non-OP_RETURN output.
//  - a seal sent to an OP_RETURN, a missing output or an output under 330 sats is burned.
// State is rebuilt from scratch on a reorg, a network change or a new mint authority; the previous state stays
// in place (and is served) until the rebuilt one is complete.
const crypto = require('crypto');
const { crc20Marker } = require('./btc');

const MIN_SEAL = 330;
const isInt = v => Number.isInteger(v);
const idsOf = m => (Array.isArray(m.ids) ? m.ids : 'id' in m ? [m.id] : []).map(v => (typeof v === 'string' && /^\d+$/.test(v) ? +v : v));
const MAX_MINT = 100;
const fresh = key => ({ v: 2, key, tip: null, items: {}, burned: {}, events: [], processed: {}, authSeen: {} });

class SealIndexer {
  constructor({ source, network, authority, tick = 'SEAL', supply = 1500, confirmations = 1, state, persist, log = () => {} }) {
    Object.assign(this, { source, network, authority, tick: tick.toUpperCase(), supply, confirmations, persist, log });
    this.key = `v2:${network}:${authority}:${this.tick}:${supply}`;
    this.state = state && state.key === this.key ? state : fresh(this.key);
    this.syncing = null; this.lastSync = 0; this.lastOk = 0; this.lastError = null; this.timer = null; this.rebuilding = false;
  }

  /* ---------- queries ---------- */
  status() {
    const items = Object.values(this.state.items);
    return {
      network: this.network, authority: this.authority, tick: this.tick, supply: this.supply,
      height: this.state.tip && this.state.tip.height, minted: items.length + Object.keys(this.state.burned).length,
      live: items.length, burned: Object.keys(this.state.burned).length, holders: new Set(items.map(i => i.owner)).size,
      events: this.state.events.length, lastSync: this.lastSync, lastOk: this.lastOk, lastError: this.lastError, syncing: !!this.syncing, rebuilding: this.rebuilding,
    };
  }
  item(id) {
    const it = this.state.items[id];
    const history = this.state.events.filter(e => e.id === +id);
    if (!it && !history.length) return null;
    return { id: +id, ...(it || {}), burned: !!this.state.burned[id], history };
  }
  ownerOf(id) { const it = this.state.items[id]; return it ? it.owner : null; }
  // ids held by any of these addresses (wallet address and/or covenant address)
  idsOwnedBy(addresses) {
    const set = new Set(addresses.filter(Boolean).map(a => a.toLowerCase()));
    return Object.values(this.state.items).filter(i => i.owner && set.has(i.owner.toLowerCase())).map(i => i.id).sort((a, b) => a - b);
  }
  owners() { const o = {}; for (const i of Object.values(this.state.items)) if (i.owner) o[i.id] = i.owner; return o; }

  /* ---------- loop ---------- */
  start(ms = 60000) {
    const tick = () => this.sync().catch(() => {}).finally(() => { this.timer = setTimeout(tick, ms); });
    tick();
  }
  stop() { clearTimeout(this.timer); }
  // start again from the first block; the current state is kept (and served) until the new one is complete
  async rebuild() {
    if (this.syncing) await this.syncing.catch(() => {});
    return this.sync(true);
  }
  // true when the state can be trusted for decisions (a recent successful pass, no rebuild running)
  healthy(maxAgeMs = 10 * 60000) { return !!this.state.tip && !this.rebuilding && !this.lastError && Date.now() - this.lastOk < maxAgeMs; }

  sync(fromScratch = false) {
    if (!this.syncing) this.syncing = this._sync(fromScratch ? fresh(this.key) : this.state).then(r => { this.lastError = null; this.lastOk = Date.now(); return r; }, e => { this.lastError = e.message; this.log('sync failed: ' + e.message); throw e; })
      .finally(() => { this.syncing = null; this.rebuilding = false; this.lastSync = Date.now(); });
    return this.syncing;
  }

  async _sync(base) {
    this.w = structuredClone(base); // work on a copy, commit only when the whole pass succeeded
    const src = this.source, st = this.w;
    if (!st.tip) this.rebuilding = base !== this.state || !!this.state.tip;
    const safe = (await src.tipHeight()) - this.confirmations + 1;
    if (st.tip) {
      if ((await src.blockHash(st.tip.height).catch(() => null)) !== st.tip.hash) {
        this.log(`reorg at ${st.tip.height}, rebuilding`);
        this.rebuilding = true;
        return this._sync(fresh(this.key));
      }
      if (safe <= st.tip.height) return { changed: 0 };
    }
    if (safe < 0) return { changed: 0 };
    const before = st.events.length, blockOrder = new Map();

    // 1. new confirmed transactions of the mint authority (newest first, stop at the first one already seen)
    const pending = new Map();
    for (let after = null; ;) {
      const page = await src.addressTxs(this.authority, after);
      let stop = !page.length;
      for (const tx of page) {
        if (st.authSeen[tx.txid]) { stop = true; break; }
        if (tx.status && tx.status.confirmed && tx.status.block_height <= safe) { pending.set(tx.txid, tx); st.authSeen[tx.txid] = 1; }
      }
      if (stop || page.length < 25) break;
      after = page[page.length - 1].txid;
    }

    // 2. apply strictly in chain order (height, then position in the block). A transaction is applied once, with all
    //    its inputs: every earlier transaction touching a seal is already applied when its turn comes, because it spends
    //    an output created earlier still (or is a mint, all queued above). After each one, queue whoever spent its seals.
    const follow = async txid => {
      const outs = await src.outspends(txid);
      for (const it of Object.values(st.items)) {
        if (it.txid !== txid) continue;
        const o = outs[it.vout];
        if (!o || !o.spent || !o.status || !o.status.confirmed || o.status.block_height > safe) continue;
        if (st.processed[o.txid] == null && !pending.has(o.txid)) pending.set(o.txid, await src.tx(o.txid));
      }
    };
    await Promise.all([...new Set(Object.values(st.items).map(it => it.txid))].map(follow));
    while (pending.size) {
      const tx = await this._first([...pending.values()], blockOrder);
      pending.delete(tx.txid);
      if (st.processed[tx.txid] != null) continue;
      this._apply(tx);
      await follow(tx.txid);
    }

    st.tip = { height: safe, hash: await src.blockHash(safe) };
    const changed = st.events.length - before;
    this.state = st;
    if (this.persist) await this.persist(st);
    if (changed) this.log(`indexed ${changed} event(s) up to block ${safe}`);
    return { changed, height: safe };
  }

  // the earliest of these transactions: lowest height, then position inside the block
  async _first(txs, cache) {
    const h = Math.min(...txs.map(t => t.status.block_height)), same = txs.filter(t => t.status.block_height === h);
    if (same.length === 1) return same[0];
    const hash = same[0].status.block_hash;
    if (!cache.has(hash)) cache.set(hash, new Map((await this.source.blockTxids(hash)).map((id, i) => [id, i])));
    const pos = cache.get(hash);
    return same.sort((a, b) => pos.get(a.txid) - pos.get(b.txid))[0];
  }

  _markers(tx, op) {
    const out = [];
    tx.vout.forEach((o, index) => {
      const m = crc20Marker(o.scriptpubkey);
      if (m && m.op === op && m.tick.toUpperCase() === this.tick) out.push({ index, ids: idsOf(m), n: m.n, explicit: Array.isArray(m.ids) || 'id' in m });
    });
    return out;
  }

  _event(kind, tx, id, from, to, vout) {
    this.w.events.push({ kind, id, txid: tx.txid, vout, from, to, height: tx.status.block_height, time: tx.status.block_time });
  }

  _place(tx, id, vout, from, kind) {
    const o = tx.vout[vout];
    if (!o || o.scriptpubkey_type === 'op_return' || o.value < MIN_SEAL) {
      delete this.w.items[id]; this.w.burned[id] = 1;
      this._event('burn', tx, id, from, null, vout);
      return;
    }
    const owner = o.scriptpubkey_address || null;
    const prev = this.w.items[id];
    this.w.items[id] = { id, txid: tx.txid, vout, value: o.value, owner, height: tx.status.block_height,
      mintTxid: prev ? prev.mintTxid : tx.txid, mintHeight: prev ? prev.mintHeight : tx.status.block_height };
    this._event(kind, tx, id, from, owner, vout);
  }

  _apply(tx) {
    if (this.w.processed[tx.txid] != null) return;
    this.w.processed[tx.txid] = tx.status.block_height;
    this._applyTransfers(tx);
    this._applyMints(tx);
  }

  // seals spent by this tx
  _applyTransfers(tx) {
    const at = new Map();
    for (const it of Object.values(this.w.items)) (at.get(it.txid + ':' + it.vout) || at.set(it.txid + ':' + it.vout, []).get(it.txid + ':' + it.vout)).push(it);
    const spent = tx.vin.flatMap(v => at.get(v.txid + ':' + v.vout) || []);
    if (!spent.length) return;
    const markers = this._markers(tx, 'transfer'), implicit = markers.find(m => !m.explicit);
    spent.forEach((it, k) => {
      let dest = -1;
      for (const m of markers) { const j = m.ids.indexOf(it.id); if (m.explicit && j >= 0) { dest = m.index + 1 + j; break; } }
      if (dest < 0 && implicit) dest = implicit.index + 1 + k;
      if (dest < 0) dest = tx.vout.findIndex(o => o.scriptpubkey_type !== 'op_return');
      this._place(tx, it.id, dest, it.owner, 'transfer');
    });
  }

  _applyMints(tx) {
    if (!tx.vin.some(v => v.prevout && v.prevout.scriptpubkey_address === this.authority)) return;
    const m = this._markers(tx, 'mint')[0];
    if (!m || !isInt(m.n) || m.n < 1 || m.n > MAX_MINT) return;
    const free = [];
    for (let id = 1; id <= this.supply; id++) if (!this.w.items[id] && !this.w.burned[id]) free.push(id);
    for (let k = 0; k < m.n && free.length; k++) {
      const o = tx.vout[m.index + 1 + k];
      if (!o || o.scriptpubkey_type === 'op_return' || o.value < MIN_SEAL) continue; // invalid output: no seal, nothing drawn
      const id = free.splice(drawIndex(tx.status.block_hash, tx.txid, k, free.length), 1)[0];
      this._place(tx, id, m.index + 1 + k, null, 'mint');
    }
  }
}

// which of the free ids the k-th seal of a mint gets (see the rules above)
function drawIndex(blockHash, txid, k, count) {
  const h = crypto.createHash('sha256').update(`${blockHash}:${txid}:${k}`).digest('hex');
  return Number(BigInt('0x' + h) % BigInt(count));
}

module.exports = { SealIndexer, MIN_SEAL, MAX_MINT, drawIndex };
