# SEAL v1: collectibles on CRC-20

CRC-20 carries amounts: it has no notion of a unique item. SEAL v1 keeps its construction (a 330-sat output at a Taproot covenant, a JSON marker in an `OP_RETURN`) and adds ids, a fair draw, a marketplace-safe covenant and an on-chain collection deploy. ⌈seal⌉ is its first collection: 1,500 seals, live on Bitcoin mainnet.

These rules are implemented by [`indexer/indexer.js`](../indexer/indexer.js) and tested in [`test/indexer.test.js`](../test/indexer.test.js). The whole flow (mint, list, buy, sweep, offers, sends, holder payouts) was proven end to end on Bitcoin Core before launch.

## At a glance

- **Art on Bitcoin.** The generator is the collection's parent inscription. Every seal is drawn from the chain alone.
- **Fair draw.** Which seals a mint gets is decided by the block that confirms it. Nobody can snipe a rare one.
- **Your key.** A seal never moves without its owner's signature, and its owner can always move it alone after 30 days.
- **Open ownership.** Anyone can recompute every owner from Bitcoin with the indexer in this repository.

## Constants

- Tick `SEAL`, supply 1,500, ids 1 to 1500.
- `SEAL_CONST = taggedHash("crc-20", "SEAL")` = `4d05e30c65d2dabf4cc2fbc2cff8c3b7010888a0de2d7128719006cbe46d7cf2`.
- **Mint authority**: `bc1pk3vsmhdmzct6rj9ls7lnfg0yreqe0c9h4sqjl6n9te2kt5tqjnmss62j3h`, a key used only for mints. Only transactions that spend one of its outputs can mint. Its public key is also the **marketplace key** of every covenant.
- `ESCAPE_BLOCKS = 4320` (about 30 days).

## The collection: parent inscription and `crc-21` deploy

A collection of unique items declares itself once, with a `crc-21` marker, so that token indexers never read it as a token:

```
{"p":"crc-21","op":"deploy","type":"ord"}
```

- The marker sits in an `OP_RETURN` of the **reveal transaction of the collection's parent inscription**. The inscription created by that transaction (`<txid>i0`) is the parent, and holds the collection's identity and metadata.
- The ⌈seal⌉ parent is the generator itself: **[`57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0`](https://ordinals.com/inscription/57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0)**, block 969038. Open `/content/<parent id>#<seal id>` to see any seal, animated, from Bitcoin alone.
- Its content's sha256 is `6efc3916ac80a5501c04c7bd0c5cb3ed2e593acbe4fd7a8c419b32c82de8f7f3`: the exact output of `node tools/build-inscription.js inscription`.
- Reveal outputs: `[0]` 546 sats carrying the inscription, `[1]` the deploy, `[2]` change if any. Inscription services cannot add the deploy output, so it is made with a dedicated tool, proven on Bitcoin Core with ord reading it back, then on signet, then on mainnet.
- An earlier deploy carried `tick` and `max` (inscription `1b073ff1…9df9i0`, block 969036). The deploy above, with the `crc-21` syntax, supersedes it.
- Seals stay `crc-20` seals on their covenants: the deploy adds the art and the identity, it does not change the mint and transfer rules.

## Where a seal lives

A Taproot output with the unspendable NUMS internal key and two leaves:

```
cosign  <SEAL_CONST> OP_DROP <owner_xonly> OP_CHECKSIGVERIFY <marketplace_xonly> OP_CHECKSIG
escape  <SEAL_CONST> OP_DROP <4320> OP_CHECKSEQUENCEVERIFY OP_DROP <owner_xonly> OP_CHECKSIG
```

- `owner_xonly` comes from the owner wallet's public key, so both Taproot (bc1p) and Native SegWit (bc1q) wallets can hold seals.
- Every trade (sale, sweep, accepted offer, send) uses the cosign leaf: the owner signs, then the marketplace signs the exact transaction that was prepared. **The marketplace alone can never move a seal.**
- A seller's listing signature (`SIGHASH_SINGLE|ANYONECANPAY`) is useless on its own: nobody can rebuild the sale without the fee, replay it after a delist or a new price, or take a seal being bought by someone else.
- **If the marketplace ever disappears**, the owner alone moves a seal through the escape leaf once it has not moved for 4,320 blocks (witness `[owner signature, escape leaf, control block]`, input sequence ≥ 4320).
- `https://seals.garden/api/covenant?pk=<wallet pubkey>` returns both leaves and their control blocks.

## Mint

`{"p":"crc-20","op":"mint","tick":"SEAL","n":3}`: the outputs at marker index + 1 … marker index + n each receive a seal.

- The transaction must spend an output of the mint authority; `n` is 1 to 100.
- **Which ids a mint gets is decided by the block that confirms it.** For the k-th output (k = 0 … n−1): take the ids not minted or burned yet, in ascending order, and pick the one at index `SHA256("<block hash>:<txid>:<k>") mod <their count>` (hex strings, lowercase; the hash read as a big-endian number). Test vector: block hash `00…00`, txid `11…11`, k = 0, 1,500 free ids → index 771.
- Nobody, the marketplace included, can know or choose which seals a mint gets before its block exists: no sniping of the one-of-ones, no re-rolls.
- An output that is missing, an `OP_RETURN` or under 330 sats gets no seal and uses no draw. Once the supply is out, further outputs get nothing.

## Transfer

`{"p":"crc-20","op":"transfer","tick":"SEAL"}`: the k-th seal spent by the transaction (by input order, then id) moves to the output at marker index + 1 + k. The marker stays 44 bytes however many seals move, so a sweep of 50 is still a standard transaction.

- An explicit list is also accepted: with `"ids":[42]`, ids[k] moves to marker index + 1 + k.
- A seal spent without a marker moves to the first non-`OP_RETURN` output, so a wallet that does not know SEAL never destroys one by accident.
- A seal sent to an `OP_RETURN`, a missing output or an output under 330 sats is **burned** for good and can never be minted again.
- The owner is the address of the output holding the seal.

## Indexer

- Reads any Esplora API (blockstream.info, mempool.space, or your own).
- Discovers mints through the mint authority's history, then follows each live seal with `outspends` until nothing new is spent.
- Checks the last indexed block hash on every pass and rebuilds from scratch after a reorg.
- Run it: `node tools/owners.js` (every seal and its owner) or `node tools/owners.js 42`.

## Holders

Marketplace fees are split 60% to holders, 30% to buybacks, 10% to the protocol, paid in BTC to holders' addresses.

---

## Appendix: CRC-20 on mainnet

SEAL builds on CRC-20 as it runs today with LEAF (crc.garden) and BONS (bonsonbtc.fun). This section describes that base layer, read from live mainnet transactions.

**Model**

- Token amounts live on small outputs called seals (330 sats).
- A seal sits at the owner's covenant address: a Taproot output with an unspendable internal key and a single tapscript leaf only the owner's key can spend, optionally behind a relative timelock.
- Every operation carries a JSON marker in an `OP_RETURN`: `{"p":"crc-20","op":"…","tick":"…"}`.
- Each project runs an indexer that replays these transactions; transactions are prepared as PSBTs and the user's wallet signs.

**Covenant**

```
internal key : 50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0   (BIP341 NUMS point, no key-path spend)
leaf script  : <TOKEN_CONST:32> OP_DROP [ <csv> OP_CHECKSEQUENCEVERIFY OP_DROP ] <owner_xonly:32> OP_CHECKSIG
address      : P2TR(internal key, single leaf)
```

`TOKEN_CONST` is a 32-byte constant per token (LEAF `3e7b332b5816d972abe801cc0e012179d2299c0d2d9924ff0a36cc990fb14f43`, BONS `9bc1262bec613f73c51c455b767216c0d68cfcb8bd097cd817050a30d240ac5b`). LEAF adds a timelock (`csv` of 144, 1000, 2100 or 6767 blocks) on freshly minted seals. Spending a seal is a script-path spend: witness = `[signature, leaf script, control block]`.

**Operations**

- Mint (LEAF `2d90b28bc2483a1ccc08ac7682529c8faf5623923c4808035df08d6ea209d974`): `OP_RETURN {"p":"crc-20","op":"mint","tick":"LEAF"}`, then a 330-sat seal at the minter's covenant, the protocol fee and change. The indexer computes the amount from the payment.
- Transfer (LEAF `8d8f6f5b3e13ff045d41f4925ca03fbd317f8ad7ec1596e0cf1ba9a17ee5aa82`): `OP_RETURN {"p":"crc-20","op":"transfer","tick":"LEAF","amt":"…"}`; `amt` goes to the first output after the marker.
- Marketplace sale (BONS `757c8c90560615bd01432e25187f910705c21c790515891119d8f5d8b4b26014`): an atomic swap. The seller pre-signs their seal and payment with `SIGHASH_SINGLE|ANYONECANPAY`, the buyer completes and broadcasts, and either the whole trade happens or nothing does.
