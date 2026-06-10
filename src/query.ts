import type { Config } from "./config";
import { matches, parseFilter } from "./export";
import { type Doc, Store } from "./store";

/** Named slices required by §9 of the milestone spec. */
const NAMED_QUERIES: Record<string, { predicate: (d: Doc) => boolean; desc: string }> = {
  "public-evm-l1s": {
    predicate: (d) =>
      d.vmType === "subnet-evm" && d.isPermissioned === false && d.isL1 === true,
    desc: "public subnet-evm L1s (Tier B/C ingestion candidates)",
  },
  unreachable: {
    predicate: (d) => d.isPermissioned === true || d.accessTier === "unreachable",
    desc: "permissioned / unreachable chains",
  },
  covered: {
    predicate: (d) => d.dataApiCovered === true,
    desc: "chains indexed by the Data API (Tier A)",
  },
  "custom-vm": {
    predicate: (d) => d.vmType === "custom",
    desc: "chains running a custom VM",
  },
};

export async function runQuery(
  cfg: Config,
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const name = positional[0];
  let predicate: (d: Doc) => boolean;
  if (name && NAMED_QUERIES[name]) {
    predicate = NAMED_QUERIES[name].predicate;
  } else if (flags.where) {
    predicate = matches(parseFilter(flags.where));
  } else {
    console.error("usage: registry query <name> | --where k=v[,k=v...]\n\nnamed queries:");
    for (const [k, v] of Object.entries(NAMED_QUERIES)) {
      console.error(`  ${k.padEnd(16)} ${v.desc}`);
    }
    process.exitCode = 1;
    return;
  }

  const store = new Store(cfg.dataDir);
  const docs = store
    .find("blockchains", predicate)
    .sort((a, b) => String(a.name ?? "~").localeCompare(String(b.name ?? "~")));
  if (flags.json) {
    console.log(JSON.stringify(docs, null, 2));
  } else {
    console.table(
      docs.map((d) => ({
        name: d.name ?? "(unnamed)",
        blockchainId: d.blockchainId,
        vmType: d.vmType,
        evmChainId: d.evmChainId ?? "",
        isL1: d.isL1,
        tier: d.accessTier,
        stale: d.stale,
      })),
    );
    console.error(`${docs.length} chains`);
  }
}
