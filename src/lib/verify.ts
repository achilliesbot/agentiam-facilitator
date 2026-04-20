import { verifyTypedData, Contract, JsonRpcProvider } from "ethers";
import {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  USDC_BASE,
  CHAIN_ID_BASE,
} from "../types";

const DOMAIN_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

export interface VerifyDeps {
  provider: JsonRpcProvider;
  nonceExists: (nonce: string) => Promise<boolean>;
  clockSkewMaxSeconds: number;
  minAmount: bigint;
}

export async function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  deps: VerifyDeps
): Promise<VerifyResponse> {
  if (payload.scheme !== "exact")
    return { isValid: false, invalidReason: "invalid_scheme" };
  if (payload.network !== "base")
    return { isValid: false, invalidReason: "invalid_network" };
  if (requirements.asset.toLowerCase() !== USDC_BASE.toLowerCase())
    return { isValid: false, invalidReason: "invalid_asset" };

  const a = payload.payload.authorization;

  if (a.to.toLowerCase() !== requirements.payTo.toLowerCase())
    return { isValid: false, invalidReason: "payee_mismatch" };

  const now = Math.floor(Date.now() / 1000);
  const validAfter = Number(a.validAfter);
  const validBefore = Number(a.validBefore);

  if (now < validAfter)
    return { isValid: false, invalidReason: "not_yet_valid" };
  if (now >= validBefore)
    return { isValid: false, invalidReason: "expired" };
  if (validBefore - now > deps.clockSkewMaxSeconds)
    return { isValid: false, invalidReason: "invalid_payload" };

  const value = BigInt(a.value);
  const max = BigInt(requirements.maxAmountRequired);
  if (value > max)
    return { isValid: false, invalidReason: "amount_too_high" };
  if (value < deps.minAmount)
    return { isValid: false, invalidReason: "amount_too_low" };

  const domain = {
    name: requirements.extra?.name ?? "USD Coin",
    version: requirements.extra?.version ?? "2",
    chainId: CHAIN_ID_BASE,
    verifyingContract: USDC_BASE,
  };

  let recovered: string;
  try {
    recovered = verifyTypedData(domain, DOMAIN_TYPES, a, payload.payload.signature);
  } catch {
    return { isValid: false, invalidReason: "invalid_signature" };
  }
  if (recovered.toLowerCase() !== a.from.toLowerCase())
    return { isValid: false, invalidReason: "invalid_signature" };

  if (await deps.nonceExists(a.nonce))
    return { isValid: false, invalidReason: "nonce_reused", payer: a.from };

  try {
    const usdc = new Contract(USDC_BASE, USDC_ABI, deps.provider);
    const bal: bigint = await usdc.balanceOf(a.from);
    if (bal < value)
      return { isValid: false, invalidReason: "insufficient_funds", payer: a.from };
  } catch {
    return { isValid: false, invalidReason: "invalid_payload", payer: a.from };
  }

  return { isValid: true, payer: a.from };
}
