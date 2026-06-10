import type { Network } from "./types";

export interface ProbeResult {
  url: string;
  ok: boolean;
  chainId: number | null;
}

/**
 * Best-effort liveness probe: eth_chainId with a short timeout, no retries.
 * A candidate counts as verified only if it answers with a parseable chain id
 * (callers additionally require it to match the expected evmChainId).
 */
export async function probeRpc(url: string, timeoutMs = 5000): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { url, ok: false, chainId: null };
    const body = (await res.json()) as { result?: unknown };
    if (typeof body.result !== "string" || !body.result.startsWith("0x")) {
      return { url, ok: false, chainId: null };
    }
    return { url, ok: true, chainId: Number.parseInt(body.result, 16) };
  } catch {
    return { url, ok: false, chainId: null };
  }
}

/**
 * Candidate endpoints for a chain: the config-known list plus the AvaCloud
 * public gateway pattern derived from the chain name
 * (https://subnets.avax.network/<slug>/<network>/rpc).
 */
export function candidateUrls(
  name: string | null,
  network: Network,
  known: string[],
): string[] {
  const out = [...known];
  if (name) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) out.push(`https://subnets.avax.network/${slug}/${network}/rpc`);
  }
  return [...new Set(out)];
}
