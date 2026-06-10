import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DiffReport, RunReport } from "./types";
import { contentHash, log } from "./util";

// Excluded from the content hash: bookkeeping fields plus volatile validator
// telemetry (uptime/connected change every run and would drown the diff).
// Records whose content hash is unchanged are not rewritten at all, so these
// fields refresh only when the record otherwise changes.
const NON_CONTENT_FIELDS = new Set([
  "_id",
  "stale",
  "staleSince",
  "firstSeenAt",
  "lastSeenAt",
  "lastUpdatedAt",
  "contentHash",
  "fetchErrors",
  "uptime",
  "connected",
]);

export type Doc = { _id: string; [k: string]: unknown };

/**
 * File-backed store: one JSON file per collection under dataDir, keyed by _id
 * with sorted keys so re-runs produce clean, reviewable git diffs.
 */
export class Store {
  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
  }

  private path(collection: string): string {
    return join(this.dataDir, `${collection}.json`);
  }

  load(collection: string): Record<string, Doc> {
    const p = this.path(collection);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8"));
  }

  private save(collection: string, docs: Record<string, Doc>): void {
    const sorted = Object.fromEntries(
      Object.keys(docs)
        .sort()
        .map((k) => [k, docs[k]]),
    );
    const p = this.path(collection);
    const content = JSON.stringify(sorted, null, 2);
    const tmp = `${p}.tmp`; // write-then-rename so a crash never truncates data
    writeFileSync(tmp, content);
    // On Windows the rename fails with EPERM/EBUSY while another process
    // (file server, file watcher, AV scan) holds the target open. Retry the
    // atomic rename briefly, then fall back to an in-place write — open
    // shared-read handles still permit writes, just not renames, and the
    // tmp copy above guards against a crash mid-write.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        renameSync(tmp, p);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY") throw err;
        Bun.sleepSync(100 * (attempt + 1));
      }
    }
    writeFileSync(p, content);
    rmSync(tmp);
  }

  find(collection: string, predicate?: (d: Doc) => boolean): Doc[] {
    const all = Object.values(this.load(collection));
    return predicate ? all.filter(predicate) : all;
  }

  /**
   * Idempotent upsert with diff tracking:
   *  - new docs get firstSeenAt
   *  - content changes (hash of non-bookkeeping fields) bump lastUpdatedAt
   *  - docs absent from this run (and passing staleEligible) flip to stale:true
   *
   * lastSeenAt is only written when a record is new, changed, or recovering
   * from stale — NOT on every run. A no-op sync must leave collection files
   * byte-identical (runs.json aside) so git diffs show only real on-chain
   * changes. For fresh records, "still present as of" is the latest run's
   * timestamp in runs.json.
   */
  syncCollection<T extends { _id: string }>(
    collection: string,
    records: readonly T[],
    runTime: Date,
    staleEligible: (d: Doc) => boolean = () => true,
  ): DiffReport {
    const docs = records as unknown as Doc[];
    const existing = this.load(collection);
    const runIso = runTime.toISOString();
    const added: string[] = [];
    const changed: string[] = [];

    for (const doc of docs) {
      const comparable = Object.fromEntries(
        Object.entries(doc).filter(([k]) => !NON_CONTENT_FIELDS.has(k)),
      );
      const hash = contentHash(comparable);
      const prev = existing[doc._id];
      const isNew = prev === undefined;
      const isChanged = !isNew && prev.contentHash !== hash;
      const wasStale = prev?.stale === true;
      if (isNew) added.push(doc._id);
      if (isChanged) changed.push(doc._id);
      // Untouched records are left byte-identical (including volatile
      // telemetry like uptime) — a no-op sync must produce a no-op git diff.
      if (!isNew && !isChanged && !wasStale) continue;
      existing[doc._id] = {
        ...doc,
        contentHash: hash,
        firstSeenAt: prev?.firstSeenAt ?? runIso,
        lastSeenAt: runIso,
        lastUpdatedAt: isNew || isChanged ? runIso : (prev?.lastUpdatedAt ?? runIso),
        stale: false,
        staleSince: null,
      };
    }

    const seen = new Set(docs.map((d) => d._id));
    const wentStale: string[] = [];
    for (const [id, doc] of Object.entries(existing)) {
      if (!seen.has(id) && doc.stale === false && staleEligible(doc)) {
        doc.stale = true;
        doc.staleSince = runIso;
        wentStale.push(id);
      }
    }

    this.save(collection, existing);
    log("info", `synced ${collection}`, {
      total: docs.length,
      new: added.length,
      changed: changed.length,
      wentStale: wentStale.length,
    });
    return { new: added, changed, wentStale };
  }

  saveRun(report: RunReport): void {
    const runs = this.load("runs");
    runs[report.runId] = { _id: report.runId, ...report };
    this.save("runs", runs);
  }

  saveRaw(runId: string, kind: string, key: string, response: unknown): void {
    const dir = join(this.dataDir, "raw", runId);
    mkdirSync(dir, { recursive: true });
    const safeKey = key.replaceAll(/[^A-Za-z0-9_-]/g, "_");
    writeFileSync(
      join(dir, `${kind}-${safeKey}.json`),
      JSON.stringify({ runId, kind, key, capturedAt: new Date().toISOString(), response }, null, 2),
    );
  }
}
