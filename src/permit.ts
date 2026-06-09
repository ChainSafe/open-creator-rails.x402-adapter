import {
  createPublicClient,
  hashTypedData,
  http,
  recoverAddress,
  parseAbi,
} from "viem";
import type { Address, Hex, PublicClient } from "viem";

export type PermitPayload = {
  payer: Address;
  spender: Address; // must equal Asset contract address
  value: bigint;
  deadline: bigint;
  permitNonce: bigint;
  v: number;
  r: Hex;
  s: Hex;
};

const nonceAbi = parseAbi(["function nonces(address owner) view returns (uint256)"]);
const nameAbi = parseAbi(["function name() view returns (string)"]);
const versionAbi = parseAbi(["function version() view returns (string)"]);

/** Circle native USDC — EIP-2612 domain uses version "2", not "1". */
const USDC_BY_CHAIN: Record<number, Address> = {
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

async function erc20PermitVersion(
  publicClient: PublicClient,
  chainId: number,
  tokenAddress: Address,
): Promise<string> {
  const known = USDC_BY_CHAIN[chainId];
  if (known && known.toLowerCase() === tokenAddress.toLowerCase()) {
    return "2";
  }
  try {
    const version = await publicClient.readContract({
      address: tokenAddress,
      abi: versionAbi,
      functionName: "version",
    });
    return String(version);
  } catch {
    return "1";
  }
}

/**
 * Verifies an EIP-2612 permit signature off-chain.
 *
 * Reads the token's `name()` (for EIP-712 domain) and cross-checks
 * the provided `permitNonce` against the current on-chain nonce.
 *
 * Returns the recovered signer address.
 */
export async function verifyPermitSignature(
  permit: PermitPayload,
  tokenAddress: Address,
  chainId: number,
  publicClient: PublicClient,
): Promise<{ valid: boolean; reason?: string; recoveredSigner?: Address }> {
  // Check deadline
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (permit.deadline <= nowSec) {
    return { valid: false, reason: "permit deadline expired" };
  }

  // Cross-check nonce against chain state
  const onChainNonce = await publicClient.readContract({
    address: tokenAddress,
    abi: nonceAbi,
    functionName: "nonces",
    args: [permit.payer],
  });

  if (onChainNonce !== permit.permitNonce) {
    return {
      valid: false,
      reason: `permit nonce mismatch: expected ${permit.permitNonce}, on-chain is ${onChainNonce}`,
    };
  }

  // Read token name + EIP-712 domain version (USDC uses "2", most tokens use "1").
  const [tokenName, domainVersion] = await Promise.all([
    publicClient.readContract({
      address: tokenAddress,
      abi: nameAbi,
      functionName: "name",
    }),
    erc20PermitVersion(publicClient, chainId, tokenAddress),
  ]);

  // Reconstruct EIP-712 typed data hash
  const hash = hashTypedData({
    domain: {
      name: tokenName,
      version: domainVersion,
      chainId,
      verifyingContract: tokenAddress,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: permit.payer,
      spender: permit.spender,
      value: permit.value,
      nonce: permit.permitNonce,
      deadline: permit.deadline,
    },
  });

  const recoveredSigner = await recoverAddress({
    hash,
    signature: { v: BigInt(permit.v), r: permit.r, s: permit.s },
  });

  if (recoveredSigner.toLowerCase() !== permit.payer.toLowerCase()) {
    return {
      valid: false,
      reason: `permit signer mismatch: recovered ${recoveredSigner}, expected ${permit.payer}`,
      recoveredSigner,
    };
  }

  return { valid: true, recoveredSigner };
}

export function buildPublicClient(rpcUrl: string, chainId: number): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl),
    chain: { id: chainId, name: "ocr", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
  }) as PublicClient;
}
