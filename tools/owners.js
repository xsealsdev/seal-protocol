// Who owns each ⌈seal⌉, computed from Bitcoin alone: replays every mint and transfer with the SEAL v1 rules.
// No server of ours is involved. Chain data from any Esplora API (blockstream.info by default).
// Usage: node tools/owners.js            → every minted seal and its owner
//        node tools/owners.js 42         → the owner of seal #42
//        ESPLORA_URL=https://mempool.space/api node tools/owners.js
const { SealIndexer } = require('../indexer/indexer');
const { esplora } = require('../indexer/esplora');

const AUTHORITY = 'bc1pk3vsmhdmzct6rj9ls7lnfg0yreqe0c9h4sqjl6n9te2kt5tqjnmss62j3h'; // the ⌈seal⌉ mint authority (mainnet)
const source = esplora(process.env.ESPLORA_URL || 'https://blockstream.info/api');
const indexer = new SealIndexer({ source, network: 'mainnet', authority: AUTHORITY, confirmations: 1, log: () => {} });

(async () => {
  await indexer.sync(true);
  const owners = indexer.owners(), id = process.argv[2];
  if (id) return console.log(owners[id] ? `⌈seal⌉ #${id} → ${owners[id]}` : `⌈seal⌉ #${id} is not minted yet`);
  const ids = Object.keys(owners).map(Number).sort((a, b) => a - b);
  for (const i of ids) console.log(`#${String(i).padStart(4)}  ${owners[i]}`);
  console.log(`\n${ids.length} seals minted, ${new Set(Object.values(owners)).size} holders (block ${indexer.status().height})`);
})().catch(e => { console.error(e.message); process.exit(1); });
