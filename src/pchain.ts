import type { EnumeratedBlockchain, PChainSubnetInfo } from "./types";
import { DEFAULT_RETRY, TransientError, withRetry } from "./util";

/** Subnet ID of the Primary Network — also the "empty" ID in getSubnet responses. */
export const PRIMARY_NETWORK_ID = "11111111111111111111111111111111LpoYY";

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export class PChainClient {
  private nextSlot = 0;

  constructor(
    private url: string,
    /** minimum spacing between request starts — keeps public RPCs happy */
    private minIntervalMs = 150,
  ) {}

  /** Serialize request starts so concurrent callers stay under the rate limit. */
  private async pace(): Promise<void> {
    const now = Date.now();
    this.nextSlot = Math.max(this.nextSlot + this.minIntervalMs, now);
    const wait = this.nextSlot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private async call<T>(method: string, params: object): Promise<T> {
    return withRetry(
      async () => {
        await this.pace();
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (res.status === 429 || res.status >= 500) {
          const ra = res.headers.get("retry-after");
          throw new TransientError(
            `${method}: HTTP ${res.status}`,
            ra ? Number(ra) * 1000 : null,
          );
        }
        if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
        const body = (await res.json()) as JsonRpcResponse<T>;
        if (body.error) {
          throw new Error(`${method}: RPC error ${body.error.code}: ${body.error.message}`);
        }
        return body.result as T;
      },
      { ...DEFAULT_RETRY, label: method },
    );
  }

  async getBlockchains(): Promise<EnumeratedBlockchain[]> {
    const result = await this.call<{
      blockchains: { id: string; name: string; subnetID: string; vmID: string }[];
    }>("platform.getBlockchains", {});
    return (result.blockchains ?? []).map((b) => ({
      blockchainId: b.id,
      name: b.name ?? null,
      subnetId: b.subnetID,
      vmId: b.vmID ?? null,
      source: "pchain" as const,
    }));
  }

  async getSubnet(subnetID: string): Promise<{ info: PChainSubnetInfo; raw: unknown }> {
    const raw = await this.call<Record<string, unknown>>("platform.getSubnet", {
      subnetID,
    });
    const str = (k: string): string | null =>
      raw[k] === undefined || raw[k] === null || raw[k] === "" ? null : String(raw[k]);
    return {
      info: {
        isPermissioned: Boolean(raw.isPermissioned),
        controlKeys: (raw.controlKeys as string[]) ?? [],
        threshold: raw.threshold === undefined ? null : Number(raw.threshold),
        locktime: str("locktime"),
        subnetTransformationTxID: str("subnetTransformationTxID"),
        conversionID: str("conversionID"),
        managerChainID: str("managerChainID"),
        managerAddress: str("managerAddress"),
      },
      raw,
    };
  }

  /**
   * Returns the raw validator array. Shape differs between permissioned/primary
   * subnets and converted L1s; normalization happens in sync.ts.
   */
  async getCurrentValidators(subnetID: string): Promise<Record<string, unknown>[]> {
    const result = await this.call<{ validators: Record<string, unknown>[] }>(
      "platform.getCurrentValidators",
      { subnetID },
    );
    return result.validators ?? [];
  }
}
