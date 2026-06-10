# l1registry — local Avalanche L1 / subnet registry

Enumerates every blockchain and subnet registered on the Avalanche P-Chain,
classifies each one (L1 vs legacy subnet, permissioned vs public, VM type,
recommended data-access tier), and materializes the result into **JSON files
committed to this repo** (`data/<network>/`) — a durable, diffable,
re-runnable local registry with a static explorer UI on top.

This captures the P-Chain's *registry* only — it does not ingest any L1's
block/transaction data. It is the lookup table downstream ingestion routes from.

## Requirements

- [Bun](https://bun.sh) ≥ 1.x
- Network access to a P-Chain JSON-RPC endpoint (defaults to PublicNode)

```sh
bun install
```

## Usage

```sh
# full enumeration + classification + upsert (idempotent, cron-friendly)
bun run registry sync

# dump the registry
bun run registry export --format json                 # blockchains (default)
bun run registry export --collection subnets --format csv --out subnets.csv
bun run registry export --filter "isL1=true,vmType=subnet-evm"

# canned slices (§9 of the milestone spec)
bun run registry query public-evm-l1s    # public subnet-evm L1s → Tier B/C candidates
bun run registry query unreachable       # permissioned / unreachable chains
bun run registry query covered           # Data-API-indexed chains → Tier A
bun run registry query custom-vm         # custom-VM chains
bun run registry query --where "accessTier=C" --json
```

## Configuration

Everything is settable via env var (see [.env.example](.env.example)) or flag;
flags win.

| flag | env | default | notes |
|---|---|---|---|
| `--network` | `NETWORK` | `mainnet` | `mainnet` \| `fuji` |
| `--rpc` | `PCHAIN_RPC_URL` | PublicNode P-Chain | ⚠️ `api.avax.network` edge-rate-limits `platform.*` with hour-long cooldowns; don't use it for full enumerations |
| `--source` | `ENUM_SOURCE` | `pchain` | enumeration strategy: `pchain` (canonical) \| `dataapi` (fallback if `platform.getBlockchains` is ever removed) |
| `--data-dir` | `DATA_DIR` | `data/<network>` | where the JSON collections live |
| `--api-base` | `DATA_API_BASE` | `https://glacier-api.avax.network` | AvaCloud Data API |
| `--api-key` | `DATA_API_KEY` | — | sent as `x-glacier-api-key` |
| `--enrich` / `--no-enrich` | `ENRICH` | on iff key set | Data API enrichment (evmChainId, validator-manager details, `dataApiCovered`, isL1 cross-check) |
| `--concurrency` | `CONCURRENCY` | `4` | per-subnet fan-out parallelism |
| `--rpc-interval` | `RPC_INTERVAL_MS` | `150` | min ms between P-Chain request starts |
| `--persist-genesis` | `PERSIST_GENESIS` | `false` | genesis blobs are large; off by default |
| `--persist-raw` | `PERSIST_RAW` | `false` | archive raw RPC responses to `raw_responses` |
| `--report-dir` | `REPORT_DIR` | `reports/` | run report JSON output |

The registry is fully functional from the P-Chain alone; enrichment only adds
`evmChainId`, `l1ConversionTxHash`, validator-manager details, `dataApiCovered`
(which drives Tier A), and an `isL1` cross-check (disagreements are recorded in
`conflicts`, never silently resolved).

## Data model (JSON files in `data/<network>/`)

One file per collection, keyed by primary key with sorted keys — so every
`sync` produces a clean, reviewable git diff of what actually changed on-chain.

- **`blockchains.json`** (PK `blockchainId`) — name, subnetId, vmId/vmType,
  evmChainId, isL1, isPermissioned, manager chain/address, conversion ids,
  rpcEndpoints, dataApiCovered, accessTier, per-field `provenance`,
  `conflicts`, `fetchErrors`, `firstSeenAt`/`lastSeenAt`/`lastUpdatedAt`, `stale`.
- **`subnets.json`** (PK `subnetId`) — control keys/threshold/locktime, conversion
  fields, blockchainIds, validatorSummary `{count, totalWeight}`, timestamps.
- **`validators.json`** (PK `subnetId:nodeId`) — weight, BLS key + PoP, connected,
  uptime, start/end, validationId (ACP-77 L1 validators), timestamps.
- **`runs.json`** (PK `runId`) — one per sync: totals, vmType/accessTier breakdowns,
  `new`/`changed`/`went-stale` diffs, errors.
- **`raw/<runId>/`** — raw RPC responses, only with `--persist-raw`.

Re-runs are idempotent: unchanged records only bump `lastSeenAt`; content
changes (detected via a stable hash of the non-timestamp fields) bump
`lastUpdatedAt`; records that disappear from the chain are flagged
`stale: true` (never hard-deleted).

## Classification

- **isL1** — `conversionID` set (≠ the empty ID `11111…LpoYY`) **or**
  `managerAddress` present. Cross-checked against the Data API when enrichment
  is on; disagreements land in `conflicts`.
- **vmType** — `subnet-evm` iff vmId = `srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy`;
  `unknown` only when the vmId is missing; otherwise `custom`.
- **isEvm** — canonical `subnet-evm` vmId **or** the Data API reports an
  `evmChainId`. Many chains run modified/forked Subnet-EVM builds under their
  own vmId (`vmType: custom`) but are ordinary EVM chains; this flag catches
  them. Without enrichment the second signal is unavailable, so modified forks
  degrade to `unreachable` on P-Chain-only runs.
- **accessTier** (routing recommendation for later ingestion milestones):
  - `A` — indexed by the Data API (`dataApiCovered`)
  - `B` — public EVM chain (`isEvm`) with a known RPC (seed list: [config/rpc-endpoints.json](config/rpc-endpoints.json))
  - `C` — public EVM chain, no convenient RPC (self-host candidate)
  - `unreachable` — permissioned/private or non-EVM VM

## RPC endpoints & probing

[config/rpc-endpoints.json](config/rpc-endpoints.json) maps
`blockchainId → [rpcUrl, …]` for manually curated endpoints. On top of that,
every sync probes candidate endpoints for public EVM chains (the config list
plus the derived AvaCloud gateway URL
`https://subnets.avax.network/<name-slug>/<network>/rpc`) with `eth_chainId`,
requiring the answer to match the chain's `evmChainId`. Results land in:

- `rpcVerified` — `true` (≥1 endpoint answered correctly this run), `false`
  (candidates probed, none worked), `null` (not probed: permissioned or no
  candidates)
- `rpcEndpoints` — config-known plus verified-derived endpoints; any entry
  here moves a public EVM chain to `accessTier: B`

Disable with `--no-probe-rpcs` / `PROBE_RPCS=false`.

## Sample run report

From the real initial mainnet import on 2026-06-10 (`bun run registry sync
--enrich`, PublicNode RPC, keyless Glacier). The stored report carries full id
lists in `diff`; counts shown here for brevity:

```json
{
  "runId": "19f169cc-fcde-4a59-a31d-bde9bb5e218d",
  "network": "mainnet",
  "startedAt": "2026-06-10T21:06:39.932Z",
  "durationMs": 125793,
  "enumSource": "pchain",
  "enrichmentEnabled": true,
  "totals": {
    "blockchains": 429,
    "subnets": 417,
    "l1s": 270,
    "legacySubnets": 146,
    "permissioned": 146,
    "validators": 1963
  },
  "byVmType": { "subnet-evm": 94, "custom": 335 },
  "byAccessTier": { "A": 32, "C": 55, "unreachable": 342 },
  "diff": {
    "blockchains": { "new": 429, "changed": 0, "wentStale": 0 },
    "subnets": { "new": 417, "changed": 0, "wentStale": 0 }
  },
  "errors": 0
}
```

Human log line:

```
sync done: 429 blockchains, 417 subnets (270 L1s, 146 permissioned), 1963 validators | new 429, changed 0, stale 0 | 0 errors
```

A steady-state re-run reports `new 0, changed 0, stale 0` and leaves the
collection files byte-identical — only `runs.json` records the run.

## Explorer UI (GitHub Pages)

[index.html](index.html) is a dependency-free static explorer that reads the
JSON files directly: summary cards from the latest run, the four §9 preset
slices, free-text search, tier/VM filters, sortable columns, and a per-chain
detail view (provenance, subnet info, on-demand validator set). Append
`?network=fuji` to browse a Fuji dataset.

To publish: push this repo to GitHub → **Settings → Pages → Deploy from a
branch** → branch `main`, folder `/ (root)`. The site serves `index.html` and
`data/` as-is; every synced-and-pushed run updates the live explorer.

To browse locally: `bunx serve .` (or any static file server — `file://` won't
work because the page fetches the JSON files).

## Automated sync (GitHub Actions)

[.github/workflows/sync.yml](.github/workflows/sync.yml) runs
`registry sync --enrich` every 6 hours (and on manual dispatch). When registry
content actually changed it commits `data/` with a diff summary
(`sync: 2 new, 3 changed, 0 stale (…)`) and pushes — which redeploys the Pages
explorer. No-op runs are skipped, so the commit history reads as a changelog
of the P-Chain. Set a `DATA_API_KEY` repo secret to enrich with an AvaCloud
key instead of keyless (rate-limited) access.

`sync` is also safe to run locally on a cron; each run appends to `runs.json`
and writes `reports/run-<runId>.json` with the diff since the previous run.
