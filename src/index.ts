import { loadConfig, parseArgs } from "./config";
import { runExport } from "./export";
import { runQuery } from "./query";
import { runSync } from "./sync";
import { log } from "./util";

const USAGE = `Avalanche L1 registry

usage:
  registry sync                       enumerate P-Chain, classify, upsert into data/
  registry export [--collection blockchains|subnets|validators|runs]
                  [--format json|csv] [--filter k=v,...] [--out file]
  registry query <name> | --where k=v[,...]   [--json]

common flags (env var in parens):
  --network mainnet|fuji   (NETWORK)        --rpc <url>        (PCHAIN_RPC_URL)
  --source pchain|dataapi  (ENUM_SOURCE)    --data-dir <dir>   (DATA_DIR)
  --concurrency <n>        (CONCURRENCY)
  --enrich / --no-enrich   (ENRICH)         --api-key <key>    (DATA_API_KEY)
  --api-base <url>         (DATA_API_BASE)  --persist-genesis  (PERSIST_GENESIS)
  --persist-raw            (PERSIST_RAW)    --report-dir <dir> (REPORT_DIR)
  --probe-rpcs / --no-probe-rpcs (PROBE_RPCS, default on)
`;

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;

try {
  const cfg = loadConfig(flags);
  switch (command) {
    case "sync":
      await runSync(cfg);
      break;
    case "export":
      await runExport(cfg, flags);
      break;
    case "query":
      await runQuery(cfg, rest, flags);
      break;
    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  log("error", String(err instanceof Error ? (err.stack ?? err.message) : err));
  process.exitCode = 1;
}
