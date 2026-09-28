# ⌈seal⌉ protocol

**1,500 pixel seals on Bitcoin L1. The art is inscribed. The ownership is open. Don't trust, verify.**

⌈seal⌉ brings collectibles to CRC-20, the covenant token protocol behind $LEAF, and this repository is the first published specification for them: how a unique seal is minted, held, traded and indexed, and how a collection declares itself on-chain with `crc-21`.

→ Mint: **[seals.garden](https://seals.garden)** · X: **[@SealsCRC](https://x.com/SealsCRC)**

---

## The art lives on Bitcoin

Every seal is drawn by one generator, and that generator is **inscribed on Bitcoin** as the collection's parent inscription:

**[`57c2297b…17cbi0`](https://ordinals.com/inscription/57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0)** · block 969038

Add a seal number to see it, animated, straight from the chain:

| | |
|---|---|
| #251 Taproot (1/1) | [ordinals.com/content/…i0#251](https://ordinals.com/content/57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0#251) |
| #1219 Satoshi (1/1) | [ordinals.com/content/…i0#1219](https://ordinals.com/content/57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0#1219) |
| #42 | [ordinals.com/content/…i0#42](https://ordinals.com/content/57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0#42) |

No server, no IPFS pin, no URL that can die. If seals.garden disappeared tomorrow, every seal would still be drawn from Bitcoin alone, pixel for pixel.

The same transaction carries the collection's deploy, `OP_RETURN {"p":"crc-21","op":"deploy","type":"ord"}`. The generator is deterministic: the inscribed page draws, pixel for pixel, the very seals that were minted, and from now on no seal can ever be redrawn.

## Nobody picks the rare ones

Which seals a mint gets is drawn from **the block that confirms it**: `SHA256("<block hash>:<txid>:<k>")`. Nobody, the team included, can know or choose a seal before its block exists. No sniping of the 8 one-of-ones, no re-rolls.

| # | 1/1 |
|---|---|
| 251 | Taproot |
| 439 | Mempool |
| 654 | Genesis |
| 695 | Whale |
| 957 | Ordinal |
| 1219 | Satoshi |
| 1448 | Block Zero |
| 1477 | Halving |

## Your seal, your key

A seal is a 330-sat output at a Taproot covenant that never moves without your signature. Trades are co-signed by the marketplace so a listing can never be replayed or sniped, and if the marketplace ever went away, **you move your seal alone** after 4,320 blocks (about 30 days) through the covenant's escape path. The marketplace can never move a seal by itself.

## Holders earn

Marketplace fees are split **60% to holders**, 30% to buybacks, 10% to the protocol, paid out in BTC to every holder's address.

## Verify it yourself

Node.js 18+, no dependencies.

```sh
# 1. The inscribed art is exactly this code
node tools/build-inscription.js inscription
#    → sha256 6efc3916ac80a5501c04c7bd0c5cb3ed2e593acbe4fd7a8c419b32c82de8f7f3
curl -s https://ordinals.com/content/57c2297b7ae51b7732ca64dc6efc6d0712c620a9bc85aeef61fe97b5c7ea17cbi0 | sha256sum
#    → the same hash

# 2. Who owns every seal, recomputed from the chain alone (blockstream.info by default)
node tools/owners.js          # every seal and its owner
node tools/owners.js 251      # one seal

# 3. The rules, tested
node --test test/indexer.test.js
```

## What's inside

| Path | |
|---|---|
| [`docs/protocol.md`](docs/protocol.md) | The SEAL v1 spec: covenant, fair draw, mint, transfer, the `crc-21` collection deploy, and CRC-20 as it runs on mainnet |
| [`src/engine.js`](src/engine.js) | The generator: 1,500 seals, 69 traits, 8 one-of-ones, deterministic |
| [`tools/build-inscription.js`](tools/build-inscription.js) | Builds the exact page inscribed on Bitcoin |
| [`indexer/`](indexer) | The SEAL v1 indexer: replays every mint and transfer to compute ownership |
| [`tools/owners.js`](tools/owners.js) | Runs the indexer against mainnet |

## License

Code: [MIT](LICENSE). The ⌈seal⌉ artwork and name: © ⌈seal⌉, all rights reserved, see [LICENSE](LICENSE).
