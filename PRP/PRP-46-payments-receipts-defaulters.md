# PRP-46 — Manual payments + receipt PDFs + defaulter reports/reminders

> **Status:** Proposed · **Phase:** 4 · **Severity:** 🔴 High · **Size:** XL
> **Depends on:** PRP-44 (`FeePlan`/`FeePlanItem` + `resolvePublishedPlan`), PRP-45 (`computeStudentDues` + `accrueFinesForStudent` — dues/charges the payment settles), PRP-32 (`Enrollment` — students to bill; defaulter lists are per class/section), PRP-31 (guardian linkage — receipts/reminders go to the parent), PRP-41 (parent portal APIs — the parent fee/dues view aggregates over a parent's children), PRP-18 (`writeAudit` — payments are an audited critical action, D22), PRP-17 (`fees.*` perms from PRP-44 — `fees.collect`), PRP-12 (school context), PRP-15 (`requireWritableSchool`) · **Feeds:** PRP-48 (FE fee-collection + parent fee view), and P7 PRP-61 (online payments extend the same `Payment`/ledger model — OUT of scope here, D7)

## 1. Problem / current state
PRP-44 publishes plans; PRP-45 computes per-student **charges** (plan ± adjustments + fines). But nothing **records that money was received**, nothing produces a **receipt**, and nothing tells a school **who hasn't paid**. Decision **D7** scopes v1 to **manual/offline** collection: cash / cheque / bank-transfer recorded by school staff, with a **PDF receipt** and **defaulter reports + reminders** — explicitly **no payment gateway** (that is P7/PRP-61). Decision **D22** lists payments as a first-class audited action.

This is the keystone of P4: it introduces the **per-student dues ledger** (`StudentFee` — the materialized outstanding balance the FE and reminders read), the `Payment` record, the `Receipt` (with sequential numbering + PDF), and the **first server-side PDF generation** in the platform — a cross-cutting service that PRP-51 (report cards) and PRP-66 (certificates/ID cards) will reuse. No PDF library exists in the backend today (no `pdfkit`/`puppeteer`/`@react-pdf` in `package.json`); this PRP stands one up.

> ⚠︎ **Open questions (master §10 O-P4):**
> - **Receipt numbering/format** — not finalized. This PRP uses a **per-school, per-year sequential** receipt number (`<prefix>/<YYYY-YY>/<NNNN>`) generated atomically; treat the prefix/format as configurable. (Assumption: gap-free per school per year.)
> - **Pre-gateway refund handling** — out of scope. A payment may be **VOID**ed (mistake correction, audited) but money-back **refunds are not modeled** here; flag the seam for P7. A void reverses the ledger effect; it is not a refund.

## 2. Goal & non-goals
- **Goal:** a `StudentFee` per-student dues ledger (materialized from PRP-45's `computeStudentDues`, kept current as payments post), a `Payment` model (CASH / CHEQUE / BANK_TRANSFER / OTHER — all *manual*), a `Receipt` model with **atomic sequential numbering** + a **server-generated PDF** (via a new cross-cutting `src/modules/pdf/` service + `src/lib/storage`), a **defaulter report** API (who owes what, per class/section/year, as-of a date), and a **reminder** trigger (queue a notification to the guardian). Plus the **parent fee/dues view** API (a parent sees each child's plan, dues, payments, receipts) wired through PRP-41's multi-child aggregation.
- **Non-goals:** plan/head/adjustment/fine *configuration* (PRP-44/45 — this PRP *consumes* their helpers), online payment + gateway + true refunds (P7/PRP-61, D7 ⚠︎), the FE screens (PRP-48), the notification *engine* internals (P6/PRP-54 — this PRP fires an event/queues a row through whatever notification skeleton exists, e.g. email via the existing Brevo `emailTemplateService`; rich multi-channel is P6). Cheque-clearance/bank-reconciliation workflow beyond a `chequeStatus` field is deferred.

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`)
Decimal/year-scope discipline from PRP-44/45; enums from `src/generated/prisma/enums.js`.

```prisma
enum PaymentMethod {
  CASH
  CHEQUE
  BANK_TRANSFER
  DD              // demand draft
  OTHER
}

enum PaymentStatus {
  COMPLETED       // recorded & settled (cash/transfer) — affects ledger immediately
  PENDING         // cheque/DD not yet cleared
  VOID            // reversed (mistake correction, audited) — NOT a refund (O-P4 ⚠︎)
}

model StudentFee {
  studentFeeId   String   @id @default(uuid())
  schoolId       String
  academicYearId String
  studentId      String
  feePlanItemId  String?                                 // line this row tracks (PRP-44); null = a fine/ad-hoc line
  feeHeadId      String?
  termId         String?
  // Non-null discriminator that makes the uniqueness real even for fine/ad-hoc lines (feePlanItemId NULL).
  // Plan lines: lineKey = feePlanItemId. Fine/ad-hoc lines: a deterministic key, e.g. `fine:${fineId}` /
  // `adhoc:${slug}`, so the @@unique below dedupes them instead of NULL-distinct letting duplicates through.
  lineKey        String
  dueAmount      Decimal  @db.Decimal(12, 2)             // net charge for this line (from computeStudentDues, PRP-45)
  paidAmount     Decimal  @db.Decimal(12, 2) @default(0) // running total allocated to this line
  dueDate        DateTime?
  isPaid         Boolean  @default(false)                // paidAmount >= dueAmount
  student        Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([studentId, academicYearId, lineKey])         // lineKey is non-null → dedupes plan AND fine/ad-hoc lines
  @@index([schoolId])
  @@index([studentId, academicYearId])
  @@index([isPaid, dueDate])                             // defaulter queries
}

model Payment {
  paymentId      String        @id @default(uuid())
  schoolId       String
  academicYearId String
  studentId      String
  amount         Decimal       @db.Decimal(12, 2)        // ₹ received — Decimal, never float
  method         PaymentMethod
  status         PaymentStatus @default(COMPLETED)
  reference      String?                                 // cheque no / txn id / DD no
  chequeStatus   String?                                 // PENDING | CLEARED | BOUNCED (cheque only)
  paidOn         DateTime      @default(now())
  collectedByUserId String?                              // staff who recorded it (UserSchool/User)
  note           String?
  allocations    PaymentAllocation[]                     // how this payment splits across StudentFee lines
  receipt        Receipt?
  student        Student       @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school         School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  @@index([schoolId])
  @@index([studentId, academicYearId])
  @@index([status])
}

model PaymentAllocation {
  paymentAllocationId String   @id @default(uuid())
  schoolId            String
  paymentId           String
  studentFeeId        String                              // which due line this slice paid
  amount              Decimal  @db.Decimal(12, 2)
  payment             Payment  @relation(fields: [paymentId], references: [paymentId], onDelete: Cascade)
  createdAt           DateTime @default(now())

  @@index([paymentId])
  @@index([studentFeeId])
}

model Receipt {
  receiptId      String   @id @default(uuid())
  schoolId       String
  academicYearId String
  paymentId      String   @unique
  receiptNo      String                                   // per-school per-year sequential (§3.3) — O-P4 ⚠︎
  sequence       Int                                      // raw counter behind receiptNo
  pdfKey         String?                                  // storage key for the generated PDF (§3.4)
  issuedAt       DateTime @default(now())
  payment        Payment  @relation(fields: [paymentId], references: [paymentId], onDelete: Cascade)
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())

  @@unique([schoolId, academicYearId, sequence])          // gap-free per school per year
  @@unique([schoolId, receiptNo])
  @@index([schoolId])
}
```
Add back-relations to `School` (`studentFees`, `payments`, `receipts`) and `Student` (`studentFees`, `payments` — coordinate with PRP-44/45/31/29 which also extend `Student`, §8). `StudentFee.feePlanItemId`/`termId`/`feeHeadId` are loose references (no FK blocks) to stay decoupled from PRP-44.

> **`StudentFee` uniqueness with NULL-distinct (the dedupe fix):** the natural key `(studentId, academicYearId, feePlanItemId)` is unsafe because `feePlanItemId` is **nullable** for fine/ad-hoc lines and Postgres treats every `NULL` as distinct — two ad-hoc/fine rows for the same student/year would **both** satisfy the constraint and the reconciler could double-insert. The fix is the **non-null `lineKey` discriminator**: plan lines set `lineKey = feePlanItemId`; fine/ad-hoc lines set a deterministic key (e.g. `fine:${fineId}`, `adhoc:${slug}`). The unique is `@@unique([studentId, academicYearId, lineKey])` — always over non-null columns, so `syncStudentFees`' upsert is idempotent for **every** line type, not just plan-item lines. (`feePlanItemId` is kept as the loose plan reference for joins/reporting.)

> **Decision — ledger materialized + reconciled, payments allocated:** `computeStudentDues` (PRP-45) is the *source of truth for charges*; `StudentFee` is its **materialization** so defaulter queries and the parent view are a cheap indexed read (not a recompute per student). A `syncStudentFees(fastify, tx, {studentId, academicYearId})` reconciler upserts `StudentFee` rows from `computeStudentDues` (called on enrollment, plan publish for the class, adjustment change, and lazily before a payment). A `Payment` carries `PaymentAllocation`s that decrement specific `StudentFee` lines (oldest-due-first by default, overridable), keeping `paidAmount`/`isPaid` correct. This split (compute → materialize → allocate) is what lets the FE show a fast dues table while the math stays in one tested place (PRP-45).

### 3.2 Cross-cutting PDF + storage service (new, reused beyond P4)
This PRP introduces — and is the **canonical owner of** — the platform's **first server-side PDF generation** and its S3-compatible storage abstraction (master §5.6: "PDF generation: server-side (receipts P4, report cards P5, TC/ID cards P8)"). These two services are deliberately generic and **single-sourced here**; **PRP-49 (admit cards), PRP-51 (report cards/marksheets), and PRP-66 (certificates/ID cards) all consume *these exact modules* and add only their own template — none of them stands up a second PDF library or a parallel storage util.** The contract the downstream PRPs code against:
- **`src/modules/pdf/pdf.service.ts`** — the canonical renderer, **object-arg signature `renderPdf({ template, data }) → Buffer`** (this is the fixed interface PRP-49/51/66 call — do not introduce a positional `renderPdf(template, data)` variant elsewhere). Pick **one** dependency-light, serverless-friendly engine and record the choice here: a templating-to-PDF approach (e.g. an HTML string → PDF via a lightweight renderer) or a programmatic builder (`pdfkit`). ⚠︎ Engine choice is an open implementation decision — prefer one that needs no headless-Chrome binary in the deploy image (operational simplicity) unless pixel-perfect HTML fidelity is required; document the tradeoff. Templates live in `src/modules/pdf/templates/` (a `receipt` template first; downstream PRPs append `admit-card`/`report-card`/`marksheet`/certificate templates to this same directory + registry), mirroring how `src/modules/email/templates/` + `email-template.registry.ts` are organized.
- **`src/lib/storage/`** — the canonical S3-compatible storage abstraction (master §5.6: "File storage: S3-compatible"), reused by every feature that stores/serves an object (receipts here, report-card PDFs PRP-51, certificates PRP-66, attachments PRP-55/56/57). `putObject(key, buffer, contentType) → { key }` and `getSignedUrl(key) → url`. v1 may back this with local disk behind the same interface if S3 creds aren't wired yet (note the seam); the `Receipt.pdfKey` stores the returned key. Add storage config keys to `src/config/shared-env.ts` (`STORAGE_*`) following the existing `BREVO_*` pattern (add to `sharedEnvProperties`, `AppConfig`, `readSharedEnv`). There is **one** `src/lib/storage/` + one set of `STORAGE_*` env keys for the whole platform — no parallel storage util or env block in any later PRP.
- New `package.json` dependency for the chosen PDF engine (the first one in the backend).

### 3.3 Atomic receipt numbering
Receipts must be **gap-free per school per year** (audit/compliance). Generate the sequence inside the same transaction as the `Payment`/`Receipt` insert:
- A `getNextReceiptSequence(tx, schoolId, academicYearId)` that either uses a dedicated `ReceiptCounter` row (`@@unique([schoolId, academicYearId])`, `SELECT … FOR UPDATE` then increment) **or** `MAX(sequence)+1` under the `@@unique([schoolId, academicYearId, sequence])` constraint with a retry on `P2002`. Prefer the counter-row approach to avoid contention races. Format `receiptNo = `${prefix}/${yearLabel}/${seq.padStart(4,'0')}` (prefix from school config/branding — default the subdomain or a `RECEIPT_PREFIX`). The `@@unique` constraints are the hard guarantee even if the helper races.

### 3.4 Services & routes (extend `src/modules/fees/`)
Add `payments.{routes,controller,service,schema,types}.ts` + `defaulters.{...}` (or fold into one `payments` set). All `fastify`-first, tenant-scoped via `request.schoolContext.schoolId`.
- **Record payment:** `recordPayment(fastify, schoolId, { studentId, academicYearId, amount, method, reference?, paidOn?, allocations? })` — one transaction: (a) lazily `accrueFinesForStudent` (PRP-45) + `syncStudentFees`; (b) insert `Payment` (status `COMPLETED`, or `PENDING` for uncleared cheque); (c) build `PaymentAllocation`s (provided split, else oldest-due-first) and decrement `StudentFee.paidAmount`/`isPaid`; (d) `getNextReceiptSequence` + insert `Receipt`; (e) render the PDF (`pdf.service`) + `putObject` → set `Receipt.pdfKey`; (f) `writeAudit('payment.record', metadata {amount, method, receiptNo})` — **awaited** (D22 makes payments auditable); (g) queue a receipt notification to the guardian (PRP-41/email skeleton). PDF render failure must **not** roll back the recorded payment — generate lazily/retriably and tolerate a null `pdfKey` (regenerate on download).
- **Void payment:** `voidPayment(fastify, schoolId, paymentId, reason)` — sets `status: VOID`, reverses allocations (restore `StudentFee.paidAmount`), audited (`payment.void`). Documented as **not** a refund (O-P4 ⚠︎).
- **Cheque clearance:** `updateChequeStatus(paymentId, CLEARED|BOUNCED)` — a bounced cheque reverses the ledger like a void; audited.
- **Receipt fetch:** `getReceiptPdf(fastify, schoolId, receiptId)` — returns a signed URL or streams the buffer (regenerating if `pdfKey` is null).
- **Defaulters:** `getDefaulters(fastify, schoolId, { academicYearId, gradeId?, sectionId?, asOf? })` — students with any `StudentFee` where `!isPaid` and `dueDate <= asOf`, grouped per student with outstanding totals (reads `StudentFee`, joins `Enrollment`/`Student`). `getStudentLedger(studentId, academicYearId)` — the per-student dues + payments + receipts statement.
- **Reminders:** `sendDefaulterReminders(fastify, schoolId, { academicYearId, gradeId?, studentIds? })` — for each defaulter, queue a guardian notification (template `feeReminder`; via the existing email skeleton in v1, multi-channel in P6/PRP-54). Audited (`fee.reminder_sent`, count in metadata).
- **Parent view (PRP-41 contract):** `getParentChildrenFees(fastify, parentUserId, academicYearId)` — resolves the parent's children through **PRP-41's `resolveParentChildren(fastify, parentUserId, { schoolId })`** (the single guardian-edge authorization gate), **not** by re-deriving the `ParentStudent` join here — so the link rule stays single-sourced with PRP-41/49/51/64/68. For each resolved child it returns `computeStudentDues` + outstanding + receipts. Exposed through PRP-41's parent-portal aggregation route (this module supplies the per-child fee block); a `studentId` not in the caller's linked children → `403/404` (don't leak existence).

Routes (school-scoped subtree; **collection** routes guarded by `requirePermission('fees.collect')` + `requireWritableSchool`; reads by `fees.read`):
- `POST /api/school/payments` (`fees.collect`) · `POST /api/school/payments/:paymentId/void` (`fees.collect`) · `PATCH /api/school/payments/:paymentId/cheque-status` (`fees.collect`)
- `GET /api/school/receipts/:receiptId/pdf` (`fees.read`)
- `GET /api/school/students/:studentId/ledger?academicYearId=` (`fees.read`)
- `GET /api/school/fees/defaulters?academicYearId=&gradeId=&sectionId=&asOf=` (`fees.read`)
- `POST /api/school/fees/reminders` (`fees.collect`)
- Parent: `GET /api/parent/fees?academicYearId=` (registered under PRP-41's parent subtree; service here) — guarded by **`parent.read_child_fees`** (the PRP-41 `parent.*` family, **not** the staff-side `fees.read`), scoped via `resolveParentChildren`; parent sees only their own children's fees (never trusts a client `studentId`).

All responses use `successResponse`/`errorResponse`; `Decimal`s serialized as strings.

### 3.5 Permission strings
Reuses PRP-44's `fees` resource for **staff**: `fees.collect` (record/void/reminders), `fees.read` (ledger/defaulters/receipt PDF). The **parent** fee view is **not** gated by the staff `fees.read`; it uses **`parent.read_child_fees`** from PRP-41's `parent.*` family (the same family as `parent.read_child_results` in PRP-51), seeded into the PARENT row, combined with the `resolveParentChildren` link check — so a parent gets their children's fees without holding any staff collection/read verb. (If PRP-41 has not yet reserved `parent.read_child_fees`, seed it here into the PARENT row, mirroring how PRP-51 seeds `parent.read_child_results`.)

## 4. Implementation steps
1. **Schema:** add `PaymentMethod`/`PaymentStatus`, `StudentFee`/`Payment`/`PaymentAllocation`/`Receipt` (+ a `ReceiptCounter` if used) + `School`/`Student` back-relations; `pnpm exec prisma migrate dev --name payments_receipts` then `pnpm prisma:generate`. Coordinate the `Student` edit (§8).
2. **PDF service:** add `src/modules/pdf/pdf.service.ts` + `src/modules/pdf/templates/receipt.*` + a registry mirroring `email-template.registry.ts`; add the chosen PDF dependency to `package.json`. Add `src/lib/storage/` (S3-compatible `putObject`/`getSignedUrl`, local-disk fallback behind the interface) + `STORAGE_*` config in `shared-env.ts`.
3. **Ledger reconciler:** implement `syncStudentFees(tx)` from PRP-45's `computeStudentDues`; wire it to run on enrollment / plan publish / adjustment change (call sites in PRP-44/45/32) and lazily before payment.
4. **Payments module:** add `payments.{routes,controller,service,schema,types}.ts` to `src/modules/fees/`. Implement `recordPayment` (the multi-step transaction, §3.4), `voidPayment`, `updateChequeStatus`, allocation logic, and `getNextReceiptSequence` (§3.3).
5. **Defaulters + reminders:** implement `getDefaulters`/`getStudentLedger`/`sendDefaulterReminders` (reminders queue through the email skeleton / PRP-54 when present).
6. **Parent view:** implement `getParentChildrenFees`; register its route under PRP-41's parent subtree (own-children scoping).
7. **Routing:** register fee-collection + read routes under `src/plugins/school.plugin.ts`; `requirePermission` (`fees.collect`/`fees.read`) + `requireWritableSchool` on collection writes.
8. **Audit:** **awaited** `writeAudit()` (PRP-18) on `payment.record`, `payment.void`, cheque bounce, `fee.reminder_sent` (D22: payments are auditable).
9. **Money:** all amounts `Decimal` (PRP-44 import path), accept/return as strings.
10. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + `RecordPaymentBody`, `DefaulterRow`, `StudentLedger`, `ReceiptDto`, `ParentFeesResponse`.

## 5. Files added / changed
- **Add:** `src/modules/fees/payments.routes.ts`, `payments.controller.ts`, `payments.service.ts`, `payments.schema.ts`, `payments.types.ts` (defaulters/reminders may be co-located or split); `src/modules/pdf/pdf.service.ts`, `src/modules/pdf/pdf.registry.ts`, `src/modules/pdf/templates/receipt.*`; `src/lib/storage/index.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (fee-collection routes) + the parent subtree registration (PRP-41), `src/config/shared-env.ts` (`STORAGE_*` + optional `RECEIPT_PREFIX`), `package.json` (PDF engine dep), `src/modules/email/email-template.registry.ts` (+ a `feeReminder`/receipt-notification template)

## 6. Acceptance criteria
- [ ] `StudentFee`/`Payment`/`PaymentAllocation`/`Receipt` tables exist with the documented uniques + indexes; **all money columns are `Decimal`**; receipt numbering is **gap-free per school per year** (enforced by `@@unique` + the counter, proven by a concurrent-insert test).
- [ ] Recording a payment (cash) creates a `Payment` + allocations that reduce the right `StudentFee` lines, generates a `Receipt` with a sequential number, produces a **PDF** (stored, downloadable), and writes an **awaited** `payment.record` audit entry.
- [ ] A cheque can be recorded `PENDING` and later `CLEARED`/`BOUNCED`; a bounce (or a `void`) reverses the ledger; neither is a refund (documented).
- [ ] `getDefaulters` returns the unpaid students for a class/section/year as-of a date with correct outstanding totals (reads the materialized ledger); `getStudentLedger` returns dues + payments + receipts.
- [ ] `sendDefaulterReminders` queues a guardian notification per defaulter and is audited.
- [ ] A parent sees **only their own children's** fees/dues/receipts via the PRP-41 parent route — gated by `parent.read_child_fees` (not the staff `fees.read`) and scoped via `resolveParentChildren` (PRP-41); a client-supplied `studentId` cannot widen scope.
- [ ] PDF generation failure does not roll back a recorded payment (lazy/retriable; `pdfKey` may be null and regenerate on download).
- [ ] All collection routes are `fees.collect` + `requireWritableSchool`-gated; reads are `fees.read`; tenant-scoped throughout.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name payments_receipts` applies cleanly.
- Manual (against PRP-44/45/32 data): record a cash payment for a student → receipt PDF downloads, ledger drops, audit row present; record a cheque PENDING → clear it; query defaulters for a section; send reminders; hit `/api/parent/fees` as a parent and confirm only their children appear.

## 8. Risks & rollback
- **Money correctness (paramount):** every amount is `Decimal`; allocation arithmetic (split a payment across lines, restore on void) must reconcile to the cent — cover with tests including overpayment/partial/void (D1, PRP-15/44/45).
- **Receipt-number integrity:** gap-free sequencing is the compliance-sensitive part — the counter-row + `@@unique` is the guarantee; the concurrent-insert test is mandatory. Never derive `receiptNo` outside the transaction.
- **First PDF service is cross-cutting:** PRP-51 (report cards) and PRP-66 (certificates) will reuse `src/modules/pdf/` + `src/lib/storage/` — design the interface generically now (template registry like email's), and pick a deploy-friendly engine (avoid bundling headless Chrome unless needed). Record the engine decision in the PR.
- **PDF/storage failure isolation:** rendering/uploading must be outside the money-critical commit boundary (or compensating) so a transient S3/PDF error never loses a recorded payment; regenerate receipts on demand from the immutable `Payment`/`Receipt` data.
- **Notification dependency:** v1 reminders ride the existing Brevo email skeleton; full multi-channel is P6/PRP-54 — keep the call behind a thin "queue notification" seam so P6 can swap the transport without touching fee logic.
- **Refunds out of scope (O-P4 ⚠︎):** only `VOID`/bounce reversals exist; true money-back refunds are P7/PRP-61 — note the seam (a future `Refund` against a `Payment`), build nothing.
- **Shared `Student` edit (§8):** PRP-44/45/46 + PRP-31/29 all extend `Student`; sequence the migrations and rebase the relation blocks cleanly (PRP-29 §8 convention).
- Rollback: additive module + tables + the new `pdf`/`storage` libs + one dependency; revert the modules, drop the tables, remove back-relations. The PDF/storage code is inert if no route calls it.
