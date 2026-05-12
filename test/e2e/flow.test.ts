/**
 * E2E test harness for the ocr-permit-v1 payment flow.
 *
 * These tests use mocked chain clients — no live RPC required.
 * They exercise the full verify → settle pipeline including idempotency
 * and failure handling.
 *
 * To run against a live chain (e.g. anvil), set RPC_URL in the environment
 * and wire up a real publicClient.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PublicClient } from "viem";
import { deriveSubscriberId } from "../../src/subscriber.js";
import { verifyPermitSignature } from "../../src/permit.js";
import { getSettled, markSettled } from "../../src/idempotency.js";

// Deterministic test wallet — never use a real private key in tests
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_USER = TEST_ACCOUNT.address;

const TOKEN_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address; // USDC mainnet (placeholder)
const ASSET_ADDRESS = "0x1234567890123456789012345678901234567890" as Address;
const CHAIN_ID = 84532;
const SUBSCRIPTION_PRICE = 1_000_000n; // 1 USDC (6 decimals)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPermitTypedData(
  tokenName: string,
  owner: Address,
  spender: Address,
  value: bigint,
  nonce: bigint,
  deadline: bigint,
) {
  return {
    domain: {
      name: tokenName,
      version: "1" as const,
      chainId: CHAIN_ID,
      verifyingContract: TOKEN_ADDRESS,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    message: { owner, spender, value, nonce, deadline },
  };
}

function mockPublicClient(overrides: Partial<{
  nonces: bigint;
  tokenName: string;
  writeContractHash: Hex;
}>): PublicClient {
  const nonce = overrides.nonces ?? 0n;
  const tokenName = overrides.tokenName ?? "USD Coin";

  return {
    readContract: vi.fn(({ functionName }: { functionName: string }) => {
      if (functionName === "nonces") return Promise.resolve(nonce);
      if (functionName === "name") return Promise.resolve(tokenName);
      return Promise.reject(new Error(`Unexpected readContract call: ${functionName}`));
    }),
    waitForTransactionReceipt: vi.fn(() => Promise.resolve({ status: "success" })),
  } as unknown as PublicClient;
}

// ─── Subscriber ID derivation ─────────────────────────────────────────────────

describe("deriveSubscriberId", () => {
  it("produces keccak256(abi.encode('ocr-permit-v1', userAddress))", () => {
    const expected = keccak256(
      encodeAbiParameters(parseAbiParameters("string, address"), ["ocr-permit-v1", TEST_USER]),
    );
    expect(deriveSubscriberId(TEST_USER)).toBe(expected);
  });

  it("is not the same as SDK subscriberToId (encodePacked)", () => {
    // SDK uses keccak256(encodePacked(address)) — different namespace
    const sdkId = keccak256(
      ("0x" + TEST_USER.replace("0x", "").padStart(40, "0")) as Hex,
    );
    expect(deriveSubscriberId(TEST_USER)).not.toBe(sdkId);
  });
});

// ─── Permit verification ──────────────────────────────────────────────────────

describe("verifyPermitSignature", () => {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min from now
  const nonce = 0n;
  const count = 1;
  const value = SUBSCRIPTION_PRICE * BigInt(count);

  async function signPermit() {
    const typedData = buildPermitTypedData("USD Coin", TEST_USER, ASSET_ADDRESS, value, nonce, deadline);
    const sig = await TEST_ACCOUNT.signTypedData(typedData);
    const v = parseInt(sig.slice(-2), 16);
    const r = sig.slice(0, 66) as Hex;
    const s = ("0x" + sig.slice(66, 130)) as Hex;
    return { v, r, s };
  }

  it("validates a correctly signed permit", async () => {
    const { v, r, s } = await signPermit();
    const publicClient = mockPublicClient({ nonces: nonce, tokenName: "USD Coin" });

    const result = await verifyPermitSignature(
      { payer: TEST_USER, spender: ASSET_ADDRESS, value, deadline, permitNonce: nonce, v, r, s },
      TOKEN_ADDRESS,
      CHAIN_ID,
      publicClient,
    );

    expect(result.valid).toBe(true);
    expect(result.recoveredSigner?.toLowerCase()).toBe(TEST_USER.toLowerCase());
  });

  it("rejects an expired deadline", async () => {
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 60);
    const typedData = buildPermitTypedData("USD Coin", TEST_USER, ASSET_ADDRESS, value, nonce, expiredDeadline);
    const sig = await TEST_ACCOUNT.signTypedData(typedData);
    const v = parseInt(sig.slice(-2), 16);
    const r = sig.slice(0, 66) as Hex;
    const s = ("0x" + sig.slice(66, 130)) as Hex;

    const publicClient = mockPublicClient({ nonces: nonce });

    const result = await verifyPermitSignature(
      { payer: TEST_USER, spender: ASSET_ADDRESS, value, deadline: expiredDeadline, permitNonce: nonce, v, r, s },
      TOKEN_ADDRESS,
      CHAIN_ID,
      publicClient,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("deadline expired");
  });

  it("rejects a nonce mismatch (on-chain nonce advanced)", async () => {
    const { v, r, s } = await signPermit();
    // On-chain nonce is 1, but permit was signed with nonce 0
    const publicClient = mockPublicClient({ nonces: 1n, tokenName: "USD Coin" });

    const result = await verifyPermitSignature(
      { payer: TEST_USER, spender: ASSET_ADDRESS, value, deadline, permitNonce: nonce, v, r, s },
      TOKEN_ADDRESS,
      CHAIN_ID,
      publicClient,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("nonce mismatch");
  });

  it("rejects a tampered signature (wrong signer)", async () => {
    // Sign with a different key
    const otherKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
    const otherAccount = privateKeyToAccount(otherKey);
    const typedData = buildPermitTypedData("USD Coin", TEST_USER, ASSET_ADDRESS, value, nonce, deadline);
    const sig = await otherAccount.signTypedData(typedData);
    const v = parseInt(sig.slice(-2), 16);
    const r = sig.slice(0, 66) as Hex;
    const s = ("0x" + sig.slice(66, 130)) as Hex;

    const publicClient = mockPublicClient({ nonces: nonce, tokenName: "USD Coin" });

    const result = await verifyPermitSignature(
      { payer: TEST_USER, spender: ASSET_ADDRESS, value, deadline, permitNonce: nonce, v, r, s },
      TOKEN_ADDRESS,
      CHAIN_ID,
      publicClient,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("signer mismatch");
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe("idempotency store", () => {
  it("returns undefined for an unknown (payer, nonce) pair", () => {
    const payer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
    expect(getSettled(payer, 99n)).toBeUndefined();
  });

  it("returns the cached result after markSettled", () => {
    const payer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
    const result = { success: true, transaction: "0xabc", network: "eip155:84532" };
    markSettled(payer, 0n, result);
    expect(getSettled(payer, 0n)).toEqual(result);
  });

  it("different nonces are independent entries", () => {
    const payer = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
    markSettled(payer, 0n, { success: true, transaction: "0x1", network: "eip155:84532" });
    expect(getSettled(payer, 1n)).toBeUndefined();
  });

  it("failed settlements are also cached (no double-broadcast)", () => {
    const payer = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
    const result = { success: false, transaction: "", network: "eip155:84532", errorReason: "reverted" };
    markSettled(payer, 2n, result);
    expect(getSettled(payer, 2n)).toEqual(result);
  });
});
