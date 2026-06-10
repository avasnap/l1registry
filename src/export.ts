import { writeFileSync } from "node:fs";
import type { Config } from "./config";
import { type Doc, Store } from "./store";

/** Parse `--filter key=value[,key=value...]` into field/value equality pairs. */
export function parseFilter(raw: string | boolean | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  const query: Record<string, unknown> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const valRaw = pair.slice(eq + 1).trim();
    let val: unknown = valRaw;
    if (valRaw === "true") val = true;
    else if (valRaw === "false") val = false;
    else if (valRaw === "null") val = null;
    else if (/^-?\d+$/.test(valRaw)) val = Number(valRaw);
    query[key] = val;
  }
  return query;
}

/** Equality-AND matcher over the parsed filter pairs. */
export function matches(filter: Record<string, unknown>): (d: Doc) => boolean {
  const entries = Object.entries(filter);
  return (d) => entries.every(([k, v]) => d[k] === v);
}

function toCsv(docs: Record<string, unknown>[]): string {
  if (docs.length === 0) return "";
  const cols = [...new Set(docs.flatMap((d) => Object.keys(d)))];
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [
    cols.join(","),
    ...docs.map((d) => cols.map((c) => cell(d[c])).join(",")),
  ].join("\n");
}

export async function runExport(
  cfg: Config,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const collection = String(flags.collection ?? "blockchains");
  const format = String(flags.format ?? "json");
  const store = new Store(cfg.dataDir);
  const docs = store.find(collection, matches(parseFilter(flags.filter)));
  const out = format === "csv" ? toCsv(docs) : JSON.stringify(docs, null, 2);
  if (typeof flags.out === "string") {
    writeFileSync(flags.out, out);
    console.error(`wrote ${docs.length} ${collection} records to ${flags.out}`);
  } else {
    console.log(out);
  }
}
