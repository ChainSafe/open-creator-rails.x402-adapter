import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { PublicClient } from "viem";
import { verifyPermitSignature } from "../permit.js";
import { getSettled } from "../idempotency.js";
import type { Config } from "../config.js";

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

export function verifyRouter(config: Config, publicClient: PublicClient): Hono {
  const app = new Hono();

  app.post("/", zValidator("json", payloadSchema), async (c) => {
    const body = c.req.valid("json");
    const { payload, requirements } = body;

    // Check idempotency — already settled means already valid
    const cached = getSettled(payload.payer, BigInt(payload.permitNonce));
    if (cached?.success) {
      return c.json({ isValid: true });
    }

    // Spender must be the Asset contract (payTo)
    if (payload.payer.toLowerCase() === config.PRIVATE_KEY.slice(0, 42).toLowerCase()) {
      return c.json({ isValid: false, invalidReason: "payer must not be the facilitator" });
    }

    const result = await verifyPermitSignature(
      {
        payer: payload.payer,
        spender: requirements.payTo, // Asset contract — enforced by _validatePermit
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

    if (!result.valid) {
      return c.json({ isValid: false, invalidReason: result.reason });
    }

    return c.json({ isValid: true });
  });

  return app;
}
