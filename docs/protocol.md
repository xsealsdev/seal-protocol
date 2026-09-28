# CRC-20: how it works on Bitcoin mainnet (reverse-engineered)

There is no public specification. Everything below comes from decoding real mainnet transactions of the two live CRC-20 tokens (LEAF on crc.garden, BONS on bonsonbtc.fun) and from their public APIs and client code, on 2026-09-28. The only published material is the PRECOP repository (github.com/BitcoinWorldTrustFoundation/precop), which is documentation only, marked 0.1.0-alpha, and describes a Simplicity-based design tested on Mutinynet. What runs on mainnet today is simpler, and is described here.

## Summary

CRC-20 is a UTXO-bound token protocol:

- Token amounts live on small outputs called **seals** (330 sats in the samples below).
- A seal sits at the owner's **covenant address**: a Taproot output with an unspendable internal key and a single tapscript leaf that only the owner's key can spend, optionally behind a relative timelock.
- Every operation carries a JSON marker in an `OP_RETURN` output: `{"p":"crc-20","op":"…","tick":"…"}`.
- There is no on-chain contract enforcing balances. Each project runs its own **indexer** that replays these transactions and computes who owns what. Transactions are prepared by the project's server as PSBTs, and the user's wallet only signs.

## Covenant address

```
internal key : 50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0   (BIP341 NUMS point, no key-path spend)
leaf script  : <TOKEN_CONST:32> OP_DROP [ <csv> OP_CHECKSEQUENCEVERIFY OP_DROP ] <owner_xonly:32> OP_CHECKSIG
address      : P2TR(internal key, single leaf)
```

- `TOKEN_CONST` is a 32-byte constant, the same for every holder of a token and different between tokens. It is not the treasury key.
  - LEAF: `3e7b332b5816d972abe801cc0e012179d2299c0d2d9924ff0a36cc990fb14f43`
  - BONS: `9bc1262bec613f73c51c455b767216c0d68cfcb8bd097cd817050a30d240ac5b`
- `owner_xonly` is the owner's Taproot x-only public key. This is why only bc1p wallets can hold CRC-20: a bc1q address only exposes a key hash.
- LEAF adds a timelock (`csv` of 144, 1000, 2100 or 6767 blocks) on freshly minted seals. BONS has none.

Example LEAF leaf script (csv = 1000):

```
20 3e7b332b…fb14f43   PUSH32 TOKEN_CONST
75                    OP_DROP
02 e803               PUSH 1000
b2                    OP_CHECKSEQUENCEVERIFY
75                    OP_DROP
20 844927ca…da21ef61  PUSH32 owner x-only key
ac                    OP_CHECKSIG
```

Spending a seal is a script-path spend: witness = `[signature, leaf script, control block]`.

## Operations

All markers are UTF-8 JSON pushed in an `OP_RETURN`.

### Mint

Observed in LEAF mint `2d90b28bc2483a1ccc08ac7682529c8faf5623923c4808035df08d6ea209d974`:

| Output | Content |
|---|---|
| 0 | `OP_RETURN {"p":"ico-20","op":"transfer","tick":"LEAF","amt":"1100000"}` (payment in an older token, when paying with it) |
| 1 | 546 sats to `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa` (burn marker) |
| 2 | `OP_RETURN {"p":"crc-20","op":"mint","tick":"LEAF"}` |
| 3 | **330 sats seal** at the minter's covenant address |
| 4 | 10,000 sats protocol fee to the treasury |
| 5 | change |

The mint marker carries no amount: the indexer computes the allocation from the payment (LEAF exposes it as `payment_asset`, `payment_amount_atoms`, `csv_blocks`, `beneficiary`).

### Transfer

Observed in LEAF claim `8d8f6f5b3e13ff045d41f4925ca03fbd317f8ad7ec1596e0cf1ba9a17ee5aa82`:

- input 0: the seal, script-path spend by the owner
- output 0: `OP_RETURN {"p":"crc-20","op":"transfer","tick":"LEAF","amt":"104761904761905"}`
- output 1: the new seal that receives `amt`

Rule observed: `amt` goes to the **first output after the transfer marker**. BONS documents that a partial transfer returns the rest as a second seal in the same transaction.

### Marketplace sale (atomic swap)

Observed in BONS `757c8c90560615bd01432e25187f910705c21c790515891119d8f5d8b4b26014`:

| Input | Output |
|---|---|
| 0 seller's seal (script path, 65-byte signature: sighash flag appended, i.e. the seller pre-signed only their part) | 0 payment to the seller |
| 1 seller padding | 1 padding back to the seller |
| 2 330-sat dummy from the platform | 2 `OP_RETURN {"p":"crc-20","op":"transfer","tick":"BONS","amt":"…"}` |
| 3 buyer's BTC | 3 330-sat seal at the buyer's covenant address |
|  | 4 marketplace fee (300 bps on BONS) |
|  | 5 buyer's change |

Signature flags read from the witnesses of that transaction:

- inputs 0 and 1 (seller): `0x83` = `SIGHASH_SINGLE | ANYONECANPAY`. Each seller input commits only to itself and to the output at the same index (payment, padding return), so the listing can be pre-signed and completed later by anyone.
- input 2 (platform dummy): `0x01` = `SIGHASH_ALL`, signed when the sale is finalized.
- input 3 (buyer): 64-byte signature, i.e. `SIGHASH_DEFAULT`.

The seller signs the listing once. The buyer completes and broadcasts. Either the whole trade happens or nothing does.

## Public endpoints (read only)

- leaf: `https://crc.garden/api/crc20/events?cursor=0&limit=50&kind=mint|transfer|deploy` (full event log with block, txid, from, to, amount), `/api/mint/config`, `/api/oracle/btc-usd`
- BONS: `https://bonsonbtc.fun/api-mainnet/stats`, `/api-mainnet/mint/config`

Note: leaf reports a `deploy` event whose txid is not found on-chain, so token deployment appears to be defined in the indexer rather than by a transaction.

## SEAL v1: the ⌈seal⌉ NFT rules

CRC-20 only knows amounts, so it has no notion of a unique item. SEAL v1 keeps the same construction (a 330-sat output at a covenant address, an OP_RETURN marker) and adds ids. These rules are implemented by `indexer/indexer.js` and tested in `test/indexer.test.js`; the whole flow (mint, list, buy, sweep, offers, sends, payouts) was proven end to end on Bitcoin Core before launch (59 checks).

**Constants**

- Tick `SEAL`, supply 1,500, ids 1 to 1500.
- `SEAL_CONST = taggedHash("crc-20", "SEAL")` = `4d05e30c65d2dabf4cc2fbc2cff8c3b7010888a0de2d7128719006cbe46d7cf2`.
- The **mint authority** is a dedicated key held by the server (env `MINT_AUTHORITY_KEY`). Only transactions that spend one of its outputs can mint. Its untweaked public key is also the **marketplace key** of every covenant.
- `ESCAPE_BLOCKS = 4320` (about 30 days).

**Covenant: where a seal lives**

A Taproot output with the unspendable NUMS internal key and two leaves:

```
cosign  <SEAL_CONST> OP_DROP <owner_xonly> OP_CHECKSIGVERIFY <marketplace_xonly> OP_CHECKSIG
escape  <SEAL_CONST> OP_DROP <4320> OP_CHECKSEQUENCEVERIFY OP_DROP <owner_xonly> OP_CHECKSIG
```

- Every trade (sale, sweep, accepted offer, send) uses the cosign leaf: the owner signs, then the marketplace signs the exact transaction that was prepared. The marketplace alone can never move a seal.
- A seller's listing signature (SIGHASH_SINGLE|ANYONECANPAY) is useless on its own: nobody can rebuild the sale without the fee, replay it after a delist or a new price, or take a seal being bought by someone else.
- If the marketplace ever disappears, the owner alone can move a seal through the escape leaf once it has not moved for 4,320 blocks (witness `[owner signature, escape leaf, control block]`, input sequence ≥ 4320).
- `GET /api/covenant?pk=<wallet pubkey>` returns both leaves and control blocks.

**Mint**

`{"p":"crc-20","op":"mint","tick":"SEAL","n":3}`. The outputs at marker index + 1 … marker index + n each receive a seal.

- The transaction must spend an output of the mint authority; `n` is 1 to 100.
- Which ids a mint gets is decided by the block that confirms it. For the k-th output (k = 0 … n−1): take the ids not minted or burned yet, in ascending order, and pick the one at index `SHA256("<block hash>:<txid>:<k>") mod <their count>` (hex strings, lowercase; the hash read as a big-endian number). Test vector: block hash `00…00`, txid `11…11`, k = 0, 1,500 free ids → index 771.
- Nobody, the marketplace included, can know or choose which seals a mint gets before its block exists: no sniping of rare seals, no re-rolling.
- An output that is missing, an OP_RETURN or under 330 sats gets no seal and uses no draw. When the supply runs out, the remaining outputs get nothing (the server never sells more than what is left).

**Transfer**

`{"p":"crc-20","op":"transfer","tick":"SEAL"}`. The k-th seal spent by the transaction (by input order, then id) moves to the output at marker index + 1 + k. The marker stays 44 bytes however many seals move, so a sweep of 50 is still a standard transaction.

- An explicit list is also accepted: with `"ids":[42]`, ids[k] moves to marker index + 1 + k.
- A seal spent without a marker moves to the first non-OP_RETURN output, so a wallet that does not know SEAL never destroys one by accident.
- A seal sent to an OP_RETURN, a missing output or an output under 330 sats is **burned** for good and can never be minted again.
- The owner is the address of the output holding the seal: normally a covenant address, but any address works.

**Indexer**

- The indexer reads an Esplora API (mempool.space by default, or your own via `ESPLORA_URL`) or Bitcoin Core (`BITCOIN_RPC`).
- It discovers mints through the mint authority's history, then follows each live seal with `outspends` until nothing new is spent.
- It only counts transactions with `INDEX_CONFIRMATIONS` confirmations (default 2 on mainnet, 1 elsewhere).
- It checks the last indexed block hash on every pass and rebuilds from scratch after a reorg. The rebuild runs aside: the previous state keeps being served, and the marketplace refuses new trades until the index is healthy again.
- It saves its state in Postgres (`app_state` key `index`) or `DATA_DIR/index.json`, and resets itself if the network or mint authority changes.
- The mint authority must be a **fresh key used only for mints**: the indexer walks its whole history.

**Collection deploy (crc-21)**

`crc-20` markers carry amounts. A collection of unique items is declared once with a `crc-21` marker, so that token indexers never read it as a token:

```
{"p":"crc-21","op":"deploy","type":"ord"}   (41 bytes)
```

- It sits in an `OP_RETURN` of the **reveal transaction of the collection's parent inscription**: the inscription created by that transaction (`<txid>i0`) is the parent. Ours is the generator, `inscription/seal.html`, so every seal can be drawn from Bitcoin alone (`/content/<parent id>#<seal id>`).
- No `tick` and no `max`: the collection's identity and metadata are the parent inscription itself (ord), as the crc-21 author specified.
- A first deploy was made with `tick` and `max` (inscription 1b073ff1…9df9i0, block 969036): not the crc-21 syntax, superseded by the parent made with the deploy above.
- Seals stay `crc-20` seals on their covenants: the deploy adds the on-chain art and the collection's identity, it does not change the mint and transfer rules.
- Made by our own inscription tool (third-party inscription services cannot add the deploy output): reveal outputs are `[0]` 546 sats carrying the inscription, `[1]` the deploy, `[2]` change if any. Proven on Bitcoin Core with ord 0.29 reading it back, then on signet, then on mainnet.
- **The ⌈seal⌉ parent: [`57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0`](https://ordinals.com/inscription/57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0)**, block 969038. Its content's sha256 is `6efc3916ac80a5501c04c7bd0c5cb3ed2e593acbe4fd7a8c419b32c82de8f7f3`, the exact output of `node tools/build-inscription.js inscription`.

**What SEAL v1 does not give**

leaf and BONS indexers follow their own ticks and ignore `SEAL`. Seals are shown by seals.garden and by anyone who runs the indexer in this repository (`node tools/owners.js`); the art is on Bitcoin itself, in the parent inscription, readable on any ord explorer.

## Status

1. **Mainnet: live.** Mint open at [seals.garden](https://seals.garden).
2. **Art: on-chain.** The generator is the parent inscription above, with the `crc-21` deploy in its reveal.
3. **Ownership: open.** `indexer/indexer.js` recomputes every owner from the chain alone (`node tools/owners.js`).
4. **Revenue share**: marketplace fees go to a fee output; 60% is paid to holders, 30% to buybacks, 10% to the protocol.
