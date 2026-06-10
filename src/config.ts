import "dotenv/config";
import { z } from "zod";

function trimEnv(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

const envSchema = z.object({
  RPC_URL: z.preprocess(trimEnv, z.string().url()),
  PRIVATE_KEY: z.preprocess(
    trimEnv,
    z.string().regex(/^0x[0-9a-fA-F]{64}$/, "PRIVATE_KEY must be a 0x-prefixed 32-byte hex"),
  ),
  ASSET_REGISTRY_ADDRESS: z.preprocess(
    trimEnv,
    z.string().regex(/^0x[0-9a-fA-F]{40}$/i, "ASSET_REGISTRY_ADDRESS must be a 0x-prefixed 20-byte hex address"),
  ),
  PORT: z.coerce.number().default(3402),
  CHAIN_ID: z.coerce.number().default(84532), // Base Sepolia default
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuration error:\n${missing}`);
  }
  return result.data;
}
