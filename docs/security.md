# Security

## Non-Custodial Proof

The Facilitator cannot hold, redirect, or steal user tokens. Here is why:

1. **Permit target is the Asset contract, not the Facilitator.** The EIP-2612 permit is signed with `spender = Asset contract address`. `Asset._validatePermit` enforces `if (spender != address(this)) revert InvalidSpender()`. Any attempt by the Facilitator to redirect the permit to its own address would fail on-chain.

2. **`safeTransferFrom` runs inside the Asset contract.** After the permit succeeds, `SafeERC20.safeTransferFrom(token, payer, address(this), amount)` runs inside `Asset._validatePermit`. The Asset contract is the recipient. The Facilitator's private key has no role in this transfer.

3. **Facilitator pays gas only.** The Facilitator's signing key appears only as the `msg.sender` of the outer `subscribe()` call, which determines who pays gas. It does not appear as payer, owner, spender, or recipient of any token transfer.

4. **`facilitator_never_payer` invariant is FROZEN.** Any code change that places the Facilitator's address as `payer` in `subscribe()` is blocked by `.invariants`. This is machine-verifiable.

**Fund flow:**
```
User wallet  ──[permit + transferFrom]──>  Asset contract
Facilitator  ──[pays gas]──────────────>  Blockchain
```

## Regulatory Note (BaFin / MiCA)

The non-custodial design means the Facilitator:
- Never holds user funds, even transiently
- Cannot initiate token transfers independently
- Acts as a transaction relayer, not a payment processor

Under current BaFin interpretation and MiCA Article 3, a pure transaction relayer that does not control or hold assets does not trigger VASP (Virtual Asset Service Provider) licensing requirements. **This is not legal advice.** Consult counsel before operating commercially in Germany or the EU.

## Replay Attack Prevention

**On-chain:** EIP-2612 nonces on the token contract are strictly monotonic. A consumed nonce causes `permit()` to revert with `ERC20Permit: invalid signature`. A replayed payload cannot succeed on-chain.

**Off-chain (pre-broadcast):** `verify.ts` cross-checks `payload.permitNonce` against the current on-chain nonce before accepting. A nonce that has already been consumed will not pass verification.

**Idempotency store:** `settle.ts` records every `(payer, permitNonce)` result before and after broadcast. A retry returns the cached result without re-broadcasting. This prevents gas waste and avoids race conditions on retry.

## What the Facilitator Can Do (Threat Model)

| Action | Possible? | Mitigated by |
|--------|-----------|--------------|
| Steal tokens | No | `spender` enforced by contract |
| Redirect payment | No | `payTo` = Asset contract, enforced |
| Censor a payment (block it) | Yes | Operator trust; use a non-custodial Facilitator or run your own |
| Double-settle a nonce | No | Idempotency store + on-chain nonce |
| Front-run a permit | Theoretical | Permit is already targeted to a specific asset/payer/amount; front-running settles the same subscription, not a different one |
| Drain the Facilitator's gas wallet | DoS only | Protect `/settle` behind auth or rate-limiting in production |

## Security Requirements for New Rail Implementations

Any rail added to this adapter MUST satisfy the following before shipping. These apply regardless of whether the rail is crypto or fiat.

### 1. Custody classification documented

Complete the decision tree in `IPaymentAdapter.md` before writing any code. If the rail is custodial, the custody window, failure modes, and legal classification must be documented in the rail's spec doc.

### 2. Idempotency key defined

Every rail must define a unique idempotency key that identifies a specific payment attempt. Examples:

| Rail | Idempotency key |
|------|----------------|
| `ocr-permit-v1` | `(payer address, EIP-2612 permit nonce)` |
| Stripe | `(Stripe PaymentIntent ID)` |
| EIP-3009 | `(from address, nonce)` |

The key must be checked in `settle()` before any on-chain call. A settled key must never be re-broadcast.

### 3. Off-chain verification before on-chain action

`verify()` must run all checks that can fail before any gas is spent. `settle()` must re-run `verify()` before broadcasting. Never broadcast a transaction based solely on the client's claim that verification passed.

### 4. Facilitator key never appears as `payer`

Enforced by the `facilitator_never_payer` invariant in `.invariants`. This is FROZEN. Any rail that requires the Facilitator to be `payer` violates the invariant and cannot be merged without a protocol-level decision.

### 5. `cancelSubscription` never called

Enforced by the `cancel_not_called` invariant. The adapter has no cancellation path. Users self-cancel via the contract directly.

### 6. Input validation at the boundary

Every field in the incoming JSON payload must be validated before use (type, format, range). Zod schemas in the route files are the enforcement point — new rails must add equivalent schemas.

---

## Production Hardening Checklist

- [ ] Replace in-memory idempotency store with Redis or a persistent DB
- [ ] Add authentication to `/settle` (API key, JWT, or IP allowlist) to prevent gas drain
- [ ] Rotate the Facilitator private key via a signing service (KMS, Turnkey, etc.)
- [ ] Set up gas wallet monitoring and alerting
- [ ] Verify the token contract implements EIP-2612 before allowing a new asset
- [ ] Pin the `ASSET_REGISTRY_ADDRESS` in config — do not accept it from the request
