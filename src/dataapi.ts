import { PRIMARY_NETWORK_ID } from "./pchain";
import type { DataApiSubnet, EnumeratedBlockchain, Network } from "./types";
import { DEFAULT_RETRY, TransientError, withRetry } from "./util";

/**
 * AvaCloud Data API (Glacier) client. Optional enrichment source; everything
 * here must degrade gracefully when disabled or when the key is absent.
 */
export class DataApiClient {
  constructor(
    private base: string,
    private apiKey: string | null,
  ) {}

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return withRetry(
      async () => {
        const headers: Record<string, string> = { accept: "application/json" };
        if (this.apiKey) headers["x-glacier-api-key"] = this.apiKey;
        const res = await fetch(url, { headers });
        if (res.status === 429 || res.status >= 500) {
          // honor RateLimit / Retry-After headers when present
          const ra =
            res.headers.get("retry-after") ?? res.headers.get("ratelimit-reset");
          throw new TransientError(
            `GET ${path}: HTTP ${res.status}`,
            ra ? Number(ra) * 1000 : null,
          );
        }
        if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
        return (await res.json()) as T;
      },
      { ...DEFAULT_RETRY, label: `dataapi ${path}` },
    );
  }

  /** GET /v1/chains — the set of chains the Data API indexes (drives dataApiCovered). */
  async listIndexedChains(network: Network): Promise<Record<string, unknown>[]> {
    const body = await this.get<{ chains?: Record<string, unknown>[] }>(
      "/v1/chains",
      { network },
    );
    return body.chains ?? [];
  }

  /** Paginated GET /v1/networks/{network}/blockchains — alternative enumeration source. */
  async listBlockchains(network: Network): Promise<EnumeratedBlockchain[]> {
    const out: EnumeratedBlockchain[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = { pageSize: "100" };
      if (pageToken) params.pageToken = pageToken;
      const body = await this.get<{
        blockchains?: Record<string, unknown>[];
        nextPageToken?: string;
      }>(`/v1/networks/${network}/blockchains`, params);
      for (const b of body.blockchains ?? []) {
        // Glacier includes the P-Chain itself; platform.getBlockchains does
        // not — drop it so both strategies enumerate the same set.
        if (String(b.blockchainId) === PRIMARY_NETWORK_ID) continue;
        out.push({
          blockchainId: String(b.blockchainId),
          name: b.blockchainName ? String(b.blockchainName) : null,
          subnetId: String(b.subnetId),
          vmId: b.vmId ? String(b.vmId) : null,
          source: "dataapi",
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** GET /v1/networks/{network}/subnets/{subnetId} — per-subnet enrichment. */
  async getSubnet(network: Network, subnetId: string): Promise<DataApiSubnet> {
    return this.get<DataApiSubnet>(`/v1/networks/${network}/subnets/${subnetId}`);
  }
}
