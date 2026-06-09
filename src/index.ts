import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { loadConfig } from "./config.js";
import { buildPublicClient } from "./permit.js";
import { supportedRouter } from "./routes/supported.js";
import { verifyRouter } from "./routes/verify.js";
import { settleRouter } from "./routes/settle.js";

const config = loadConfig();
const facilitatorAddress = privateKeyToAccount(config.PRIVATE_KEY as Hex).address;
const publicClient = buildPublicClient(config.RPC_URL, config.CHAIN_ID);

const app = new Hono();

app.route("/supported", supportedRouter(config));
app.route("/verify", verifyRouter(config, publicClient));
app.route("/settle", settleRouter(config, publicClient));

app.get("/health", (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: config.PORT }, () => {
  console.log(`x402-adapter listening on :${config.PORT}`);
  console.log(`Facilitator (pays gas only): ${facilitatorAddress}`);
  console.log(`Do not subscribe with this wallet — use a different MetaMask account as payer.`);
});
