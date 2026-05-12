# Scheme: `ocr-permit-v1`

## Summary

`ocr-permit-v1` is an x402-shaped payment scheme for OCR subscriptions. It uses EIP-2612 (`permit`) to authorize token transfer and calls `Asset.subscribe()` in a single transaction. The Facilitator is a pure transaction broadcaster: tokens flow directly from payer to the Asset contract.

## Payment Requirements (`PaymentRequired` 402 response)

```json
{
  "scheme": "ocr-permit-v1",
  "network": "eip155:<chainId>",
  "payTo": "<Asset contract address>",
  "asset": "<ERC-20 token address>",
  "amount": "<price in atomic units>",
  "extra": {
    "assetAddress": "<Asset contract address>",
    "count": 1
  }
}
```

`payTo` is the Asset contract address. Tokens are transferred there by the contract, not by the Facilitator.

## X-Payment Header Payload

The client constructs and sends:

```json
{
  "x402Version": 1,
  "scheme": "ocr-permit-v1",
  "network": "eip155:<chainId>",
  "payload": {
    "subscriberId": "<bytes32 hex>",
    "payer": "<user wallet address>",
    "count": 1,
    "deadline": <unix timestamp>,
    "permitNonce": <token nonce at signing time>,
    "v": <uint8>,
    "r": "<bytes32 hex>",
    "s": "<bytes32 hex>"
  }
}
```

### Subscriber ID Derivation

```
subscriberId = keccak256(abi.encode("ocr-permit-v1", userAddress))
```

This matches `Asset.cancelSubscription`'s identity scheme (`keccak256(abi.encode(subscriberId_string, msg.sender))`). A user can self-cancel by calling `cancelSubscription("ocr-permit-v1", signature)` from the wallet address used when subscribing.

**Do not use `keccak256(encodePacked(address))`.** That is the SDK convention for non-x402 subscriptions and is a different identity namespace.

### Permit Construction

The client signs an EIP-2612 permit with:

```
owner   = userAddress
spender = Asset contract address   ← enforced by _validatePermit
value   = count × Asset.subscriptionPrice()
deadline = <unix timestamp, recommend now + 5 minutes>
```

The EIP-712 domain is the ERC-20 token contract's domain (not the Asset contract).

## Verification (`POST /verify`)

The Facilitator MUST verify off-chain before any on-chain call:

1. `payload.deadline > block.timestamp` (or current time as proxy)
2. EIP-2612 permit signature is valid: recover signer from EIP-712 typed data and assert `signer == payload.payer`
3. `payload.payer` is not the Facilitator's own address
4. Token balance of `payload.payer >= count × subscriptionPrice`
5. Token allowance: nonce check — `IERC20Permit(token).nonces(payer) == expectedNonce` (optional but recommended)
6. Idempotency: if this nonce+payer combination is already settled, return the cached result

## Settlement (`POST /settle`)

1. Check idempotency store. If already settled, return cached `SettleResponse`.
2. Call `Asset.subscribe(subscriberId, payer, assetAddress, count, deadline, v, r, s)`.
   - `spender` parameter MUST be the Asset contract address.
   - `payer` MUST be the user's wallet address, never the Facilitator's address.
3. Wait for transaction receipt.
4. Store result in idempotency store keyed by `(payer, permitNonce)`.
5. Return `SettleResponse`.

## Idempotency

EIP-2612 nonces on the token contract are monotonic per address. Once a permit nonce is consumed on-chain, any retry of the same `(payer, nonce)` will fail at the contract level. The Facilitator's idempotency store catches retries before broadcasting to avoid wasting gas.

Key: `${payer.toLowerCase()}:${permitNonce}`

## Limitations

- Token MUST implement EIP-2612 (`permit`). Plain ERC-20 is not supported.
- `count` must be ≥ 1. Fractional subscriptions are not supported.
- `cancelSubscription` is not called by this adapter (see `OQ-7` in `PROTOCOL.md`). Users self-cancel by calling the contract directly with `subscriberId = "ocr-permit-v1"`.
- This scheme is not part of the upstream x402 standard. A contribution proposal is tracked separately.
