import { Hono } from "hono";
import type { Config } from "../config.js";

export function supportedRouter(config: Config): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({
      kinds: [
        {
          x402Version: 1,
          scheme: "ocr-permit-v1",
          network: `eip155:${config.CHAIN_ID}`,
          extra: {
            assetRegistryAddress: config.ASSET_REGISTRY_ADDRESS,
          },
        },
      ],
    });
  });

  return app;
}
