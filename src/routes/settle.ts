import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PublicClient, Hex } from "viem";
import { deriveSubscriberId } from "../subscriber.js";
import { getSettled, markSettled } from "../idempotency.js";
import { verifyPermitSignature } from "../permit.js";
import type { Config } from "../config.js";

const assetAbi = parseAbi([
  "function subscribe(bytes32 subscriber, address payer, address spender, uint256 count, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external returns (uint256)",
]);

const payloadSchema = z.object({
  x402Version: z.literal(1),
  scheme: z.literal("ocr-permit-v1"),
  network: z.string(),
  payload: z.object({
    subscriberId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
    count: z.number().int().min(1),
    deadline: z.number().int().positive(),
    permitNonce: z.number().int().min(0),
    v: z.number().int().min(27).max(28),
    r: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>,
    s: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>,
  }),
  requirements: z.object({
    payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
    asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
    amount: z.string(),
  }),
});

export function settleRouter(config: Config, publicClient: PublicClient): Hono {
  const account = privateKeyToAccount(config.PRIVATE_KEY as Hex);
  const walletClient = createWalletClient({
    account,
    transport: http(config.RPC_URL),
    chain: {
      id: config.CHAIN_ID,
      name: "ocr",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.RPC_URL] } },
    },
  });

  const network = `eip155:${config.CHAIN_ID}`;
  const app = new Hono();

  app.post("/", zValidator("json", payloadSchema), async (c) => {
    const body = c.req.valid("json");
    const { payload, requirements } = body;
    const assetAddress = requirements.payTo;

    // 1. Idempotency check
    const cached = getSettled(payload.payer, BigInt(payload.permitNonce));
    if (cached) {
      return c.json(cached);
    }

    // 2. Facilitator must not be the payer
    if (account.address.toLowerCase() === payload.payer.toLowerCase()) {
      return c.json(
        { success: false, transaction: "", network, errorReason: "facilitator address cannot be payer" },
        400,
      );
    }

    // 3. Re-verify permit off-chain before broadcasting
    const verifyResult = await verifyPermitSignature(
      {
        payer: payload.payer,
        spender: assetAddress,
        value: BigInt(requirements.amount),
        deadline: BigInt(payload.deadline),
        permitNonce: BigInt(payload.permitNonce),
        v: payload.v,
        r: payload.r,
        s: payload.s,
      },
      requirements.asset,
      config.CHAIN_ID,
      publicClient,
    );

    if (!verifyResult.valid) {
      const result = {
        success: false,
        transaction: "",
        network,
        errorReason: verifyResult.reason ?? "permit verification failed",
      };
      markSettled(payload.payer, BigInt(payload.permitNonce), result);
      return c.json(result, 400);
    }

    // 4. Derive subscriber ID and verify it matches what the client sent
    const subscriberId = deriveSubscriberId(payload.payer);
    if (subscriberId.toLowerCase() !== payload.subscriberId.toLowerCase()) {
      return c.json(
        { success: false, transaction: "", network, errorReason: `subscriberId mismatch: expected ${subscriberId}` },
        400,
      );
    }

    // 5. Broadcast Asset.subscribe()
    //    payer   = user wallet — never the facilitator
    //    spender = assetAddress — enforced by _validatePermit to equal address(this)
    try {
      const txHash = await walletClient.writeContract({
        address: assetAddress,
        abi: assetAbi,
        functionName: "subscribe",
        account,
        args: [
          subscriberId as Hex,
          payload.payer,
          assetAddress,
          BigInt(payload.count),
          BigInt(payload.deadline),
          payload.v,
          payload.r,
          payload.s,
        ],
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });

      const result = { success: true, transaction: txHash, network };
      markSettled(payload.payer, BigInt(payload.permitNonce), result);
      return c.json(result);
    } catch (err) {
      const errorReason = err instanceof Error ? err.message : "unknown error";
      const result = { success: false, transaction: "", network, errorReason };
      markSettled(payload.payer, BigInt(payload.permitNonce), result);
      return c.json(result, 500);
    }
  });

  return app;
}
