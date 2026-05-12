# IPaymentAdapter — Interface Specification

## Purpose

Defines the contract any payment rail must implement to be plugged into the OCR x402 adapter. The current implementation (`ocr-permit-v1`) is the reference.

Corresponds to x402's `SchemeNetworkFacilitator` interface.

## Interface

```typescript
interface IPaymentAdapter {
  readonly scheme: string;
  readonly network: string; // CAIP-2, e.g. "eip155:8453"

  /**
   * Return metadata for the GET /supported response.
   * Include scheme name, network, and any scheme-specific extras the client needs
   * to construct a payment payload (e.g. Asset contract address, token address).
   */
  supported(): SupportedKind;

  /**
   * Validate a payment payload without settling.
   * MUST be side-effect free and idempotent.
   * Returns { isValid: true } or { isValid: false, invalidReason: string }.
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;

  /**
   * Settle a validated payment payload on-chain.
   * MUST check the idempotency store before broadcasting.
   * Returns { success: true, txHash } or { success: false, errorReason }.
   */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}
```

## Types (re-used from x402 core)

```typescript
type PaymentRequirements = {
  scheme: string;
  network: string;
  payTo: string;       // Asset contract address in ocr-permit-v1
  asset: string;       // ERC-20 token address
  amount: string;      // Atomic units
  extra?: Record<string, unknown>;
};

type VerifyResponse =
  | { isValid: true }
  | { isValid: false; invalidReason: string };

type SettleResponse =
  | { success: true; transaction: string; network: string }
  | { success: false; errorReason: string; transaction: ""; network: string };
```

## Implementing a New Rail

1. Create `src/adapters/<name>.ts` implementing `IPaymentAdapter`.
2. Register it in `src/index.ts` alongside the existing `ocr-permit-v1` adapter.
3. `GET /supported` aggregates all registered adapters automatically.
4. Write a spec doc in `docs/` following the pattern of `ocr-permit-v1.md`.

### Required for production readiness

- Off-chain signature verification in `verify()` before any on-chain call
- Idempotency check in `settle()` using a keyed store (key = permit nonce + payer address)
- The adapter's signing key MUST NOT appear as `payer` in any token transfer
