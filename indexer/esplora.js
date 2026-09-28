// Esplora (blockstream.info, mempool.space or your own) client: the chain data the indexer reads.
// Throttled, retries on 429 and network errors. Several servers can be given (comma separated): when one limits us
// or does not answer, the next one takes over.
function esplora(bases, { concurrency = 4, timeout = 15000 } = {}) {
  const list = String(bases).split(',').map(b => b.trim().replace(/\/$/, '')).filter(Boolean);
  let cur = 0; // the server in use; moves on when it limits us
  const base = list[0];
  const busy = e => e.retry || e.name === 'TimeoutError' || e.cause;
  let active = 0; const queue = [];
  const slot = () => new Promise(r => { if (active < concurrency) { active++; r(); } else queue.push(r); });
  const release = () => { const next = queue.shift(); next ? next() : active--; };

  async function get(path, as = 'json') {
    await slot();
    try {
      for (let attempt = 0; ; attempt++) {
        const i = cur;
        try {
          const r = await fetch(list[i] + path, { signal: AbortSignal.timeout(timeout) });
          if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`esplora ${r.status} ${path}`), { retry: true });
          if (!r.ok) throw new Error(`esplora ${r.status} ${path}`);
          return as === 'json' ? await r.json() : (await r.text()).trim();
        } catch (e) {
          if (!busy(e) || attempt >= 4 + list.length) throw e;
          if (list.length > 1 && cur === i) cur = (i + 1) % list.length; // this server limits us: the next one
          await new Promise(r => setTimeout(r, Math.min(4000, 300 * 2 ** attempt)));
        }
      }
    } finally { release(); }
  }

  return {
    base,
    kind: 'esplora',
    // spendable coins of an address, mempool included
    utxos: async addr => (await get(`/address/${addr}/utxo`)).map(u => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!(u.status && u.status.confirmed) })),
    // sat/vB for confirmation within about half an hour (mempool.space), or the 3-block estimate (plain Esplora)
    // next block, at least 3 sat/vB: a mint slot is reused only once its mint confirms, so slow mints slow everyone
    feeRate: async () => { try { const f = await get('/v1/fees/recommended'); return Math.max(3, f.fastestFee || f.halfHourFee || 3); } catch { const e = await get('/fee-estimates'); return Math.max(3, Math.ceil(e['1'] || e['2'] || e['3'] || 3)); } },
    // a 4xx answer means the node looked at the transaction and refused it (refused: true): it did not go out.
    // Anything else (timeout, 5xx) leaves it unknown: it may have reached the network.
    broadcast: async hex => {
      let last;
      for (let k = 0; k < list.length; k++) {
        const i = (cur + k) % list.length;
        try {
          const r = await fetch(list[i] + '/tx', { method: 'POST', body: hex, signal: AbortSignal.timeout(timeout) }); const t = (await r.text()).trim();
          if (r.ok) return t;
          if (r.status !== 429 && r.status < 500) throw Object.assign(new Error(t || 'broadcast failed'), { refused: true });
          last = new Error(`${r.status} ${t}`.trim());
        } catch (e) { if (e.refused) throw e; last = e; }
      }
      throw Object.assign(last || new Error('broadcast failed'), { refused: false });
    },
    outspend: (txid, vout) => get(`/tx/${txid}/outspend/${vout}`),
    // the whole transaction, not /status: /status answers {confirmed:false} even for a transaction nobody has seen
    txStatus: async txid => { try { const s = (await get(`/tx/${txid}`)).status || {}; return { found: true, confirmed: !!s.confirmed, height: s.block_height }; } catch (e) { if (/404/.test(e.message)) return { found: false }; throw e; } },
    tipHeight: async () => +(await get('/blocks/tip/height', 'text')),
    blockHash: height => get(`/block-height/${height}`, 'text'),
    blockTxids: hash => get(`/block/${hash}/txids`),
    tx: txid => get(`/tx/${txid}`),
    outspends: txid => get(`/tx/${txid}/outspends`),
    // confirmed history of an address, newest first, 25 per page
    addressTxs: (addr, afterTxid) => get(`/address/${addr}/txs/chain${afterTxid ? '/' + afterTxid : ''}`),
  };
}
module.exports = { esplora };
