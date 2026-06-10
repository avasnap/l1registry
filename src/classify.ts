import type { AccessTier, VmType } from "./types";
import { PRIMARY_NETWORK_ID } from "./pchain";

/** Canonical Subnet-EVM VM ID (CB58 of "subnetevm" zero-padded to 32 bytes). */
export const SUBNET_EVM_VMID = "srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy";

export function classifyVmType(vmId: string | null): VmType {
  if (!vmId) return "unknown";
  return vmId === SUBNET_EVM_VMID ? "subnet-evm" : "custom";
}

/**
 * §6: isL1 ⇔ conversionID set (and not the zero/empty ID) OR managerAddress set.
 */
export function classifyIsL1(
  conversionId: string | null,
  managerAddress: string | null,
): boolean {
  const hasConversion =
    conversionId !== null && conversionId !== "" && conversionId !== PRIMARY_NETWORK_ID;
  return hasConversion || (managerAddress !== null && managerAddress !== "");
}

/**
 * A chain counts as EVM if it runs the canonical Subnet-EVM VMID or if the
 * Data API reports an EVM chain id for it — many chains run modified/forked
 * Subnet-EVM builds under their own vmId but are ordinary EVM chains.
 */
export function classifyIsEvm(vmType: VmType, evmChainId: number | null): boolean {
  return vmType === "subnet-evm" || evmChainId !== null;
}

/**
 * §6 accessTier — a routing recommendation for downstream ingestion:
 *   A: already indexed by the Data API.
 *   B: public EVM chain with a known public RPC.
 *   C: public EVM chain without a convenient RPC (self-host candidate).
 *   unreachable: permissioned/private, or non-EVM VM with no available binary.
 * Keyed on isEvm (not vmType) so modified Subnet-EVM forks classify as
 * reachable; without Data API enrichment they degrade to unreachable since
 * the EVM signal is unavailable.
 */
export function classifyAccessTier(opts: {
  dataApiCovered: boolean;
  isEvm: boolean;
  isPermissioned: boolean | null;
  rpcEndpoints: string[];
}): AccessTier {
  if (opts.dataApiCovered) return "A";
  if (opts.isPermissioned !== false) return "unreachable"; // true or unknown
  if (!opts.isEvm) return "unreachable";
  return opts.rpcEndpoints.length > 0 ? "B" : "C";
}
