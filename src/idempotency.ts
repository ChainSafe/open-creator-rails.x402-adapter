import type { Address } from "viem";

export type SettleResult = {
  success: boolean;
  transaction: string;
  network: string;
  errorReason?: string;
};

/**
 * In-memory idempotency store keyed by (payer, permitNonce).
 *
 * A permit nonce is consumed on-chain the first time it is used. Any second broadcast
 * with the same nonce will revert. The store lets us return the cached result without
 * wasting gas on a known-failed retry.
 *
 * LIMITATION: Lost on process restart. Swap for Redis or a persistent store before
 * running in production.
 */
const store = new Map<string, SettleResult>();

function key(payer: Address, permitNonce: bigint): string {
  return `${payer.toLowerCase()}:${permitNonce.toString()}`;
}

export function getSettled(payer: Address, permitNonce: bigint): SettleResult | undefined {
  return store.get(key(payer, permitNonce));
}

export function markSettled(payer: Address, permitNonce: bigint, result: SettleResult): void {
  store.set(key(payer, permitNonce), result);
}
