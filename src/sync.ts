import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAccessTier, classifyIsL1, classifyVmType } from "./classify";
import type { Config } from "./config";
import { DataApiClient } from "./dataapi";
import { PChainClient, PRIMARY_NETWORK_ID } from "./pchain";
import { Store } from "./store";
import type {
  BlockchainRecord,
  ClassificationConflict,
  DataApiSubnet,
  EnumeratedBlockchain,
  PChainSubnetInfo,
  ProvenanceMap,
  RunReport,
  SubnetRecord,
  ValidatorRecord,
} from "./types";
import { log, pLimit } from "./util";

import knownRpcEndpoints from "../config/rpc-endpoints.json";

interface SubnetFetchResult {
  subnetId: string;
  info: PChainSubnetInfo | null;
  validators: Record<string, unknown>[] | null;
  dataApi: DataApiSubnet | null;
  errors: { scope: string; key: string; message: string }[];
}

/** Normalize the two validator shapes (staking/permissioned vs ACP-77 L1). */
function normalizeValidator(
  subnetId: string,
  v: Record<string, unknown>,
): ValidatorRecord | null {
  const nodeId = v.nodeID ?? v.nodeId;
  if (!nodeId) return null;
  const signer = (v.signer ?? {}) as Record<string, unknown>;
  const weight = v.weight ?? v.stakeAmount ?? null;
  return {
    _id: `${subnetId}:${nodeId}`,
    subnetId,
    nodeId: String(nodeId),
    weight: weight === null ? null : String(weight),
    blsPublicKey: String(signer.publicKey ?? v.publicKey ?? "") || null,
    proofOfPossession: String(signer.proofOfPossession ?? "") || null,
    connected: typeof v.connected === "boolean" ? v.connected : null,
    uptime: v.uptime === undefined ? null : Number(v.uptime),
    startTime: v.startTime === undefined ? null : String(v.startTime),
    endTime: v.endTime === undefined ? null : String(v.endTime),
    validationId: v.validationID ? String(v.validationID) : null,
    stale: false,
  };
}

export async function runSync(cfg: Config): Promise<RunReport> {
  const runId = randomUUID();
  const startedAt = new Date();
  log("info", "sync starting", {
    runId,
    network: cfg.network,
    rpc: cfg.pchainRpcUrl,
    source: cfg.enumSource,
    enrich: cfg.enrich,
  });

  const pchain = new PChainClient(cfg.pchainRpcUrl, cfg.rpcIntervalMs);
  const dataApi =
    cfg.enrich || cfg.enumSource === "dataapi"
      ? new DataApiClient(cfg.dataApiBase, cfg.dataApiKey)
      : null;
  const store = new Store(cfg.dataDir);

  const errors: RunReport["errors"] = [];
  {
    // 1. Enumerate blockchains (strategy: pchain default, dataapi fallback).
    let chains: EnumeratedBlockchain[];
    if (cfg.enumSource === "pchain") {
      chains = await pchain.getBlockchains();
    } else {
      if (!dataApi) throw new Error("dataapi enumeration requires the Data API client");
      chains = await dataApi.listBlockchains(cfg.network);
    }
    log("info", `enumerated ${chains.length} blockchains via ${cfg.enumSource}`);

    // 2. Distinct subnet ids.
    const subnetIds = [...new Set(chains.map((c) => c.subnetId))];

    // 3+4. Fan out per subnet with bounded concurrency.
    const limit = pLimit(cfg.concurrency);
    const subnetResults = await Promise.all(
      subnetIds.map((subnetId) =>
        limit(async (): Promise<SubnetFetchResult> => {
          const r: SubnetFetchResult = {
            subnetId,
            info: null,
            validators: null,
            dataApi: null,
            errors: [],
          };
          try {
            if (subnetId === PRIMARY_NETWORK_ID) {
              // getSubnet rejects the Primary Network ("isn't a subnet");
              // synthesize the open/unconverted shape instead.
              r.info = {
                isPermissioned: false,
                controlKeys: [],
                threshold: null,
                locktime: null,
                subnetTransformationTxID: null,
                conversionID: null,
                managerChainID: null,
                managerAddress: null,
              };
            } else {
              const { info, raw } = await pchain.getSubnet(subnetId);
              r.info = info;
              if (cfg.persistRaw) store.saveRaw(runId, "getSubnet", subnetId, raw);
            }
          } catch (e) {
            r.errors.push({ scope: "getSubnet", key: subnetId, message: String(e) });
          }
          try {
            r.validators = await pchain.getCurrentValidators(subnetId);
            if (cfg.persistRaw)
              store.saveRaw(runId, "getCurrentValidators", subnetId, r.validators);
          } catch (e) {
            r.errors.push({
              scope: "getCurrentValidators",
              key: subnetId,
              message: String(e),
            });
          }
          if (cfg.enrich && dataApi) {
            try {
              r.dataApi = await dataApi.getSubnet(cfg.network, subnetId);
            } catch (e) {
              r.errors.push({ scope: "dataapi.getSubnet", key: subnetId, message: String(e) });
            }
          }
          return r;
        }),
      ),
    );
    const bySubnet = new Map(subnetResults.map((r) => [r.subnetId, r]));
    for (const r of subnetResults) errors.push(...r.errors);

    // Data API coverage list (one call, drives accessTier A).
    let coveredIds = new Set<string>();
    if (cfg.enrich && dataApi) {
      try {
        const indexed = await dataApi.listIndexedChains(cfg.network);
        coveredIds = new Set(
          indexed.flatMap((c) =>
            [c.platformChainId, c.blockchainId].filter(Boolean).map(String),
          ),
        );
        log("info", `data api indexes ${coveredIds.size} chains`);
      } catch (e) {
        errors.push({ scope: "dataapi.listChains", key: "-", message: String(e) });
      }
    }

    // 5. Classify + build records.
    const chainsBySubnet = new Map<string, string[]>();
    for (const c of chains) {
      chainsBySubnet.set(c.subnetId, [
        ...(chainsBySubnet.get(c.subnetId) ?? []),
        c.blockchainId,
      ]);
    }

    const blockchainDocs: BlockchainRecord[] = chains.map((c) => {
      const sub = bySubnet.get(c.subnetId);
      const info = sub?.info ?? null;
      const api = sub?.dataApi ?? null;
      const apiChain = api?.blockchains?.find((b) => b.blockchainId === c.blockchainId);

      const provenance: ProvenanceMap = {
        blockchainId: c.source,
        name: c.source,
        subnetId: c.source,
        vmId: c.source,
        vmType: "derived",
        isL1: "derived",
        accessTier: "derived",
      };
      const conflicts: ClassificationConflict[] = [];

      const isPermissioned = info?.isPermissioned ?? null;
      if (info) provenance.isPermissioned = "pchain";

      const conversionId = info?.conversionID ?? null;
      const managerAddress = info?.managerAddress ?? null;
      let isL1 = classifyIsL1(conversionId, managerAddress);
      // Primary Network is special-cased: never an L1, never permissioned-tier.
      if (c.subnetId === PRIMARY_NETWORK_ID) isL1 = false;
      if (api?.isL1 !== undefined && api.isL1 !== isL1) {
        conflicts.push({ field: "isL1", pchain: isL1, dataapi: api.isL1 });
      }

      const vmType = classifyVmType(c.vmId);
      const evmChainId = apiChain?.evmChainId ?? null;
      if (evmChainId !== null) provenance.evmChainId = "dataapi";

      const rpcEndpoints =
        (knownRpcEndpoints as Record<string, string[]>)[c.blockchainId] ?? [];
      if (rpcEndpoints.length > 0) provenance.rpcEndpoints = "config";

      const dataApiCovered = coveredIds.has(c.blockchainId);
      const accessTier = classifyAccessTier({
        dataApiCovered,
        vmType,
        isPermissioned,
        rpcEndpoints,
      });

      const name = c.name ?? apiChain?.blockchainName ?? null;
      if (c.name === null && apiChain?.blockchainName) provenance.name = "dataapi";

      if (api?.l1ConversionTransactionHash) provenance.l1ConversionTxHash = "dataapi";
      if (api?.l1ValidatorManagerDetails) provenance.validatorManager = "dataapi";
      if (info?.managerChainID) provenance.managerChainId = "pchain";
      if (info?.managerAddress) provenance.managerAddress = "pchain";

      return {
        _id: c.blockchainId,
        blockchainId: c.blockchainId,
        name,
        subnetId: c.subnetId,
        vmId: c.vmId,
        vmType,
        evmChainId,
        isL1,
        isPermissioned,
        managerChainId: info?.managerChainID ?? null,
        managerAddress,
        conversionId,
        l1ConversionTxHash: api?.l1ConversionTransactionHash ?? null,
        validatorManager: api?.l1ValidatorManagerDetails ?? null,
        rpcEndpoints,
        dataApiCovered,
        accessTier,
        genesisData: cfg.persistGenesis ? (apiChain?.genesisData ?? null) : null,
        provenance,
        conflicts,
        fetchErrors: (sub?.errors ?? []).map((e) => `${e.scope}: ${e.message}`),
        stale: false,
      };
    });

    const validatorDocs: ValidatorRecord[] = [];
    const subnetDocs: SubnetRecord[] = subnetIds.map((subnetId) => {
      const sub = bySubnet.get(subnetId)!;
      const info = sub.info;
      const vals = (sub.validators ?? [])
        .map((v) => normalizeValidator(subnetId, v))
        .filter((v): v is ValidatorRecord => v !== null);
      validatorDocs.push(...vals);

      let totalWeight = 0n;
      for (const v of vals) {
        try {
          totalWeight += BigInt(v.weight ?? 0);
        } catch {
          /* non-numeric weight; skip */
        }
      }

      const conversionId = info?.conversionID ?? null;
      const managerAddress = info?.managerAddress ?? null;
      const isL1 =
        subnetId === PRIMARY_NETWORK_ID
          ? false
          : classifyIsL1(conversionId, managerAddress);

      const provenance: ProvenanceMap = { isL1: "derived" };
      if (info) {
        for (const f of [
          "isPermissioned",
          "controlKeys",
          "threshold",
          "locktime",
          "conversionId",
          "managerChainId",
          "managerAddress",
        ])
          provenance[f] = "pchain";
      }
      if (sub.validators) provenance.validatorSummary = "pchain";

      return {
        _id: subnetId,
        subnetId,
        isL1,
        isPermissioned: info?.isPermissioned ?? null,
        controlKeys: info?.controlKeys ?? [],
        threshold: info?.threshold ?? null,
        locktime: info?.locktime ?? null,
        conversionId,
        managerChainId: info?.managerChainID ?? null,
        managerAddress,
        blockchainIds: chainsBySubnet.get(subnetId) ?? [],
        validatorSummary: sub.validators
          ? { count: vals.length, totalWeight: totalWeight.toString() }
          : null,
        provenance,
        fetchErrors: sub.errors.map((e) => `${e.scope}: ${e.message}`),
        stale: false,
      };
    });

    // 6. Upsert idempotently + stale-mark.
    const runTime = startedAt;
    const blockchainsDiff = store.syncCollection("blockchains", blockchainDocs, runTime);
    const subnetsDiff = store.syncCollection("subnets", subnetDocs, runTime);
    // Don't stale-mark validators of subnets whose validator fetch failed this run.
    const failedValidatorSubnets = new Set(
      subnetResults.filter((r) => r.validators === null).map((r) => r.subnetId),
    );
    store.syncCollection("validators", validatorDocs, runTime, (d) =>
      !failedValidatorSubnets.has(String(d.subnetId)),
    );

    // 7. Run report.
    const finishedAt = new Date();
    const byVmType: Record<string, number> = {};
    const byAccessTier: Record<string, number> = {};
    for (const b of blockchainDocs) {
      byVmType[b.vmType] = (byVmType[b.vmType] ?? 0) + 1;
      byAccessTier[b.accessTier] = (byAccessTier[b.accessTier] ?? 0) + 1;
    }
    const report: RunReport = {
      runId,
      network: cfg.network,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      enumSource: cfg.enumSource,
      enrichmentEnabled: cfg.enrich,
      totals: {
        blockchains: blockchainDocs.length,
        subnets: subnetDocs.length,
        l1s: subnetDocs.filter((s) => s.isL1).length,
        legacySubnets: subnetDocs.filter((s) => !s.isL1 && s.subnetId !== PRIMARY_NETWORK_ID)
          .length,
        permissioned: subnetDocs.filter((s) => s.isPermissioned === true).length,
        validators: validatorDocs.length,
      },
      byVmType,
      byAccessTier,
      diff: { blockchains: blockchainsDiff, subnets: subnetsDiff },
      errors,
    };
    store.saveRun(report);

    mkdirSync(cfg.reportDir, { recursive: true });
    const reportPath = join(cfg.reportDir, `run-${runId}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    log(
      "info",
      `sync done: ${report.totals.blockchains} blockchains, ${report.totals.subnets} subnets ` +
        `(${report.totals.l1s} L1s, ${report.totals.permissioned} permissioned), ` +
        `${report.totals.validators} validators | new ${blockchainsDiff.new.length}, ` +
        `changed ${blockchainsDiff.changed.length}, stale ${blockchainsDiff.wentStale.length} ` +
        `| ${errors.length} errors | report: ${reportPath}`,
    );
    return report;
  }
}
