# Integration Guide — Adding a Payment Rail

This guide walks through adding a new payment rail to the OCR x402 adapter. It covers both crypto and card/fiat paths. Read `IPaymentAdapter.md` first — specifically the custody decision tree.

## Prerequisites

- You have read `architecture.md` and understand the payment layer / entitlement layer separation
- You have completed the custody classification for your rail
- If your rail is custodial: legal review is complete before you write any code

---

## Adding a Crypto Rail

A crypto rail is non-custodial: the user's funds move directly to the Asset contract. The Facilitator is a pure broadcaster.

### Step 1 — Write the spec doc

Create `docs/<your-scheme>.md` following the structure of `ocr-permit-v1.md`:

- Summary and use case
- `PaymentRequired` payload structure (what the client receives in the 402 response)
- X-Payment header payload (what the client sends back)
- Verification steps (what `verify()` checks off-chain)
- Settlement steps (what `settle()` does on-chain)
- Idempotency key (what uniquely identifies this payment attempt)
- Limitations

Write this doc before any code. It is the spec your implementation is tested against.

### Step 2 — Implement the adapter

Create `src/adapters/<your-scheme>.ts`:

```typescript
import type { PublicClient } from "viem";
import type { Config } from "../config.js";

// Replace these with your scheme's actual payload and requirements types
type YourPayload = {
  payer: `0x${string}`;
  // ... scheme-specific fields
};

type YourRequirements = {
  payTo: `0x${string}`;  // Asset contract address
  asset: `0x${string}`;  // ERC-20 token address
  amount: string;
  // ... scheme-specific fields
};

export function createYourSchemeAdapter(config: Config, publicClient: PublicClient) {
  return {
    scheme: "your-scheme-name",
    network: `eip155:${config.CHAIN_ID}`,

    supported() {
      return {
        x402Version: 1,
        scheme: "your-scheme-name",
        network: `eip155:${config.CHAIN_ID}`,
        extra: {
          // any metadata the client needs to construct a payment payload
        },
      };
    },

    async verify(payload: YourPayload, requirements: YourRequirements) {
      // 1. Check idempotency store — return cached result if already settled
      // 2. Validate the payment proof off-chain (sig check, API call, etc.)
      // 3. Confirm facilitator is not the payer
      // 4. Return { isValid: true } or { isValid: false, invalidReason: "..." }
      throw new Error("TODO: implement verify");
    },

    async settle(payload: YourPayload, requirements: YourRequirements) {
      // 1. Check idempotency store — return cached result if already settled
      // 2. Re-run verify() before broadcasting
      // 3. Call Asset.subscribe() with the user's payment proof
      //    payer MUST be the user's address, never the facilitator's
      // 4. Mark settled in idempotency store
      // 5. Return { success: true, transaction: txHash, network } or failure shape
      throw new Error("TODO: implement settle");
    },
  };
}
```

### Step 3 — Register in `src/index.ts`

Mount the adapter's routes alongside the existing `ocr-permit-v1` routes. Update `/supported` to include the new scheme.

### Step 4 — Write tests

Add `test/e2e/<your-scheme>.test.ts` covering:
- Happy path: verify + settle succeeds
- Idempotency: second settle call returns cached result
- Failure: invalid proof is rejected at verify

Cross-check the subscriber ID derivation against the TypeScript reference in `test/e2e/flow.test.ts`.

---

## Adding a Card / Fiat Rail (e.g. Stripe)

A fiat rail is structurally different. Stripe confirms payment off-chain; the Facilitator must then call `Asset.subscribe()` on-chain. To do this, the Facilitator needs tokens available — either pre-funded or acquired at settlement time. **This creates a custody event.**

### The structural problem

```
Stripe confirms payment
        │
        ▼
Facilitator wallet needs tokens    ← Facilitator holds funds here
        │
        ▼
Asset.subscribe() called
  payer = Facilitator address      ← violates facilitator_never_payer invariant
        │
        ▼
Subscription active
```

The `facilitator_never_payer` invariant in `.invariants` is FROZEN. It cannot be bypassed. A fiat rail requires either:

a) **Violating the invariant** — not allowed without a protocol-level decision and major version bump.

b) **A pre-authorisation model** — the user pre-approves a token allowance to the Facilitator before paying via Stripe. The Facilitator then calls `subscribe()` using `transferFrom` (payer = user's address, allowance = previously granted). The Stripe payment covers the fiat cost; the on-chain allowance covers the token cost. This is complex and requires the user to take two separate actions.

c) **Off-chain subscription with on-chain attestation** — Stripe payment is recorded off-chain; a trusted oracle writes the subscription state on-chain. This bypasses `Asset.subscribe()` entirely and is outside the scope of this adapter.

### What to document if you pursue option (b)

Your rail spec doc (`docs/<your-scheme>.md`) MUST include:

1. The full sequence: user grants allowance → user pays Stripe → Facilitator calls subscribe
2. The custody window: between Stripe confirmation and chain settlement, what does the Facilitator hold?
3. The failure mode: Stripe confirms but chain settlement fails — what is the refund path?
4. The legal classification completed before implementation starts

### What this adapter does not do

This adapter does not implement a fiat bridge. The `ocr-permit-v1` scheme is the reference implementation. If you need fiat payments, the cleanest path is:

1. Accept fiat off-chain (Stripe)
2. Convert fiat to stablecoin off-chain (your backend, a CEX, or a payment processor that outputs stablecoin)
3. User receives stablecoin in their wallet
4. User subscribes via `ocr-permit-v1` (or directly)

This keeps the Facilitator non-custodial and the on-chain flow identical.
