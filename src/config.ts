import type { EnumSource, Network } from "./types";

export interface Config {
  network: Network;
  pchainRpcUrl: string;
  enumSource: EnumSource;
  dataApiBase: string;
  dataApiKey: string | null;
  enrich: boolean;
  concurrency: number;
  rpcIntervalMs: number;
  dataDir: string;
  persistGenesis: boolean;
  persistRaw: boolean;
  reportDir: string;
}

// PublicNode is the default: api.avax.network edge-rate-limits platform.* calls
// far too aggressively for a full enumeration (hour-long 429 cooldowns).
const DEFAULT_RPC: Record<Network, string> = {
  mainnet: "https://avalanche-p-chain-rpc.publicnode.com",
  fuji: "https://avalanche-fuji-p-chain-rpc.publicnode.com",
};

/** Parse `--key value`, `--key=value` and bare `--flag` argv tokens. */
export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function asBool(v: string | boolean | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  return !["false", "0", "no", "off"].includes(v.toLowerCase());
}

export function loadConfig(flags: Record<string, string | boolean>): Config {
  const env = process.env;
  const network = String(flags.network ?? env.NETWORK ?? "mainnet") as Network;
  if (network !== "mainnet" && network !== "fuji") {
    throw new Error(`invalid network: ${network} (expected mainnet|fuji)`);
  }
  const enumSource = String(
    flags.source ?? env.ENUM_SOURCE ?? "pchain",
  ) as EnumSource;
  if (enumSource !== "pchain" && enumSource !== "dataapi") {
    throw new Error(`invalid source: ${enumSource} (expected pchain|dataapi)`);
  }
  // empty string counts as absent (e.g. an unset CI secret)
  const rawKey = (flags["api-key"] as string) ?? env.DATA_API_KEY;
  const dataApiKey = rawKey ? String(rawKey) : null;
  // --no-enrich wins over --enrich; default: enrich only if a key is present
  let enrich = asBool(flags.enrich, asBool(env.ENRICH, dataApiKey !== null));
  if (flags["no-enrich"]) enrich = false;

  return {
    network,
    pchainRpcUrl: String(
      flags.rpc ?? env.PCHAIN_RPC_URL ?? DEFAULT_RPC[network],
    ),
    enumSource,
    dataApiBase: String(
      flags["api-base"] ?? env.DATA_API_BASE ?? "https://glacier-api.avax.network",
    ),
    dataApiKey: dataApiKey === null ? null : String(dataApiKey),
    enrich,
    concurrency: Number(flags.concurrency ?? env.CONCURRENCY ?? 4),
    rpcIntervalMs: Number(flags["rpc-interval"] ?? env.RPC_INTERVAL_MS ?? 150),
    dataDir: String(flags["data-dir"] ?? env.DATA_DIR ?? `data/${network}`),
    persistGenesis: asBool(
      flags["persist-genesis"],
      asBool(env.PERSIST_GENESIS, false),
    ),
    persistRaw: asBool(flags["persist-raw"], asBool(env.PERSIST_RAW, false)),
    reportDir: String(flags["report-dir"] ?? env.REPORT_DIR ?? "reports"),
  };
}
