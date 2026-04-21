import { Pool } from "pg";

export function makePool(url: string) {
  const needsSsl = /render\.com|sslmode=require/.test(url) || process.env.DATABASE_SSL === "true";
  return new Pool({
    connectionString: url,
    max: 10,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facilitator_settlements (
  id              BIGSERIAL PRIMARY KEY,
  tx_hash         TEXT        UNIQUE NOT NULL,
  payer           TEXT        NOT NULL,
  payee           TEXT        NOT NULL,
  amount_usdc     NUMERIC(78,0) NOT NULL,
  service_id      TEXT,
  resource_url    TEXT,
  network         TEXT        NOT NULL DEFAULT 'base',
  scheme          TEXT        NOT NULL DEFAULT 'exact',
  settled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  block_number    BIGINT,
  gas_used        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_fs_payer   ON facilitator_settlements(payer);
CREATE INDEX IF NOT EXISTS idx_fs_payee   ON facilitator_settlements(payee);
CREATE INDEX IF NOT EXISTS idx_fs_service ON facilitator_settlements(service_id);
CREATE INDEX IF NOT EXISTS idx_fs_time    ON facilitator_settlements(settled_at DESC);

CREATE TABLE IF NOT EXISTS facilitator_nonces (
  nonce       TEXT        PRIMARY KEY,
  payer       TEXT        NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fn_expires ON facilitator_nonces(expires_at);

CREATE TABLE IF NOT EXISTS facilitator_payee_reputation (
  payee           TEXT PRIMARY KEY,
  total_settled   NUMERIC(78,0) NOT NULL DEFAULT 0,
  tx_count        BIGINT NOT NULL DEFAULT 0,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_settled_at TIMESTAMPTZ,
  dispute_count   INT NOT NULL DEFAULT 0
);
`;

export async function migrate(pool: Pool) {
  await pool.query(SCHEMA_SQL);
}

export async function nonceExists(pool: Pool, nonce: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM facilitator_nonces WHERE nonce=$1", [nonce]);
  return r.rowCount !== null && r.rowCount > 0;
}

export async function claimNonce(
  pool: Pool,
  nonce: string,
  payer: string,
  expiresAtUnix: number
): Promise<boolean> {
  try {
    const r = await pool.query(
      "INSERT INTO facilitator_nonces(nonce,payer,expires_at) VALUES($1,$2,to_timestamp($3)) ON CONFLICT (nonce) DO NOTHING RETURNING nonce",
      [nonce, payer, expiresAtUnix]
    );
    return r.rowCount !== null && r.rowCount > 0;
  } catch {
    return false;
  }
}

export async function releaseNonce(pool: Pool, nonce: string) {
  await pool.query("DELETE FROM facilitator_nonces WHERE nonce=$1", [nonce]);
}

export async function recordSettlement(
  pool: Pool,
  row: {
    tx_hash: string;
    payer: string;
    payee: string;
    amount: string;
    service_id?: string;
    resource_url?: string;
    block_number: number;
    gas_used: string;
  }
) {
  await pool.query(
    `INSERT INTO facilitator_settlements(tx_hash,payer,payee,amount_usdc,service_id,resource_url,block_number,gas_used)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tx_hash) DO NOTHING`,
    [
      row.tx_hash,
      row.payer,
      row.payee,
      row.amount,
      row.service_id ?? null,
      row.resource_url ?? null,
      row.block_number,
      row.gas_used,
    ]
  );
  await pool.query(
    `INSERT INTO facilitator_payee_reputation(payee,total_settled,tx_count,last_settled_at)
     VALUES($1,$2,1,NOW())
     ON CONFLICT (payee) DO UPDATE SET
       total_settled = facilitator_payee_reputation.total_settled + EXCLUDED.total_settled,
       tx_count = facilitator_payee_reputation.tx_count + 1,
       last_settled_at = NOW()`,
    [row.payee, row.amount]
  );
}

export async function stats(pool: Pool) {
  const r = await pool.query(
    `SELECT COUNT(*)::bigint AS total_tx,
            COALESCE(SUM(amount_usdc),0)::text AS total_amount,
            COUNT(DISTINCT payee)::int AS services,
            MAX(settled_at) AS last_settlement
     FROM facilitator_settlements`
  );
  const row = r.rows[0];
  return {
    total_settled_tx: Number(row.total_tx),
    total_settled_usdc_atomic: row.total_amount,
    services_using_facilitator: row.services,
    last_settlement_at: row.last_settlement,
  };
}
