# PRP-63 — Online platform-subscription billing (optional)

> **Status:** Proposed · **Phase:** 7 · **Severity:** 🟠 Med · **Size:** L · **Optional** (resolves O-P0; the platform runs fine on PRP-15's SuperAdmin-marked-paid invoices until this lands)
> **Depends on:** PRP-15 (`SubscriptionPlan` / `SchoolSubscription` / `Invoice` + `markInvoicePaid` / `generateInvoiceForPeriod` + the grace→read-only→lock enforcement — this PRP lets a school **pay its platform `Invoice` online** instead of waiting for a SuperAdmin to mark it paid), PRP-61 (the **`PaymentProvider` port** + webhook-verify + idempotency + `src/lib/crypto` secrets encryption — **reused**, this time on the **platform's own** merchant account, not a school's), PRP-20 (SuperAdmin console APIs — plan/subscription management surfaces the platform-gateway config), PRP-21 (owner-only billing guard — only the school **owner** pays/views platform invoices, D16), PRP-18 (`writeAudit` — invoice payments are audited, D22), PRP-12 (school context), PRP-16 (school lifecycle — a paid invoice can transition a READ_ONLY/LOCKED school back to ACTIVE) · **Feeds:** FE PRP-24 (the billing/renew page — its v1 "request renewal / contact" CTA becomes a real **Pay invoice** button when this lands; see §Frontend)

## 1. Problem / current state
PRP-15 models the platform's own revenue: per-student `SubscriptionPlan`s, a per-school `SchoolSubscription` (trial → active → grace → read-only → lock), and `Invoice`s the platform raises to schools. But **collection of the platform fee is manual** — PRP-15 marks an `Invoice` `PAID` only when the **SuperAdmin** does it by hand (`markInvoicePaid`), explicitly because gateways were deferred (D7) and **O-P0** ("how is the school's subscription fee collected in v1 — manual-marked or online?") was left open. That means every renewal is a manual SuperAdmin step, and a school in GRACE/READ_ONLY can't self-restore by paying.

This PRP **resolves O-P0**: it lets a school **pay its platform invoice online**, reusing PRP-61's gateway machinery — but pointed at the **platform's own merchant account** (this is the one place the platform legitimately *is* the merchant, collecting *its own* SaaS fee from schools; it is **not** acting as an aggregator for third-party funds, so D7's licensing concern does not apply here). On a verified payment, the `Invoice` is marked `PAID` automatically and the subscription/lifecycle transitions (PRP-15/16) run — restoring a lapsed school without SuperAdmin intervention.

It is **marked optional** because the platform is fully operable without it (PRP-15's manual marking is the fallback); this PRP is the automation/self-serve upgrade.

> ⚠︎ **O-P7 / O-P0 assumptions (master §10):**
> - **Provider:** **Razorpay assumed**, reusing PRP-61's `PaymentProvider` port — but on **one platform-owned** merchant account (a single `PlatformPaymentGateway` config, not per-school). A different provider is the same adapter swap as PRP-61.
> - **Platform-as-merchant is legitimate here:** unlike fee collection (where the platform must *never* hold funds, D7), the platform **is** the payee for its own subscription fee. This is a normal SaaS merchant relationship, not payment aggregation — record the distinction so it isn't confused with PRP-61's per-school model.
> - **GST/tax invoicing** on the platform fee (the platform billing the school) is a **flagged open detail** — v1 stores the amount PRP-15 computed and the gateway reference; a GST-compliant tax-invoice PDF (GSTIN, HSN/SAC, place-of-supply) is a documented extension, not built here.

## 2. Goal & non-goals
- **Goal:** (1) a single **`PlatformPaymentGateway`** config (the platform's own provider keys, encrypted via PRP-61's `src/lib/crypto`) managed by the SuperAdmin (PRP-20); (2) an **owner-initiated checkout** endpoint that creates a provider order **on the platform account** for an OPEN `Invoice` (PRP-15) and returns the client handshake; (3) a **verify** endpoint + the **shared signed-webhook** path (PRP-61) that idempotently marks the `Invoice` `PAID`, sets `paidAt`, and triggers PRP-15's subscription transition + PRP-16's school-status restore (GRACE/READ_ONLY/LOCKED → ACTIVE); (4) a **`PlatformPayment`** record linking the `Invoice` ↔ the gateway payment (separate from school fee `Payment`s — different payee, different ledger). Owner-only (PRP-21); always reachable even when LOCKED (PRP-15 allow-list); audited (PRP-18). Plus the **Frontend** wiring (§Frontend) that turns PRP-24's placeholder renew CTA into a real Pay button.
- **Non-goals:** student **fee** collection (PRP-61 — different payee/ledger entirely; this is the *platform's* fee from the *school*); the subscription/trial/enforcement model (PRP-15 — consumed); plan management UI (PRP-20/22); dunning/auto-charge/saved-cards/mandates (a future extension — v1 is owner-initiated per-invoice payment, no stored mandate); proration (PRP-15 non-goal); GST tax-invoice PDFs (⚠︎ flagged extension); multi-currency (₹ only).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Reuses PRP-15's `Invoice` and PRP-61's `PaymentProvider` enum + `src/lib/crypto`. Adds two models (platform-scoped, **not** `schoolId`-partitioned the way tenant data is — the platform is the tenant here, though `PlatformPayment` references the paying school for reporting).

```prisma
model PlatformPaymentGateway {
  id                 String          @id @default(uuid())     // singleton-ish; SuperAdmin-managed
  provider           PaymentProvider @default(RAZORPAY)        // reuse PRP-61's enum
  isEnabled          Boolean         @default(false)
  mode               String          @default("LIVE")          // LIVE | TEST
  keyId              String                                    // platform public key/merchant id (client-side)
  encryptedKeySecret String                                    // AES-256-GCM via PRP-61 src/lib/crypto — NEVER plaintext
  encryptedWebhookSecret String
  keyVersion         Int             @default(1)
  lastVerifiedAt     DateTime?
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt
}

model PlatformPayment {
  platformPaymentId String   @id @default(uuid())
  invoiceId         String   @unique                           // the PRP-15 Invoice being paid (one live payment per invoice)
  schoolId          String                                     // paying school (reporting/scoping)
  provider          PaymentProvider
  providerOrderId   String   @unique                           // dedupe anchor (same discipline as PRP-61)
  providerPaymentId String?  @unique
  amount            Decimal  @db.Decimal(12, 2)                // ₹ — Decimal, mirrors Invoice.amount
  currency          String   @default("INR")
  status            String   @default("CREATED")               // CREATED | PAID | FAILED | EXPIRED
  paidAt            DateTime?
  invoice           Invoice  @relation(fields: [invoiceId], references: [invoiceId], onDelete: Cascade)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([schoolId])
  @@index([status])
  @@index([providerPaymentId])
}
```
Add back-relations: `Invoice.platformPayment PlatformPayment?` (coordinate this `Invoice` edit with PRP-15, §8). Reuse PRP-61's `GatewayWebhookEvent` for idempotency/dedupe (the webhook ingestion is shared; the dispatcher branches on whether the order belongs to a `PaymentIntent` (fees, PRP-61) or a `PlatformPayment` (this PRP)) — **or** add a `scope` discriminator to `GatewayWebhookEvent` if cleaner; record the choice.

> **Decision — reuse PRP-61's provider port + crypto + webhook security wholesale.** The only differences from PRP-61 are: (a) the merchant account is the **platform's own** (one `PlatformPaymentGateway`, not per-school); (b) the settled object is a PRP-15 **`Invoice`**, not a PRP-46 `StudentFee` ledger; (c) the post-payment side-effect is a **subscription/lifecycle transition** (PRP-15/16), not a receipt+allocation. Everything else — the `PaymentProvider` adapter, `verifyWebhookSignature` + `timingSafeEqual`, raw-body parsing, idempotency on `providerOrderId`/`providerEventId`, AES-256-GCM secret encryption (`src/lib/crypto`) — is **imported, not re-implemented**. This is why PRP-63 is small despite touching money.

### 3.2 Services & routes (`src/modules/platform-billing/`)
New module, standard split, `fastify`-first. Two surfaces: **SuperAdmin** gateway config (under PRP-20's `/developer` subtree) and **owner** invoice-pay (under the school subtree, owner-gated, billing-allow-listed).
- **Platform gateway config (SuperAdmin):** `upsertPlatformGateway` / `getPlatformGatewayPublic` / `setPlatformGatewayEnabled` / `testPlatformCredentials` — secrets write-only, encrypted via PRP-61's `src/lib/crypto`, **never returned**; `isEnabled` only after a passing test. Audited (`platform_gateway.configured`).
- **Owner invoice checkout:** `createInvoiceCheckout(fastify, { schoolId, ownerUserId, invoiceId })` — (a) assert the caller is the school **owner** (PRP-21); (b) load the `Invoice` (PRP-15), assert it is `OPEN` and belongs to the school; (c) the amount comes from `Invoice.amount` (PRP-15 computed it — never a client amount); (d) decrypt the platform secret, `adapter.createOrder` on the **platform** account; (e) persist `PlatformPayment{ status:'CREATED', providerOrderId }`; (f) return `{ providerOrderId, keyId, amount, currency, invoiceId }`. Reachable when LOCKED (billing allow-list, PRP-15 §3.3, D5).
- **Verify + reconcile (the one path):** `verifyInvoicePayment` (sync callback) and the shared webhook both call `markInvoicePaidFromGateway(fastify, tx, { platformPayment, providerPaymentId })` — idempotent on `providerOrderId`/`providerPaymentId`/`providerEventId`: set `PlatformPayment.status:'PAID'` + `paidAt`, call PRP-15's **`markInvoicePaid(invoiceId)`** (sets `Invoice.status:'PAID'`), then run PRP-15's subscription transition (period roll / status → ACTIVE) and PRP-16's `transitionSchoolStatus` so a GRACE/READ_ONLY/LOCKED school is restored to ACTIVE. **Awaited** `writeAudit('platform_invoice.paid', { invoiceId, amount, providerPaymentId })`. A captured-amount mismatch vs. `Invoice.amount` is logged + flagged (don't silently accept).
- **Webhook:** **reuse PRP-61's** `POST /api/webhooks/payments/:provider` ingestion (raw-body, HMAC against the **platform** webhook secret for platform orders, idempotent `GatewayWebhookEvent`). The dispatcher routes the event to fees-reconcile (PRP-61) or invoice-pay (this PRP) by looking up the `providerOrderId` against `PaymentIntent` vs `PlatformPayment`. Document the shared route.

Routes:
- SuperAdmin (under PRP-20 `/developer`, `requireDeveloper`): `POST /api/developer/platform-gateway` · `GET /api/developer/platform-gateway` · `PATCH /api/developer/platform-gateway/enable` · `POST /api/developer/platform-gateway/test`.
- Owner (school subtree, **owner-gated** PRP-21, **billing allow-listed** so reachable when LOCKED): `POST /api/school/billing/invoices/:invoiceId/checkout` · `POST /api/school/billing/invoices/:invoiceId/verify` · `GET /api/school/billing/invoices` (the school's invoices + pay state — owner-only).
- Webhook: shared `POST /api/webhooks/payments/:provider` (PRP-61).

All responses `successResponse`/`errorResponse`; `Decimal`s as strings; secrets never returned.

### 3.3 Enforcement interaction (PRP-15 / D5)
The invoice-pay + invoice-list routes must be in PRP-15's **billing allow-list** (the `config.subscription = { bypass: true }` flag) so a LOCKED school's **owner** can always pay to restore access — this is the whole point. A successful payment runs the PRP-15 transition that flips the school back to writable. Verify by test in the LOCKED state (mirrors PRP-15/24's fail-safe risk note).

### 3.4 Permission / role gating
No new fee-style permission resource — platform billing is **owner-only** (PRP-21's owner guard, D16), and the SuperAdmin gateway config is `requireDeveloper` (existing). If a key is wanted for the matrix, reuse PRP-24's `school.manage_billing` (owner-gated) for the owner-pay routes; SuperAdmin config stays developer-guarded. Record the choice (prefer the owner guard + `school.manage_billing` to keep it in the existing vocabulary).

## 4. Implementation steps
1. **Schema:** add `PlatformPaymentGateway` + `PlatformPayment` (reusing PRP-61's `PaymentProvider`); add `Invoice.platformPayment` back-relation (coordinate with PRP-15, §8); decide + apply the `GatewayWebhookEvent` scope discriminator if used. `pnpm exec prisma migrate dev --name online_platform_billing` then `pnpm prisma:generate`.
2. **Reuse crypto + provider port:** import PRP-61's `src/lib/crypto/secretsCrypto.ts` (encrypt the platform secret with the same `GATEWAY_ENC_KEY`) and the `PaymentProvider` adapter/registry (`provider.registry.getAdapter`). No new provider code.
3. **Module:** add `src/modules/platform-billing/{routes,controller,service,schema,types}.ts`. Implement the SuperAdmin gateway CRUD, `createInvoiceCheckout`, `verifyInvoicePayment`, and `markInvoicePaidFromGateway` (calling PRP-15's `markInvoicePaid` + transition and PRP-16's `transitionSchoolStatus`).
4. **Webhook dispatch:** extend PRP-61's webhook handler to route platform-order events to `markInvoicePaidFromGateway` (lookup `PlatformPayment` by `providerOrderId`; HMAC against the platform webhook secret). Keep idempotency via the shared `GatewayWebhookEvent`.
5. **Routing:** register SuperAdmin routes under PRP-20's `/developer` subtree; owner routes under the school subtree, **owner-gated (PRP-21)** and **added to PRP-15's billing allow-list** (`config.subscription.bypass`). Webhook stays the shared public route.
6. **Audit:** **awaited** `writeAudit()` on `platform_gateway.configured`, `platform_gateway.enabled`, `platform_invoice.paid` (secrets redacted) (D22).
7. **Money & types:** amounts `Decimal` from `Invoice.amount` (never client), strings on the wire; Fastify schemas + `PlatformGatewayConfigBody`, `InvoiceCheckoutResponse`, `InvoiceDto` (no secrets).

## Frontend (BE+FE PRP — brief)
This PRP spans BE+FE; the FE work is small because it **upgrades PRP-24's existing billing page** rather than building a new surface:
- **`src/store/subscription/` (extend PRP-24):** add `createInvoiceCheckout(invoiceId)` / `verifyInvoicePayment(result)` / `fetchInvoices()` services (via `apiClient` + `helper.*`) and `PlatformGatewayConfig` admin services under the developer store (PRP-22) for the SuperAdmin config screen.
- **Reuse the checkout seam:** the owner pays via the **same `useCheckout()` provider seam from FE PRP-62** (§3.4 there) — Razorpay Checkout with the **platform's** public `keyId` returned by the checkout endpoint. Single-source the launch logic; don't fork it.
- **`src/modules/billing/BillingScreen.tsx` (extend PRP-24):** PRP-24's v1 renew CTA was "request renewal / contact" (because collection was manual). When this PRP lands, that CTA becomes a real **Pay invoice** button per OPEN invoice → `createInvoiceCheckout` → launch → `verifyInvoicePayment` → on success show paid + the subscription banner (PRP-24) clears as the state flips to ACTIVE. The billing page **stays reachable in LOCKED** (PRP-24/PRP-15 allow-list) — that is what lets the owner self-restore.
- **SuperAdmin gateway config (PRP-22):** a small developer-console screen to set the **platform** gateway keys (secrets write-only, test, enable) — mirrors PRP-62's `GatewayConfig` shape but for the single platform account.
- **Owner-only:** the Pay button is owner-gated (PRP-21/`school.manage_billing`); amounts rendered verbatim (D1, no JS math); secrets write-only (never read back). The mobile billing flow (if any) reuses the same endpoints + types.

## 5. Files added / changed
- **Add (BE):** `src/modules/platform-billing/{routes,controller,service,schema,types}.ts`
- **Edit (BE):** `prisma/schema.prisma` (+ migration — two models + `Invoice.platformPayment`, coordinated with PRP-15; optional `GatewayWebhookEvent` scope), the shared webhook handler from PRP-61 (add platform-order dispatch), `src/plugins/developer.plugin.ts` or PRP-20's developer routes (SuperAdmin gateway config), `src/plugins/school.plugin.ts` (owner billing-pay routes + PRP-15 allow-list flag), PRP-17/24 permission seed if `school.manage_billing` is reused for the pay routes, PRP-15's `markInvoicePaid`/transition call-out (no change to its logic — just invoked)
- **Add/Edit (FE — brief, see §Frontend):** extend `src/store/subscription/*.services.ts` (+ developer store for the SuperAdmin config); extend `src/modules/billing/BillingScreen.tsx` (PRP-24) with the Pay-invoice button; add a SuperAdmin platform-gateway config screen (PRP-22 area); reuse FE PRP-62's `useCheckout()` seam

## 6. Acceptance criteria
- [ ] A SuperAdmin can store the **platform's** gateway keys (secrets **AES-256-GCM-encrypted** via PRP-61's `src/lib/crypto`, never returned); `isEnabled` only after a passing test.
- [ ] A school **owner** (PRP-21) can pay an **OPEN** `Invoice` (PRP-15) online; the amount comes from `Invoice.amount` (never a client amount); the order is created on the **platform** account.
- [ ] A verified payment (sync verify **or** the shared signed webhook) **idempotently** marks the `Invoice` `PAID`, sets `paidAt`, and runs PRP-15's subscription transition + PRP-16's status restore so a GRACE/READ_ONLY/LOCKED school returns to ACTIVE — proven by a duplicate-webhook test (exactly one `PAID`).
- [ ] The invoice-pay + invoice-list routes are **owner-gated** and in PRP-15's **billing allow-list** — reachable even when the school is LOCKED (verified by test); a non-owner is rejected.
- [ ] The webhook reuses PRP-61's HMAC-verified, idempotent ingestion (platform secret for platform orders); an invalid signature changes nothing.
- [ ] Invoice payments are audited (`platform_invoice.paid`, secrets redacted); **all money is `Decimal`** (strings on the wire); the platform-as-merchant scope is documented as distinct from PRP-61's per-school fee model.
- [ ] **(FE)** PRP-24's billing page shows a real **Pay invoice** button (owner-only) that uses PRP-62's `useCheckout()` seam with the platform `keyId`; on success the subscription banner clears; the page stays reachable when LOCKED.
- [ ] O-P0 is resolved (schools can pay the platform online); the feature is **optional** — disabling the platform gateway falls back cleanly to PRP-15's SuperAdmin-marked-paid invoices.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build` (BE); `yarn type-check && yarn lint && yarn build` (FE).
- `pnpm exec prisma migrate dev --name online_platform_billing` applies cleanly.
- Manual (Razorpay **test mode**): SuperAdmin configures + enables the platform gateway; backdate a school's `trialEndsAt`/period so it goes READ_ONLY/LOCKED (PRP-15); as the **owner**, open the billing page (confirm it loads while LOCKED) → **Pay invoice** → pay with a test card → the webhook marks the `Invoice` PAID and the school flips back to ACTIVE (writes work again); replay the webhook → no double-pay; a non-owner cannot pay.

## 8. Risks & rollback
- **Optional / fallback (lowest-risk framing):** the platform runs on PRP-15's manual marking without this; ship it as an automation upgrade. If the platform gateway is disabled, everything degrades to manual — no school is blocked.
- **Platform-as-merchant vs. aggregator (record clearly):** here the platform legitimately collects **its own** SaaS fee (normal merchant relationship) — this is **not** PRP-61's per-school no-funds model and **not** payment aggregation (D7's licensing concern is about routing *third-party* funds, which this doesn't). Keep the two gateways (`PlatformPaymentGateway` vs `SchoolPaymentGateway`) and their ledgers (`PlatformPayment`/`Invoice` vs `Payment`/`StudentFee`) firmly separate so reporting/compliance never conflates them.
- **Fail-safe billing reachability (D5 — paramount):** the owner-pay route **must** be in PRP-15's allow-list and reachable when LOCKED — a bug here strands a lapsed school with no way to self-restore. Verify by test in LOCKED (mirrors PRP-15/24).
- **Idempotency + webhook security (paramount, inherited from PRP-61):** reuse PRP-61's HMAC + `timingSafeEqual` + raw-body + `@@unique` dedupe (platform secret for platform orders); a duplicate event must never mark/transition twice. Mandatory duplicate-webhook test.
- **Subscription-transition correctness:** marking an invoice paid must trigger exactly PRP-15's period roll + PRP-16's status restore — reuse their helpers (don't re-implement the ladder); a mismatch could leave a paid school still READ_ONLY or roll the period wrong.
- **Money correctness:** amount is `Invoice.amount` (PRP-15, `Decimal`) — never client-supplied; the captured amount is checked against it.
- **Secret secrecy:** the platform secret is as sensitive as a school's — AES-256-GCM via the shared `GATEWAY_ENC_KEY`, never logged/returned.
- **GST/tax invoice (⚠︎ flagged):** v1 records the amount + gateway reference only; a GST-compliant tax-invoice PDF is a noted extension (reuses PRP-46's `src/modules/pdf/`), not built here.
- **Shared webhook + `Invoice` edits (§8):** the webhook handler and `GatewayWebhookEvent` are shared with PRP-61 — land after PRP-61 and branch the dispatcher cleanly; the `Invoice.platformPayment` relation is coordinated with PRP-15.
- **Rollback:** additive (one module + two tables + a webhook-dispatch branch + a small FE extension). Disable by leaving `PlatformPaymentGateway.isEnabled:false` (falls back to PRP-15 manual marking). Full revert: drop the two tables + the `Invoice` back-relation + the dispatch branch; PRP-15's manual flow is untouched.
