# x402 Adapter — Architecture

## Role

The `open-creator-rails.x402-adapter` is a Hono service that bridges x402 HTTP payment signaling with OCR's EIP-2612 permit-based subscription contracts. It implements the x402 Facilitator interface (`/supported`, `/verify`, `/settle`) using the `ocr-permit-v1` scheme.

## Why EIP-2612, not EIP-3009

x402's `exact` scheme uses EIP-3009 (`transferWithAuthorization`) to move tokens to a `payTo` address. OCR's `Asset.subscribe()` is frozen at EIP-2612 (`permit`):

```solidity
function subscribe(
    bytes32 subscriber,
    address payer,
    address spender,   // MUST equal address(this) — enforced in _validatePermit
    uint256 count,
    uint256 deadline,
    uint8 v, bytes32 r, bytes32 s
) external nonReentrant returns (uint256)
```

`_validatePermit` calls `IERC20Permit(token).permit(payer, address(this), amount, deadline, v, r, s)` then immediately `safeTransferFrom`. The Asset contract is both the spender and the recipient. An EIP-3009 authorization cannot satisfy this — EIP-3009 moves tokens to an arbitrary `to` address via a different function selector.

No contract change is required. The adapter holds a pre-signed EIP-2612 permit from the user and broadcasts it on-chain.

## Payment Flow

```
Client                  Facilitator             Chain
  │                         │                     │
  │  GET /resource           │                     │
  │─────────────────────────>│                     │
  │                         │                     │
  │  402 + PaymentRequired  │                     │
  │<─────────────────────────│                     │
  │  {scheme: ocr-permit-v1, │                     │
  │   network: eip155:...,   │                     │
  │   asset: <Asset addr>,   │                     │
  │   payTo: <Asset addr>,   │                     │
  │   amount: <price>}       │                     │
  │                         │                     │
  │  sign EIP-2612 permit    │                     │
  │  (payer=self,            │                     │
  │   spender=Asset,         │                     │
  │   amount, deadline)      │                     │
  │                         │                     │
  │  POST /verify           │                     │
  │  {payload: {permit,      │                     │
  │   subscriberId, count}}  │                     │
  │─────────────────────────>│                     │
  │                         │  validate sig       │
  │                         │  check nonce        │
  │                         │  check deadline     │
  │                         │  check idempotency  │
  │                         │                     │
  │  200 VerifyResponse     │                     │
  │<─────────────────────────│                     │
  │                         │                     │
  │  POST /settle           │                     │
  │─────────────────────────>│                     │
  │                         │  Asset.subscribe()  │
  │                         │────────────────────>│
  │                         │  (Facilitator pays  │
  │                         │   gas only; tokens  │
  │                         │   flow payer→Asset) │
  │                         │                     │
  │  200 SettleResponse     │                     │
  │<─────────────────────────│                     │
  │                         │                     │
  │  GET /resource (retry)  │                     │
  │─────────────────────────>│                     │
  │  200 + content          │                     │
  │<─────────────────────────│                     │
```

## Non-Custodial Guarantee

The Facilitator:
- Pays gas for the `subscribe()` call
- Never appears as `payer` in any contract call
- Cannot redirect tokens — `spender` is enforced by the contract to be `address(this)`
- Cannot replay a permit — EIP-2612 nonces are per-address on the token contract; a spent nonce reverts

Funds flow: `payer (user) → Asset contract`  
Facilitator's role: transaction broadcaster only.

## Component Map

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Hono app, route mounting, graceful shutdown |
| `src/config.ts` | Env validation: `RPC_URL`, `PRIVATE_KEY`, `ASSET_REGISTRY_ADDRESS` |
| `src/permit.ts` | Reconstruct and verify EIP-2612 permit signature off-chain |
| `src/subscriber.ts` | `deriveSubscriberId(userAddress)` → `bytes32` |
| `src/idempotency.ts` | Nonce→result store; prevents double-settle |
| `src/routes/supported.ts` | `GET /supported` |
| `src/routes/verify.ts` | `POST /verify` |
| `src/routes/settle.ts` | `POST /settle` |

## Limitations

- In-memory idempotency store: lost on restart. Swap for Redis before production.
- Single Facilitator key: no key rotation or multi-sig. Production deployments should use a signing service.
- Only the `ocr-permit-v1` scheme is implemented. See `IPaymentAdapter.md` for adding further rails.
- `cancelSubscription` is not called by this adapter. See `OQ-7` in `PROTOCOL.md` and `.invariants`.
