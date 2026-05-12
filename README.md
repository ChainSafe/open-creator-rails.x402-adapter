# open-creator-rails.x402-adapter

x402 Facilitator for Open Creator Rails. Implements the `ocr-permit-v1` payment scheme: accepts an EIP-2612 permit signed by the user and calls `Asset.subscribe()` on-chain. The Facilitator pays gas; tokens flow directly from the user's wallet to the Asset contract.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — flow, component map, non-custodial proof
- [`docs/ocr-permit-v1.md`](docs/ocr-permit-v1.md) — scheme spec: payload, subscriber ID derivation, verify/settle logic
- [`docs/IPaymentAdapter.md`](docs/IPaymentAdapter.md) — interface for adding future payment rails
- [`docs/security.md`](docs/security.md) — threat model, regulatory note, production checklist

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/supported` | Returns supported schemes and networks |
| `POST` | `/verify` | Validates a payment payload off-chain |
| `POST` | `/settle` | Broadcasts `Asset.subscribe()` on-chain |
| `GET` | `/health` | Liveness check |

## Setup

```bash
cp .env.example .env
# fill in .env
npm install
npm run dev
```

## Environment

| Variable | Description |
|----------|-------------|
| `RPC_URL` | HTTP RPC endpoint for the target chain |
| `PRIVATE_KEY` | Facilitator signing key (pays gas, never payer) |
| `ASSET_REGISTRY_ADDRESS` | Deployed `AssetRegistry` contract address |
| `CHAIN_ID` | Chain ID (default: `84532` — Base Sepolia) |
| `PORT` | HTTP port (default: `3402`) |

## Test

```bash
npm test
```

## Invariants

See [`.invariants`](.invariants). Key constraints:

- `facilitator_never_payer` (FROZEN) — Facilitator address must never appear as `payer` in any `Asset.subscribe()` call
- `cancel_not_called` (FROZEN) — Adapter never calls `Asset.cancelSubscription()`
