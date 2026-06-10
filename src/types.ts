// ---------------------------------------------------------------------------
// Domain types for the local Avalanche L1/subnet registry.
// ---------------------------------------------------------------------------

export type Network = "mainnet" | "fuji";
export type EnumSource = "pchain" | "dataapi";
export type FieldSource = "pchain" | "dataapi" | "derived" | "config";

export type VmType = "subnet-evm" | "custom" | "unknown";
export type AccessTier = "A" | "B" | "C" | "unreachable";

/** One blockchain as enumerated (before classification/enrichment). */
export interface EnumeratedBlockchain {
  blockchainId: string;
  name: string | null;
  subnetId: string;
  vmId: string | null;
  /** which enumeration source produced this row */
  source: EnumSource;
}

/** platform.getSubnet response (normalized). */
export interface PChainSubnetInfo {
  isPermissioned: boolean;
  controlKeys: string[];
  threshold: number | null;
  locktime: string | null;
  subnetTransformationTxID: string | null;
  conversionID: string | null;
  managerChainID: string | null;
  managerAddress: string | null;
}

/** A single validator, normalized across permissioned/primary/L1 shapes. */
export interface ValidatorRecord {
  _id: string; // `${subnetId}:${nodeId}`
  subnetId: string;
  nodeId: string;
  weight: string | null; // stringified bigint (stakeAmount for primary network)
  blsPublicKey: string | null;
  proofOfPossession: string | null;
  connected: boolean | null;
  uptime: number | null;
  startTime: string | null;
  endTime: string | null;
  validationId: string | null; // L1 validators only
  stale: boolean;
  staleSince?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastUpdatedAt?: string;
  contentHash?: string;
}

export interface ValidatorSummary {
  count: number;
  totalWeight: string; // stringified bigint
}

export interface ProvenanceMap {
  [field: string]: FieldSource;
}

export interface ClassificationConflict {
  field: string;
  pchain: unknown;
  dataapi: unknown;
}

export interface BlockchainRecord {
  _id: string; // blockchainId
  blockchainId: string;
  name: string | null;
  subnetId: string;
  vmId: string | null;
  vmType: VmType;
  evmChainId: number | null;
  /** canonical Subnet-EVM vmId OR Data API reports an evmChainId (modified forks) */
  isEvm: boolean;
  isL1: boolean;
  isPermissioned: boolean | null;
  managerChainId: string | null;
  managerAddress: string | null;
  conversionId: string | null;
  l1ConversionTxHash: string | null;
  validatorManager: { blockchainId: string; contractAddress: string } | null;
  rpcEndpoints: string[];
  /** true: ≥1 endpoint answered eth_chainId correctly this run;
   *  false: candidates probed, none worked; null: not probed */
  rpcVerified: boolean | null;
  dataApiCovered: boolean;
  accessTier: AccessTier;
  genesisData: unknown | null;
  provenance: ProvenanceMap;
  conflicts: ClassificationConflict[];
  fetchErrors: string[];
  stale: boolean;
  staleSince?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastUpdatedAt?: string;
  contentHash?: string;
}

export interface SubnetRecord {
  _id: string; // subnetId
  subnetId: string;
  isL1: boolean;
  isPermissioned: boolean | null;
  controlKeys: string[];
  threshold: number | null;
  locktime: string | null;
  conversionId: string | null;
  managerChainId: string | null;
  managerAddress: string | null;
  blockchainIds: string[];
  validatorSummary: ValidatorSummary | null;
  provenance: ProvenanceMap;
  fetchErrors: string[];
  stale: boolean;
  staleSince?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastUpdatedAt?: string;
  contentHash?: string;
}

export interface DiffReport {
  new: string[];
  changed: string[];
  wentStale: string[];
}

export interface RunReport {
  runId: string;
  network: Network;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  enumSource: EnumSource;
  enrichmentEnabled: boolean;
  totals: {
    blockchains: number;
    subnets: number;
    l1s: number;
    legacySubnets: number;
    permissioned: number;
    validators: number;
  };
  byVmType: Record<string, number>;
  byAccessTier: Record<string, number>;
  diff: {
    blockchains: DiffReport;
    subnets: DiffReport;
    validators: DiffReport;
  };
  errors: { scope: string; key: string; message: string }[];
}

// --- Data API (Glacier) shapes we consume -----------------------------------

export interface DataApiSubnet {
  subnetId: string;
  isL1?: boolean;
  l1ConversionTransactionHash?: string;
  l1ValidatorManagerDetails?: { blockchainId: string; contractAddress: string };
  blockchains?: {
    blockchainId: string;
    blockchainName?: string;
    vmId?: string;
    evmChainId?: number;
    genesisData?: unknown;
  }[];
}
