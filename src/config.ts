import { z } from "zod";

const envSchema = z.object({
  RPC_URL: z.string().url(),
  PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "PRIVATE_KEY must be a 0x-prefixed 32-byte hex"),
  ASSET_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "ASSET_REGISTRY_ADDRESS must be a checksummed address"),
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
