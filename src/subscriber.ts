import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import type { Address, Hex } from "viem";

/**
 * Derives the bytes32 subscriber ID for an x402 subscription.
 *
 * Formula: keccak256(abi.encode("ocr-permit-v1", userAddress))
 *
 * Matches Asset.cancelSubscription's _hash(subscriberId_string, msg.sender) derivation,
 * so a user can self-cancel by calling cancelSubscription("ocr-permit-v1", signature)
 * from the same wallet address used here.
 *
 * NOT the same as the SDK's subscriberToId() which uses encodePacked(address).
 * These are separate identity namespaces and must not be mixed.
 */
export function deriveSubscriberId(userAddress: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, address"), ["ocr-permit-v1", userAddress]),
  );
}
