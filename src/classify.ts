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
 * §6 accessTier — a routing recommendation for downstream ingestion:
 *   A: already indexed by the Data API.
 *   B: public subnet-evm with a known public RPC.
 *   C: public subnet-evm without a convenient RPC (self-host candidate).
 *   unreachable: permissioned/private, or custom VM with no available binary.
 */
export function classifyAccessTier(opts: {
  dataApiCovered: boolean;
  vmType: VmType;
  isPermissioned: boolean | null;
  rpcEndpoints: string[];
}): AccessTier {
  if (opts.dataApiCovered) return "A";
  if (opts.isPermissioned !== false) return "unreachable"; // true or unknown
  if (opts.vmType !== "subnet-evm") return "unreachable";
  return opts.rpcEndpoints.length > 0 ? "B" : "C";
}
