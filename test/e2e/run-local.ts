/**
 * Live e2e test against a local Anvil chain.
 *
 * Prerequisites (run once before this script):
 *   1. In a separate terminal: anvil
 *   2. In open-creator-rails/: bash scripts/seed-local.sh
 *   3. In open-creator-rails.x402-adapter/:
 *        cp .env.example .env
 *        # edit .env — set ASSET_REGISTRY_ADDRESS to the value from
 *        #   ../open-creator-rails/deployments/registries_31337.json[0].address
 *        npm run dev
 *
 * Then run this script:
 *   npx tsx test/e2e/run-local.ts
 */

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const ANVIL_RPC = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
const FACILITATOR_URL = "http://localhost:3402";

// Anvil account[1] — subscriber (has tokens from seed-local.sh)
const SUBSCRIBER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

// ─── Chain client ─────────────────────────────────────────────────────────────

const chain = {
  id: CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

const publicClient = createPublicClient({ transport: http(ANVIL_RPC), chain });
const account = privateKeyToAccount(SUBSCRIBER_KEY);
const walletClient = createWalletClient({ account, transport: http(ANVIL_RPC), chain });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadDeployments() {
  const path = join(
    __dirname,
    "../../..",
    "open-creator-rails/deployments/registries_31337.json",
  );
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      "registries_31337.json is empty — run seed-local.sh first:\n  cd open-creator-rails && bash scripts/seed-local.sh",
    );
  }
  return data[0] as {
    address: `0x${string}`;
    assets: Array<{
      address: `0x${string}`;
      assetId: string;
      assetIdHash: `0x${string}`;
      tokenAddress: `0x${string}`;
    }>;
  };
}

function deriveSubscriberId(userAddress: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, address"), [
      "ocr-permit-v1",
      userAddress,
    ]),
  );
}

async function readTokenName(tokenAddress: `0x${string}`): Promise<string> {
  return (await publicClient.readContract({
    address: tokenAddress,
    abi: [{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
    functionName: "name",
  })) as string;
}

async function readPermitNonce(tokenAddress: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return (await publicClient.readContract({
    address: tokenAddress,
    abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "nonces",
    args: [owner],
  })) as bigint;
}

async function readSubscriptionPrice(assetAddress: `0x${string}`, count: bigint): Promise<bigint> {
  return (await publicClient.readContract({
    address: assetAddress,
    abi: [{ type: "function", name: "getSubscriptionPrice", stateMutability: "view", inputs: [{ name: "count", type: "uint256" }], outputs: [{ type: "uint256" }] }],
    functionName: "getSubscriptionPrice",
    args: [count],
  })) as bigint;
}

async function isSubscriptionActive(assetAddress: `0x${string}`, subscriberId: `0x${string}`): Promise<boolean> {
  return (await publicClient.readContract({
    address: assetAddress,
    abi: [{ type: "function", name: "isSubscriptionActive", stateMutability: "view", inputs: [{ name: "subscriber", type: "bytes32" }], outputs: [{ type: "bool" }] }],
    functionName: "isSubscriptionActive",
    args: [subscriberId],
  })) as boolean;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function ok(label: string) {
  console.log(`  ✓ ${label}`);
}

function fail(label: string, detail: unknown) {
  console.error(`  ✗ ${label}`);
  console.error("   ", detail);
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== OCR x402 Adapter — Local E2E Test ===\n");

  // 1. Load deployed addresses
  console.log("1. Loading deployments...");
  const deployment = loadDeployments();
  const asset = deployment.assets.find((a) => a.assetId === "local_asset_1");
  if (!asset) {
    fail("local_asset_1 not found in registries_31337.json", deployment.assets.map((a) => a.assetId));
  }
  const assetAddress = asset!.address;
  const tokenAddress = asset!.tokenAddress;
  ok(`Registry:  ${deployment.address}`);
  ok(`Asset:     ${assetAddress} (local_asset_1)`);
  ok(`Token:     ${tokenAddress}`);
  ok(`Payer:     ${account.address}`);

  // 2. Check facilitator is up
  console.log("\n2. Checking facilitator health...");
  try {
    const health = await fetch(`${FACILITATOR_URL}/health`);
    if (!health.ok) throw new Error(`health returned ${health.status}`);
    ok(`Facilitator at ${FACILITATOR_URL} is up`);
  } catch (e) {
    fail("Facilitator is not running — start it first: npm run dev", e);
  }

  // 3. Check /supported
  console.log("\n3. GET /supported...");
  const supported = await fetch(`${FACILITATOR_URL}/supported`).then((r) => r.json()) as any;
  const kind = supported.kinds?.find((k: any) => k.scheme === "ocr-permit-v1");
  if (!kind) fail("/supported does not include ocr-permit-v1", supported);
  ok(`scheme: ${kind.scheme}, network: ${kind.network}`);

  // 4. Sign an EIP-2612 permit
  console.log("\n4. Signing EIP-2612 permit...");
  const count = 1n;
  const value = await readSubscriptionPrice(assetAddress, count);
  const permitNonce = await readPermitNonce(tokenAddress, account.address);
  const tokenName = await readTokenName(tokenAddress);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const signatureHex = await walletClient.signTypedData({
    account,
    domain: {
      name: tokenName,
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: tokenAddress,
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
    primaryType: "Permit",
    message: {
      owner: account.address,
      spender: assetAddress,
      value,
      nonce: permitNonce,
      deadline,
    },
  });

  const v = parseInt(signatureHex.slice(-2), 16);
  const r = signatureHex.slice(0, 66) as `0x${string}`;
  const s = ("0x" + signatureHex.slice(66, 130)) as `0x${string}`;
  const subscriberId = deriveSubscriberId(account.address);

  ok(`Token name: ${tokenName}`);
  ok(`Permit nonce: ${permitNonce}`);
  ok(`Amount: ${value} (${count} period)`);
  ok(`Subscriber ID: ${subscriberId}`);

  const paymentPayload = {
    x402Version: 1,
    scheme: "ocr-permit-v1",
    network: `eip155:${CHAIN_ID}`,
    payload: {
      subscriberId,
      payer: account.address,
      count: Number(count),
      deadline: Number(deadline),
      permitNonce: Number(permitNonce),
      v,
      r,
      s,
    },
    requirements: {
      payTo: assetAddress,
      asset: tokenAddress,
      amount: value.toString(),
    },
  };

  // 5. POST /verify
  console.log("\n5. POST /verify...");
  const verifyResult = await post("/verify", paymentPayload) as any;
  if (!verifyResult.isValid) fail("verify rejected", verifyResult);
  ok("isValid: true");

  // 6. POST /settle
  console.log("\n6. POST /settle...");
  const settleResult = await post("/settle", paymentPayload) as any;
  if (!settleResult.success) fail("settle failed", settleResult);
  ok(`success: true`);
  ok(`txHash: ${settleResult.transaction}`);

  // 7. Verify subscription is active on-chain
  console.log("\n7. Checking on-chain subscription state...");
  const active = await isSubscriptionActive(assetAddress, subscriberId);
  if (!active) fail("subscription is NOT active on-chain after settlement", { subscriberId, assetAddress });
  ok("isSubscriptionActive: true");

  // 8. Idempotency — second settle should return cached result without reverting
  console.log("\n8. Idempotency check (second POST /settle)...");
  const settleResult2 = await post("/settle", paymentPayload) as any;
  if (!settleResult2.success) fail("idempotency: second settle returned failure", settleResult2);
  if (settleResult2.transaction !== settleResult.transaction) {
    fail("idempotency: second settle returned a different tx hash (double broadcast!)", settleResult2);
  }
  ok("returned same txHash — no double broadcast");

  console.log("\n=== All checks passed ===\n");
}

main().catch((e) => {
  console.error("\nUnhandled error:", e);
  process.exit(1);
});
