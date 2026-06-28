# PRP-61 — Per-school payment gateway + online fee payment

> **Status:** Proposed · **Phase:** 7 · **Severity:** 🔴 High · **Size:** XL
> **Depends on:** PRP-46 (`Payment` / `PaymentAllocation` / `Receipt` / `StudentFee` ledger + `syncStudentFees` + `getNextReceiptSequence` + receipt PDF — online payment is **one more `PaymentMethod` feeding the same ledger**, the void/refund seam PRP-46 flagged is filled here), PRP-45 (`computeStudentDues` / `accrueFinesForStudent` — the charges a checkout settles), PRP-44 (`fees.*` resource + `Decimal` discipline + published plans), PRP-41 (parent portal APIs — parents initiate checkout for their own children; own-children scoping), PRP-31 (guardian linkage — the parent is the payer; receipt/notification recipient), PRP-18 (`writeAudit` — gateway-config changes, payment captures, refunds are audited critical actions, D22), PRP-17 (permission strings — adds `fees.gateway`), PRP-12 (school context / tenant scoping), PRP-15 (`requireWritableSchool` — a checkout is a write) · **Feeds:** PRP-62 (parent web/mobile checkout + admin gateway-config screen), PRP-63 (online platform-subscription billing reuses this provider abstraction against PRP-15's `Invoice`), PRP-60 (mobile comms/app shell — mobile checkout reuses the same intent/verify endpoints)

## 1. Problem / current state
P4 (PRP-44/45/46) models fees and records **manual/offline** payments (cash / cheque / bank-transfer) with PDF receipts and a materialized `StudentFee` ledger — explicitly **no payment gateway** (decision **D7**: "Not in v1"). There is no way for a parent to **pay online**, no gateway integration, no webhook handling, and no refund flow (PRP-46 models a `VOID`/cheque-bounce reversal but flagged true money-back refunds as out of scope for P4, to be built here).

P7 turns online collection on under a deliberate, licensing-driven model (**D7**, master §3): the **school connects its *own* gateway account** (its own Razorpay merchant account / API keys). **The platform never holds or routes funds** — money flows buyer → the *school's* merchant account directly. This is the decision that lets the platform avoid being an **RBI-regulated payment aggregator** (which would require a PA licence, escrow/nodal accounts, and settlement obligations). The platform's role is limited to: storing the school's gateway credentials (encrypted), creating payment intents/orders **on the school's account**, verifying signed webhooks, and **reconciling** a successful payment back into PRP-46's `Payment`/`Receipt` ledger.

This PRP introduces the **`SchoolPaymentGateway`** model (per-school encrypted keys + a pluggable provider abstraction), the **checkout/order-intent** API, **signed-webhook** ingestion with idempotency, **reconciliation** into the existing ledger, and the first true **`Refund`** model (against the school's own account).

> ⚠︎ **O-P7 is the headline open question for this whole phase (master §10).** This PRP carries inline assumptions until it resolves:
> - **Gateway choice:** **Razorpay is assumed** (dominant for India K-12, supports `order` + `payment.captured`/`refund` webhooks, and a clean per-merchant key model). The integration is built behind a **`PaymentProvider` port** (§3.3) so a second provider (PayU / Cashfree / Stripe-India) drops in without touching fee logic. **Do not** scatter `razorpay`-specific calls outside the adapter.
> - **Per-school onboarding / KYC:** the school completes KYC **with Razorpay directly** (the platform is *not* the merchant, so the platform does **not** run KYC). v1 stores the keys the school pastes after its own onboarding; an optional **Razorpay Route/linked-account / OAuth Partner** flow (platform-managed onboarding) is a documented future extension, **not** built here — it would change the funds-flow/licensing posture and must be re-evaluated against D7.
> - **Settlement reporting:** settlement (gateway → school bank) is **the gateway's** responsibility and visible in the school's own gateway dashboard. v1 surfaces a **read-only settlement/transaction reference** (the gateway payment id + captured timestamp on the `Payment`) and a reconciliation report; the platform does **not** reconcile bank settlements (it never sees the money). A richer settlement-report pull via the provider API is a flagged extension.

## 2. Goal & non-goals
- **Goal:** (1) a **`SchoolPaymentGateway`** record per school holding **encrypted** provider credentials + enablement state + the chosen provider; (2) a **`PaymentProvider` port** with a Razorpay adapter (create-order, verify-signature, fetch-payment, create-refund, verify-webhook); (3) a **checkout-intent** endpoint that, for a parent's own child and a set of outstanding `StudentFee` lines, creates a provider **order on the school's account** and returns the client handshake params; (4) a **payment-verify** endpoint (synchronous client callback) **and** a **signed-webhook** endpoint (authoritative, async) that both funnel through **one idempotent reconciliation** path which writes a `COMPLETED` `Payment` (method `ONLINE`) + `PaymentAllocation`s + `Receipt` into PRP-46's ledger; (5) a **`Refund`** model + endpoint (school-initiated, against the school's own account) that reverses the ledger and is audited; (6) a **reconciliation report** (gateway captures vs. ledger `Payment`s, surfacing mismatches). All money is `Decimal`; the ledger stays the single source of truth (PRP-46).
- **Non-goals:** the fee model itself (PRP-44/45 — consumed, not rebuilt); manual payments (PRP-46 — unchanged; online is an *additional* method); the FE checkout + admin config screens (PRP-62); **online platform-subscription billing** (schools paying the *platform* — that is PRP-63, which reuses this provider abstraction against PRP-15's `Invoice`, not `StudentFee`); the notification *engine* (P6/PRP-54 — this PRP fires the existing "queue notification" seam for the online receipt); **platform-managed merchant onboarding / KYC / fund-routing** (explicitly out per D7 — schools onboard with the gateway directly); multi-currency (₹ only, master §8).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Decimal/year-scope discipline and the ledger models are inherited from PRP-46; this PRP **extends** `PaymentMethod`/`PaymentStatus` and adds three models. Enums import from `src/generated/prisma/enums.js`.

```prisma
enum PaymentProvider {
  RAZORPAY        // assumed default (O-P7 ⚠︎)
  // PAYU / CASHFREE / STRIPE — add when a second provider lands (adapter-only change)
}

// EXTEND PRP-46's PaymentMethod (do not redefine — add the member)
//   enum PaymentMethod { CASH CHEQUE BANK_TRANSFER DD OTHER  ONLINE }
// EXTEND PRP-46's PaymentStatus (add the in-flight + reversal states online needs)
//   enum PaymentStatus { COMPLETED PENDING VOID  INITIATED FAILED REFUNDED PARTIALLY_REFUNDED }

model SchoolPaymentGateway {
  gatewayId        String          @id @default(uuid())
  schoolId         String          @unique               // one active gateway config per school (v1)
  provider         PaymentProvider @default(RAZORPAY)
  isEnabled        Boolean         @default(false)        // online pay off until the school configures + enables
  mode             String          @default("LIVE")       // LIVE | TEST (provider env)
  keyId            String                                 // public key / merchant id (NOT secret) — used client-side
  encryptedKeySecret  String                              // AES-256-GCM ciphertext of the API secret (§3.5) — NEVER plaintext
  encryptedWebhookSecret String                           // AES-256-GCM ciphertext of the webhook signing secret
  keyVersion       Int             @default(1)            // encryption key id (rotation, §3.5)
  accountLabel     String?                                // free-text e.g. "Razorpay – ABC School Pvt Ltd"
  configuredByUserId String?                              // admin who set it (audit)
  lastVerifiedAt   DateTime?                              // last successful credential ping (§3.4)
  school           School          @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt

  @@index([schoolId])
  @@index([provider, isEnabled])
}

model PaymentIntent {
  paymentIntentId   String        @id @default(uuid())
  schoolId          String
  academicYearId    String
  studentId         String
  parentUserId      String                                // the parent who initiated (PRP-41 own-children scope)
  provider          PaymentProvider
  providerOrderId   String        @unique                 // e.g. Razorpay order_id — the dedupe anchor
  amount            Decimal       @db.Decimal(12, 2)      // ₹ requested — Decimal, never float
  currency          String        @default("INR")
  status            String        @default("CREATED")      // CREATED | PAID | FAILED | EXPIRED
  allocationPlan    Json                                   // [{ studentFeeId, amount }] captured at intent time (§3.6)
  providerPaymentId String?                                // set on capture (Razorpay payment_id)
  paymentId         String?       @unique                  // FK to the reconciled PRP-46 Payment once captured
  expiresAt         DateTime?
  student           Student       @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school            School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  @@index([schoolId])
  @@index([studentId, academicYearId])
  @@index([status])
  @@index([providerPaymentId])
}

model GatewayWebhookEvent {
  webhookEventId   String   @id @default(uuid())
  schoolId         String?                                 // resolved from the order/account when known
  provider         PaymentProvider
  providerEventId  String                                  // gateway's event id (x-razorpay-event-id) — idempotency key
  eventType        String                                  // e.g. payment.captured | payment.failed | refund.processed
  signatureValid   Boolean                                 // result of HMAC verification (§3.4)
  status           String   @default("RECEIVED")           // RECEIVED | PROCESSED | IGNORED | ERROR
  payload          Json                                    // raw event body (audit/replay)
  processedAt      DateTime?
  error            String?
  createdAt        DateTime @default(now())

  @@unique([provider, providerEventId])                    // dedupe webhook retries (§3.4)
  @@index([schoolId])
  @@index([eventType, status])
}

model Refund {
  refundId          String        @id @default(uuid())
  schoolId          String
  academicYearId    String
  paymentId         String                                 // the PRP-46 Payment being refunded (online only in v1)
  amount            Decimal       @db.Decimal(12, 2)       // ₹ refunded — may be partial; Decimal
  reason            String?
  status            String        @default("INITIATED")     // INITIATED | PROCESSED | FAILED
  providerRefundId  String?       @unique                   // Razorpay refund_id
  initiatedByUserId String?                                 // admin (audit)
  processedAt       DateTime?
  payment           Payment       @relation(fields: [paymentId], references: [paymentId], onDelete: Restrict)
  school            School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  @@index([schoolId])
  @@index([paymentId])
  @@index([status])
}
```
Add back-relations: `School.paymentGateway SchoolPaymentGateway?`, `School.paymentIntents`/`refunds`; `Student.paymentIntents`; `Payment.refunds Refund[]` (a payment may have multiple partial refunds) + `Payment.providerPaymentId String?` / `Payment.providerOrderId String?` (so a reconciled online `Payment` carries its gateway references and the settlement reference, O-P7) — coordinate this `Payment` edit with PRP-46 (§8). `PaymentIntent.allocationPlan`/`feeHeadId`-style references stay loose (no FK) for the same decoupling reason PRP-46 used.

> **Decision — the gateway never holds funds; the ledger is unchanged (D7).** Online payment is modeled as **one more `PaymentMethod` (`ONLINE`)** flowing into PRP-46's *existing* `Payment`/`PaymentAllocation`/`Receipt`/`StudentFee` ledger. The `PaymentIntent` is a **pre-ledger staging row** (the order created on the school's gateway account); only on a **verified capture** does it materialize a `COMPLETED` `Payment` via the **same `recordPayment`/allocation/`getNextReceiptSequence` path PRP-46 already tests**. This keeps one source of truth for money, one receipt-numbering authority, and means the parent fee view (PRP-46/41) and defaulter reports work unchanged. The platform stores credentials and orchestrates the handshake; the rupees move buyer → school merchant account, never through us (the RBI-licence-avoidance design, D7).

### 3.2 Funds-flow & licensing model (record the why — D7 / O-P7)
```
Parent (payer)                 Platform (us)                     School's own gateway acct
   |  POST /checkout/intent ----->|                                       |
   |                              |  create order (school keyId/secret) ->| order_id
   |  <----- order_id + keyId ----|                                       |
   |  --- pays on gateway SDK (money: parent ──────────────────────────►  school merchant acct)
   |                              |  <===== signed webhook payment.captured ====
   |                              |  verify sig + reconcile -> PRP-46 Payment+Receipt
   |  GET receipt PDF <-----------|                                       |
```
The platform is a **technical facilitator**, not a payment aggregator: it never receives, holds, escrows, or settles funds. Settlement (gateway → school bank) is entirely between the school and its gateway. **This is the load-bearing compliance property — any change that routes funds through a platform-controlled account (e.g. Razorpay Route with the platform as the parent merchant) re-opens the RBI PA-licence question and must go back to D7.** Documented here so reviewers don't "simplify" the design into a regulated one.

### 3.3 Provider port + Razorpay adapter (`src/modules/payments-online/providers/`)
A narrow port keeps the gateway pluggable (O-P7) and fee logic provider-agnostic:
```ts
interface PaymentProviderAdapter {
  createOrder(creds, { amount: Decimal, currency, receipt, notes }): Promise<{ orderId; raw }>;
  verifyCheckoutSignature(creds, { orderId, paymentId, signature }): boolean;     // sync client callback
  verifyWebhookSignature(creds, { rawBody: Buffer, signatureHeader }): boolean;   // async webhook (HMAC-SHA256)
  fetchPayment(creds, providerPaymentId): Promise<{ status; amount: Decimal; method?; capturedAt? }>;
  createRefund(creds, { providerPaymentId, amount: Decimal, notes }): Promise<{ refundId; status }>;
  parseWebhookEvent(rawBody: Buffer): { providerEventId; eventType; orderId?; paymentId?; refundId? };
}
```
- `razorpay.adapter.ts` implements it (Razorpay orders API + `validateWebhookSignature` HMAC). Add the `razorpay` SDK (or call the REST API with `fetch` + manual HMAC — prefer the latter to avoid a heavy dep; record the choice). The adapter takes **decrypted** creds as an argument and is otherwise stateless.
- `provider.registry.ts` maps `PaymentProvider → adapter` (mirrors PRP-46's `pdf.registry.ts` / the email template registry). `getAdapter(provider)`.
- **All provider-specific knowledge lives here.** Services call the port; they never import the SDK or know about `order_id` formats.

### 3.4 Webhook security + idempotency (the critical path)
The webhook is the **authoritative** confirmation (the sync client callback can be lost/spoofed). Hard requirements:
1. **Raw-body HMAC verification.** Register the webhook route with a **raw body parser** (Fastify `addContentTypeParser` for `application/json` on this route only, capturing `request.rawBody`) — the signature is computed over the exact bytes. Verify `x-razorpay-signature` against the school's **decrypted webhook secret** using `crypto.createHmac('sha256', secret)` + **`timingSafeEqual`** (reuse the constant-time compare already used in `auth.utils.ts`). A failed signature → record `GatewayWebhookEvent{ signatureValid:false, status:'IGNORED' }`, return **`200`** (so the gateway stops retrying a spoof) but **do nothing** to the ledger. Never trust an unsigned/invalid event.
2. **Idempotency.** Persist every event keyed by `@@unique([provider, providerEventId])` *before* processing; a duplicate (gateway retries aggressively) is a no-op (`status` already `PROCESSED`). The ledger write is **also** idempotent on `PaymentIntent.providerOrderId` / `providerPaymentId` (`@@unique`) — capturing the same order twice must not create two `Payment`s (catch `P2002`, treat as already-reconciled).
3. **School/credential resolution.** Resolve the school from the `PaymentIntent.providerOrderId` (or provider account id in the event) — **not** from any client-supplied field — then load *that school's* secret to verify. An event whose order we don't recognize → `IGNORED`.
4. **Respond fast, process safely.** ACK `200` quickly; do the reconciliation inside the handler in a short transaction (it is cheap). On a transient error, record `status:'ERROR'`+`error`, return non-2xx so the gateway **retries** (idempotency makes retries safe). A daily **reconciliation sweep** (§3.7) catches anything the webhook missed.
5. **Credential ping on save** (`lastVerifiedAt`): when an admin saves keys, do a lightweight authenticated call (e.g. fetch a known order or the provider's account endpoint) to confirm the keys work before `isEnabled` can be set — surfaced to PRP-62.

### 3.5 Credential encryption at rest (`src/lib/crypto/`)
School gateway secrets are **highly sensitive** and must never be stored or logged in plaintext:
- A `src/lib/crypto/secretsCrypto.ts` exposing `encryptSecret(plaintext) → { ciphertext, keyVersion }` and `decryptSecret(ciphertext, keyVersion) → plaintext` using **AES-256-GCM** (`node:crypto` `createCipheriv`/`createDecipheriv`) with a random 12-byte IV per value and the auth tag stored alongside (encode `version:iv:tag:ciphertext` base64, mirroring the `salt:hash` convention in `auth.utils.ts`). The data key comes from a new env secret **`GATEWAY_ENC_KEY`** (32-byte, base64), with `keyVersion` selecting among current/previous keys to allow **rotation** without downtime. Add `GATEWAY_ENC_KEY` (+ optional `GATEWAY_ENC_KEY_PREVIOUS`) to `src/config/shared-env.ts` (`sharedEnvProperties`, `AppConfig`, `readSharedEnv`) following the `JWT_SECRET`/`BREVO_*` pattern; treat it as **required in production** (validate length).
- `keyId` (public) is stored plaintext (it's safe to expose client-side); **`encryptedKeySecret`/`encryptedWebhookSecret` are always ciphertext.** The decrypted secret exists only transiently in the adapter call and is never returned by any read endpoint, never logged, and redacted in audit metadata.
- This `src/lib/crypto/` sits alongside PRP-46's `src/lib/storage/` as a cross-cutting lib (PRP-63 reuses it if it stores platform-side provider keys).

### 3.6 Checkout intent + reconciliation (`src/modules/payments-online/`)
New module, standard split (`{routes,controller,service,schema,types}.ts`), `fastify`-first services, tenant-scoped via `request.schoolContext.schoolId` (school routes) / `parentUserId` (parent routes). It **reuses PRP-46's** `syncStudentFees`, allocation logic, `getNextReceiptSequence`, `pdf.service`, and the notification seam — it does **not** re-implement them.

- **Create intent** `createCheckoutIntent(fastify, { schoolId, parentUserId, studentId, academicYearId, allocations? })`:
  (a) verify the gateway is configured + `isEnabled` for the school (else `409 gateway not configured`); (b) verify the parent is linked to `studentId` via **PRP-41's `resolveParentChildren`** (never trust a client `studentId`); (c) lazily `accrueFinesForStudent` + `syncStudentFees` (PRP-45/46) so dues are current; (d) compute the amount from the **server-side** outstanding lines (oldest-due-first, or the validated `allocations` subset) — **never** trust a client amount; (e) decrypt the school's secret, call `adapter.createOrder` on the **school's** account; (f) persist a `PaymentIntent{ status:'CREATED', allocationPlan, providerOrderId }`; (g) return `{ providerOrderId, keyId, amount, currency, studentName, intentId }` for the client SDK. Guarded by `requireWritableSchool` (a checkout is a write) **and** parent ownership.
- **Verify (sync callback)** `verifyCheckout(fastify, { intentId, providerPaymentId, signature })`: verify the signature via the adapter; if valid, **reconcile** (below). This is a UX fast-path; the webhook is still authoritative and idempotent so a double-confirm is safe.
- **Reconcile (the one true path)** `reconcileCapturedPayment(fastify, tx, { intent, providerPaymentId })` — idempotent: if `intent.paymentId` already set → return it. Else, inside a transaction, build a `recordPayment`-equivalent (method `ONLINE`, status `COMPLETED`, `providerOrderId`/`providerPaymentId` stamped) using PRP-46's allocation + `getNextReceiptSequence` + `Receipt` insert; set `PaymentIntent.status:'PAID'` + `paymentId`; render the receipt PDF lazily (failure must not roll back — PRP-46's rule); **awaited** `writeAudit('payment.online_captured', { amount, providerPaymentId, receiptNo })`; queue the online-receipt notification to the guardian. The amount captured is reconciled against `intent.amount` — a mismatch is logged + flagged (don't silently accept a different amount).
- **Refund** `createRefund(fastify, schoolId, { paymentId, amount?, reason })`: only against an `ONLINE` `COMPLETED` `Payment`; default full, allow partial (≤ remaining). Call `adapter.createRefund` on the school's account → persist `Refund{ status:'INITIATED' }`; on the `refund.processed` webhook (or sync response) set `PROCESSED`, set the `Payment.status` to `REFUNDED`/`PARTIALLY_REFUNDED`, and **reverse the ledger** by restoring `StudentFee.paidAmount`/`isPaid` for the refunded allocations (mirror PRP-46's `voidPayment` reversal — but this *is* a real money-back, distinct from PRP-46's void). **Awaited** `writeAudit('payment.refund', …)`. Guarded by `fees.gateway` (refunds are an admin/owner action) + `requireWritableSchool`.
- **Gateway config CRUD** `upsertGateway` / `getGatewayPublic` / `setEnabled` / `testCredentials` / `deleteGateway` — admin-only; **never returns secrets** (returns `keyId`, `provider`, `mode`, `isEnabled`, `lastVerifiedAt`, masked secret presence). `upsertGateway` encrypts secrets via §3.5 and pings credentials (§3.4.5); audited (`gateway.configured`, secrets redacted in metadata).
- **Reconciliation report** `getReconciliationReport(fastify, schoolId, { from, to })`: lists online `Payment`s + `Refund`s with their gateway references and flags any `PaymentIntent` `CREATED` older than its `expiresAt` with no `Payment`, or any captured webhook with no ledger row (the mismatch list).

Routes (school-scoped subtree under PRP-12; webhook is **public** but signature-gated):
- `POST /api/school/fees/gateway` (`fees.gateway`, write) · `GET /api/school/fees/gateway` (`fees.gateway`) · `PATCH /api/school/fees/gateway/enable` (`fees.gateway`, write) · `POST /api/school/fees/gateway/test` (`fees.gateway`)
- `POST /api/school/fees/checkout/intent` (`fees.pay` + parent-own-child, `requireWritableSchool`) · `POST /api/school/fees/checkout/verify` (`fees.pay`)
- `POST /api/school/fees/refunds` (`fees.gateway`, `requireWritableSchool`) · `GET /api/school/fees/reconciliation?from=&to=` (`fees.read`)
- **Webhook (public, no auth, signature-verified):** `POST /api/webhooks/payments/:provider` — registered **outside** the school-context/auth plugins (no `authenticate`, no `requireSchoolContext`), with the raw-body parser; resolves the school from the event (§3.4). Document the URL the school configures in its gateway dashboard. Optionally include an opaque per-school path token in addition to the signature, but the **HMAC signature is the real gate**.

All responses use `successResponse`/`errorResponse`; `Decimal`s serialized as strings. The webhook returns a bare `200`/`4xx`/`5xx` per §3.4 (the gateway, not our client, reads it).

### 3.7 Reconciliation sweep (job)
A daily `src/jobs/payment-reconciliation.job.ts` (`reconcileOnlinePayments(prisma)`) sweeps `PaymentIntent`s in `CREATED` past `expiresAt`: it calls `adapter.fetchPayment` to learn the true state — captured → reconcile (idempotent), failed/expired → mark `FAILED`/`EXPIRED`. This is the safety net if a webhook was missed/dropped. **Reuse PRP-05's job+script pattern:** add `src/scripts/runPaymentReconciliation.ts` + a `"payments:reconcile"` package.json script, schedulable by external cron or the same `ENABLE_INPROCESS_*`/`node-cron` flag PRP-05 introduced.

### 3.8 Permission strings (extend PRP-17/PRP-44 `fees` resource)
Reuses the `fees` resource (PRP-44); adds two keys — defined here, mirrored verbatim by FE PRP-62:
- `fees.gateway` — configure the gateway, enable/disable, test credentials, initiate refunds, read reconciliation (Admin/owner; refunds are money-back so owner-gated like billing per D16/PRP-21 is acceptable).
- `fees.pay` — **the PARENT-scoped** key to create a checkout intent + verify for their **own** child (a distinct key so the matrix grants parents pay-online without granting staff collection). Own-child scope is enforced by PRP-41 regardless of the permission.
Seed both into PRP-17's default role→permission map (Admin → `fees.gateway`; Parent → `fees.pay`). `fees.read` (PRP-44/46) covers reconciliation reads for staff.

## 4. Implementation steps
1. **Schema:** extend `PaymentMethod` (`ONLINE`) + `PaymentStatus` (`INITIATED`/`FAILED`/`REFUNDED`/`PARTIALLY_REFUNDED`); add `PaymentProvider` enum + `SchoolPaymentGateway`/`PaymentIntent`/`GatewayWebhookEvent`/`Refund`; add `Payment.providerOrderId`/`providerPaymentId` + `Payment.refunds` and the `School`/`Student` back-relations (coordinate the `Payment`/`School`/`Student` edits with PRP-46, §8). `pnpm exec prisma migrate dev --name online_payment_gateway` then `pnpm prisma:generate`.
2. **Crypto lib:** add `src/lib/crypto/secretsCrypto.ts` (AES-256-GCM, key-versioned); add `GATEWAY_ENC_KEY` (+ `_PREVIOUS`) to `src/config/shared-env.ts` (`sharedEnvProperties`, `AppConfig`, `readSharedEnv`), required-in-prod with a length check.
3. **Provider port:** add `src/modules/payments-online/providers/{types.ts, razorpay.adapter.ts, provider.registry.ts}`; add the `razorpay` dep **or** REST+HMAC via `fetch` (record the choice). Implement order/verify/fetch/refund/webhook-verify.
4. **Module:** add `src/modules/payments-online/{routes,controller,service,schema,types}.ts`. Implement `upsertGateway`/`getGatewayPublic`/`setEnabled`/`testCredentials`, `createCheckoutIntent`, `verifyCheckout`, `reconcileCapturedPayment` (reusing PRP-46 helpers), `createRefund`, `getReconciliationReport`.
5. **Webhook route:** register `POST /api/webhooks/payments/:provider` **outside** the auth/school-context plugins with a raw-body parser; verify HMAC (`timingSafeEqual`), persist `GatewayWebhookEvent` (idempotent), dispatch to reconcile/refund handlers (§3.4).
6. **Reconciliation job:** add `src/jobs/payment-reconciliation.job.ts` + `src/scripts/runPaymentReconciliation.ts` + package.json script (PRP-05 pattern).
7. **Routing:** register the school-scoped fee-online routes under `src/plugins/school.plugin.ts` (`fees.gateway`/`fees.pay`/`fees.read` + `requireWritableSchool` on writes); register the webhook route at the app root (`src/app.ts` or a dedicated public plugin) so no auth hook applies.
8. **Audit:** **awaited** `writeAudit()` (PRP-18) on `gateway.configured`, `gateway.enabled`, `payment.online_captured`, `payment.refund` (secrets redacted) (D22).
9. **Money & types:** all amounts `Decimal`, accept/return strings; Fastify JSON schemas + `CreateIntentBody`, `VerifyCheckoutBody`, `GatewayConfigBody`, `RefundBody`, `ReconciliationRow`, `GatewayPublicDto` (no secrets).

## 5. Files added / changed
- **Add:** `src/modules/payments-online/payments-online.routes.ts`, `payments-online.controller.ts`, `payments-online.service.ts`, `payments-online.schema.ts`, `payments-online.types.ts`; `src/modules/payments-online/providers/types.ts`, `razorpay.adapter.ts`, `provider.registry.ts`; `src/lib/crypto/secretsCrypto.ts`; `src/jobs/payment-reconciliation.job.ts`; `src/scripts/runPaymentReconciliation.ts`; the public webhook plugin/route (e.g. `src/plugins/webhooks.plugin.ts` or a route registered in `src/app.ts`)
- **Edit:** `prisma/schema.prisma` (+ migration — extend `PaymentMethod`/`PaymentStatus`, add the four models + `Payment`/`School`/`Student` relations, coordinated with PRP-46), `src/plugins/school.plugin.ts` (fee-online routes), `src/app.ts` (mount the public webhook route outside auth), `src/config/shared-env.ts` (`GATEWAY_ENC_KEY[_PREVIOUS]`), `package.json` (provider dep + the `payments:reconcile` script), `src/modules/email/email-template.registry.ts` (an online-receipt template), and PRP-17's permission seed (add `fees.gateway`/`fees.pay`)

## 6. Acceptance criteria
- [ ] A school can store gateway credentials; **secrets are AES-256-GCM-encrypted at rest** (`encryptedKeySecret`/`encryptedWebhookSecret` are ciphertext), never returned by any read endpoint, never logged; `keyId` is the only public field. `isEnabled` can only be set after a successful credential test.
- [ ] Creating a checkout intent verifies the parent owns the child (PRP-41), computes the amount **server-side** from outstanding `StudentFee` lines (never a client amount), creates an order **on the school's account**, and persists a `PaymentIntent` — guarded by `requireWritableSchool` + `fees.pay`.
- [ ] The webhook **verifies the HMAC signature against the school's decrypted secret with `timingSafeEqual`**; an invalid signature touches nothing (recorded `IGNORED`, `200`); a valid `payment.captured` reconciles into **PRP-46's** ledger as a `COMPLETED` `Payment` (method `ONLINE`) + allocations + a sequentially-numbered `Receipt` + PDF, and writes an **awaited** `payment.online_captured` audit entry.
- [ ] Reconciliation is **idempotent**: replaying the same webhook event (`@@unique[provider,providerEventId]`) or capturing the same order twice (`@@unique` on `providerOrderId`/`paymentId`) creates **exactly one** `Payment` (proven by a duplicate-event test).
- [ ] A `Refund` (full or partial) calls the provider on the school's account, reverses the right `StudentFee` lines on `refund.processed`, sets the `Payment` to `REFUNDED`/`PARTIALLY_REFUNDED`, and is audited — distinct from PRP-46's `VOID` (this is real money-back).
- [ ] The daily reconciliation job resolves stale `CREATED` intents via `fetchPayment` (captured → reconcile, else `FAILED`/`EXPIRED`); the reconciliation report flags gateway captures with no ledger row and vice-versa.
- [ ] **All money is `Decimal`**, serialized as strings; the platform never holds funds (orders are on the school's account); the ledger (PRP-46) remains the single source of truth.
- [ ] O-P7 assumptions (Razorpay; per-school direct KYC; settlement is the gateway's) are documented and the provider logic is isolated behind the adapter (no `razorpay` import outside `providers/`).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name online_payment_gateway` applies cleanly.
- Manual (Razorpay **test mode**, against a PRP-44/45 published plan + a PRP-46 ledger): configure test keys → enable; as a parent, create a checkout intent for own child → pay with a test card → confirm the webhook reconciles a `COMPLETED` online `Payment` + receipt PDF + dropped dues + audit row; replay the same webhook → no second `Payment`; send a tampered signature → ignored; issue a partial refund → ledger restores + `Payment` `PARTIALLY_REFUNDED`; run `pnpm payments:reconcile` after suppressing a webhook → the intent reconciles. Confirm no endpoint ever returns a secret.

## 8. Risks & rollback
- **O-P7 (gateway/KYC/settlement) ⚠︎ — the phase's defining unknown:** Razorpay + per-school-direct-KYC + gateway-owned-settlement are **assumptions**; isolate everything provider-specific behind the `PaymentProvider` port so a different choice is an adapter, not a rewrite. Re-confirm before build.
- **Funds-flow / RBI licensing (D7 — paramount):** the platform must **never** hold, escrow, or route funds — orders are created on the *school's* merchant account and money moves buyer → school directly. A "convenience" that introduces a platform-controlled collecting account makes us a regulated payment aggregator (PA licence, nodal accounts). Guard this property in review; it is the reason the whole model is per-school.
- **Webhook security (paramount):** raw-body HMAC + `timingSafeEqual` against the *school's* secret is the only thing standing between a spoofed event and a fake "paid" ledger entry. Verify over the exact bytes (raw-body parser, not the parsed object); never reconcile on an unverified or client-supplied signal; the sync callback is convenience only.
- **Idempotency (paramount):** gateways retry webhooks aggressively and the sync callback + webhook can both fire — every reconciliation must be idempotent on `providerOrderId`/`providerEventId`/`paymentId` (DB `@@unique` + a `P2002` catch). A duplicate must never double-credit. Mandatory duplicate-event test.
- **Money correctness:** amounts computed **server-side** from `StudentFee` (never the client); all `Decimal`; refund/partial-refund arithmetic must reconcile to the cent against the ledger (mirror PRP-46's allocation discipline + tests). The captured amount is checked against the intent.
- **Credential secrecy:** secrets are AES-256-GCM at rest with a versioned key for rotation; the data key (`GATEWAY_ENC_KEY`) is a production-required secret. A leaked secret = the school's gateway compromised — never log/return/audit it in plaintext; redact in error messages.
- **PDF/notification isolation (PRP-46 rule):** receipt rendering + notification ride PRP-46's seam and must stay **outside** the money-critical commit so a transient failure never loses a reconciled payment (regenerate the receipt on demand).
- **Refund vs. void seam:** PRP-46's `VOID` (correction, no money-back) and this PRP's `Refund` (real money-back via the gateway) are distinct — keep them separate in the model, the audit actions, and any FE copy (PRP-62) to avoid a reconciliation/compliance mix-up.
- **Shared `Payment`/`School`/`Student` edits (§8):** PRP-46 owns the base ledger; this PRP adds columns/relations — sequence the migration after PRP-46 and rebase the relation blocks cleanly (PRP-46/29 §8 convention).
- **Rollback:** additive module + four tables + the crypto lib + a public webhook route + one provider dep. Disable by leaving every school's `isEnabled:false` (online pay simply unavailable; manual PRP-46 collection continues). Full revert: drop the four tables, the `PaymentMethod`/`PaymentStatus` additions (no rows use them if never enabled), the webhook route, and the back-relations; PRP-46's manual flow is untouched.
