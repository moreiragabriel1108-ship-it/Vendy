import express from "express";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 8080);
const PRICE_CENTS = 1990;
const PLAN_DAYS = 30;
const required = ["DATABASE_URL", "MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "JWT_SECRET"];
for (const key of required) {
  if (!process.env[key]) console.warn(`Missing required environment variable: ${key}`);
}
if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must be at least 32 characters in production.");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined
});

await pool.query(`
CREATE TABLE IF NOT EXISTS venzy_payments (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  mp_payment_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL CHECK (amount_cents = 1990),
  pix_copy_paste TEXT,
  pix_qr_base64 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  premium_granted_at TIMESTAMPTZ
);
ALTER TABLE venzy_payments ADD COLUMN IF NOT EXISTS premium_granted_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS venzy_entitlements (
  user_id TEXT PRIMARY KEY,
  premium_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`);

app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  next();
});

function requireUser(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const parts = token.split(".");
  if (!process.env.JWT_SECRET || parts.length !== 3) return res.status(401).json({ error: "Autenticação necessária." });
  try {
    const [encodedHeader, encodedPayload, signature] = parts;
    const expected = crypto.createHmac("sha256", process.env.JWT_SECRET)
      .update(encodedHeader + "." + encodedPayload).digest("base64url");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad signature");
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error("expired");
    req.user = { id: String(payload.sub) };
    next();
  } catch {
    return res.status(401).json({ error: "Sessão inválida ou expirada." });
  }
}

function validWebhookSignature(req) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  const signatureHeader = req.get("x-signature") || "";
  const requestId = req.get("x-request-id") || "";
  const dataId = String(req.query["data.id"] || req.query.id || "").toLowerCase();
  const fields = Object.fromEntries(signatureHeader.split(",").map(s => {
    const i = s.trim().indexOf("=");
    return i < 0 ? ["", ""] : [s.trim().slice(0, i), s.trim().slice(i + 1)];
  }));
  if (!secret || !fields.ts || !fields.v1 || !dataId || !requestId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${fields.ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(fields.v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "venzy-payment-api" }));

app.post("/api/payments/pix", requireUser, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const firstName = typeof req.body?.firstName === "string" ? req.body.firstName.trim().slice(0, 80) : "Cliente";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Informe um e-mail válido para o pagamento." });
  const idempotencyKey = crypto.randomUUID();
  try {
    const response = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({
        transaction_amount: PRICE_CENTS / 100,
        description: "Venzy Premium - 30 dias",
        payment_method_id: "pix",
        payer: { email, first_name: firstName },
        external_reference: req.user.id,
        notification_url: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL.replace(/\/$/, "")}/api/webhooks/mercadopago` : undefined,
        metadata: { user_id: req.user.id, plan: "premium_30_days" }
      })
    });
    const payment = await response.json();
    if (!response.ok) {
      console.error("Mercado Pago create payment failed:", response.status, payment.message || payment.error || "unknown");
      return res.status(502).json({ error: "Não foi possível criar o Pix agora. Tente novamente." });
    }
    const tx = payment.point_of_interaction?.transaction_data;
    if (!payment.id || !tx?.qr_code) return res.status(502).json({ error: "O provedor não retornou os dados do Pix." });
    await pool.query(
      "INSERT INTO venzy_payments (user_id, mp_payment_id, idempotency_key, status, amount_cents, pix_copy_paste, pix_qr_base64) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [req.user.id, String(payment.id), idempotencyKey, payment.status || "pending", PRICE_CENTS, tx.qr_code, tx.qr_code_base64 || null]
    );
    res.status(201).json({
      paymentId: String(payment.id),
      status: payment.status || "pending",
      amount: PRICE_CENTS / 100,
      description: "Venzy Premium por 30 dias",
      pixCopyPaste: tx.qr_code,
      pixQrBase64: tx.qr_code_base64 || null,
      expiresAt: payment.date_of_expiration || null
    });
  } catch (error) {
    console.error("Pix creation error:", error.message);
    res.status(500).json({ error: "Erro interno ao criar o Pix." });
  }
});

app.get("/api/payments/status", requireUser, async (req, res) => {
  try {
    const result = await pool.query("SELECT premium_until FROM venzy_entitlements WHERE user_id=$1", [req.user.id]);
    const until = result.rows[0]?.premium_until || null;
    res.json({ premium: Boolean(until && new Date(until).getTime() > Date.now()), premiumUntil: until });
  } catch {
    res.status(500).json({ error: "Não foi possível consultar o plano." });
  }
});

app.post("/api/webhooks/mercadopago", async (req, res) => {
  if (!validWebhookSignature(req)) return res.status(401).json({ error: "Assinatura do webhook inválida." });
  const type = String(req.query.type || req.body?.type || "");
  const paymentId = String(req.query["data.id"] || req.body?.data?.id || "");
  if (type !== "payment" || !/^\d+$/.test(paymentId)) return res.sendStatus(200);
  try {
    // Never trust the webhook body alone: fetch the payment from Mercado Pago.
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` }
    });
    if (!response.ok) return res.sendStatus(502);
    const payment = await response.json();
    if (payment.status !== "approved") {
      await pool.query("UPDATE venzy_payments SET status=$1 WHERE mp_payment_id=$2", [String(payment.status || "unknown"), paymentId]);
      return res.sendStatus(200);
    }
    if (Math.round(Number(payment.transaction_amount) * 100) !== PRICE_CENTS ||
        String(payment.external_reference || "") !== String(payment.metadata?.user_id || "")) {
      console.error("Approved payment failed amount/user validation:", paymentId);
      return res.sendStatus(200);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Only one webhook can claim a payment for granting premium; retries are idempotent.
      const saved = await client.query(
        "UPDATE venzy_payments SET status='approved', approved_at=COALESCE(approved_at,NOW()), premium_granted_at=NOW() WHERE mp_payment_id=$1 AND user_id=$2 AND amount_cents=$3 AND premium_granted_at IS NULL RETURNING user_id",
        [paymentId, String(payment.external_reference), PRICE_CENTS]
      );
      if (saved.rowCount === 1) {
        await client.query(
          `INSERT INTO venzy_entitlements(user_id,premium_until,updated_at)
           VALUES($1,NOW() + INTERVAL '30 days',NOW())
           ON CONFLICT(user_id) DO UPDATE SET
           premium_until=GREATEST(venzy_entitlements.premium_until,NOW()) + INTERVAL '30 days',
           updated_at=NOW()`,
          [saved.rows[0].user_id]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Venzy payment API listening on port ${PORT}`));
