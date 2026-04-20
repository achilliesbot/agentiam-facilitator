export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const CHAIN_ID_BASE = 8453;
export const SUPPORTED_SCHEME = "exact" as const;
export const SUPPORTED_NETWORK = "base" as const;

export interface PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  outputSchema?: object;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: { name: string; version: string };
}

export interface EIP3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: "base";
  payload: {
    signature: string;
    authorization: EIP3009Authorization;
  };
}

export type InvalidReason =
  | "insufficient_funds"
  | "invalid_scheme"
  | "invalid_network"
  | "invalid_asset"
  | "invalid_signature"
  | "expired"
  | "not_yet_valid"
  | "amount_too_low"
  | "amount_too_high"
  | "payee_mismatch"
  | "nonce_reused"
  | "invalid_payload";

export type VerifyResponse =
  | { isValid: true; payer: string }
  | { isValid: false; invalidReason: InvalidReason; payer?: string };

export type SettleError =
  | "invalid_payment"
  | "already_settled"
  | "rpc_error"
  | "tx_reverted"
  | "gas_estimation_failed"
  | "internal_error";

export type SettleResponse =
  | { success: true; transaction: string; network: "base"; payer: string }
  | {
      success: false;
      errorReason: SettleError;
      transaction?: string;
      network: "base";
      payer?: string;
    };

export interface SupportedResponse {
  kinds: Array<{ scheme: string; network: string }>;
}
