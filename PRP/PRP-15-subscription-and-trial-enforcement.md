# PRP-15 — Subscription, trial model & write-enforcement

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P1-BE-2 (master-prp §5.3/§7.1.2, decisions D2/D3/D4/D5) · **Depends on:** PRP-16 (school lifecycle — `activate` creates the subscription & sets the trial), PRP-12 (school context/tenant scoping the enforcement hook layers on top of) · **Feeds:** PRP-20 (plan/subscription management), PRP-24 (FE subscription UX), PRP-18 (audit on subscription changes)

## 1. Problem / current state
There is **no subscription, billing, or trial model and no write-enforcement** anywhere. `School` has only a lifecycle `status` (extended by PRP-16); nothing computes "can this school write today?" Per the decision log this is core to v1: per-student pricing (D2), selectable monthly/quarterly/half-yearly/yearly cadence (D3), a per-school **configurable trial** (default 60 days, set at activation, extendable — D4), and a **grace → read-only → lock** enforcement ladder where the Admin can **always** reach billing (D5).

The only request-scoped authorization today is `requireAuth` (`src/middlewares/auth.middleware.ts`) and `requireDeveloper` (`src/middlewares/developer.middleware.ts`); PRP-12 adds `requireSchoolContext`/`requirePermission` and `request.schoolContext`. This PRP adds the orthogonal **subscription** gate that sits *after* school-context resolution and decides read-vs-write.

## 2. Goal & non-goals
- **Goal:** `SubscriptionPlan` / `SchoolSubscription` / `Invoice` models + a `SubscriptionStatus` enum; an enforcement Fastify hook/plugin that loads the active school's subscription per request, computes effective access, decorates `request.subscriptionState`, and exposes a `requireWritableSchool` guard; lazy status transition on read + a daily transition job.
- **Non-goals:** online collection of platform fees (D7/O-P0 — v1 invoices are SuperAdmin-marked-paid; no gateway), per-school plan overrides, proration/dunning emails, the SuperAdmin plan-management API surface (PRP-20 — this PRP exposes the services it calls), the FE banners/billing page (PRP-24).

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```
enum BillingCadence { MONTHLY QUARTERLY HALF_YEARLY YEARLY }

enum SubscriptionStatus {
  TRIALING    // within trial → writable
  ACTIVE      // paid period current → writable
  GRACE       // just lapsed → writable + banner flag
  READ_ONLY   // grace elapsed → reads only
  LOCKED      // fully locked → only auth + billing routes
  CANCELLED   // ended; behaves like LOCKED for access
}

model SubscriptionPlan {
  planId          String   @id @default(uuid())
  name            String   @unique
  perStudentRate  Decimal  @db.Decimal(10, 2)   // ₹ per student (D2)
  allowedCadences BillingCadence[]               // which cadences this plan permits (D3)
  featureFlags    Json     @default("{}")        // forward-looking gating
  isActive        Boolean  @default(true)
  subscriptions   SchoolSubscription[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model SchoolSubscription {
  subscriptionId     String             @id @default(uuid())
  schoolId           String             @unique          // one active subscription per school
  planId             String
  status             SubscriptionStatus @default(TRIALING)
  cadence            BillingCadence     @default(MONTHLY)
  trialDays          Int                @default(60)      // set at activation by PRP-16 (D4)
  trialEndsAt        DateTime?
  currentPeriodStart DateTime?
  currentPeriodEnd   DateTime?
  seatCount          Int                @default(0)       // billable students; recomputed in P2+
  graceUntil         DateTime?                            // computed: end + GRACE_DAYS
  school             School             @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  plan               SubscriptionPlan   @relation(fields: [planId], references: [planId])
  invoices           Invoice[]
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt
  @@index([status])
  @@index([trialEndsAt])
  @@index([currentPeriodEnd])
}

model Invoice {
  invoiceId      String             @id @default(uuid())
  subscriptionId String
  schoolId       String
  amount         Decimal            @db.Decimal(12, 2)
  cadence        BillingCadence
  periodStart    DateTime
  periodEnd      DateTime
  status         String             @default("OPEN")   // OPEN | PAID | VOID — v1 marked-paid by SuperAdmin (O-P0)
  paidAt         DateTime?
  subscription   SchoolSubscription @relation(fields: [subscriptionId], references: [subscriptionId], onDelete: Cascade)
  createdAt      DateTime           @default(now())
  @@index([schoolId])
  @@index([status])
}
```
Add the back-relation `subscription SchoolSubscription?` to `School`.

### 3.2 Effective-access computation
A pure helper `computeEffectiveAccess(sub, now) → { status, writable, banner, transitionTo? }` is the single source of truth:

| Condition (in order) | Effective | writable | notes |
|----------------------|-----------|----------|-------|
| `now < trialEndsAt` (and trialing) | `TRIALING` | ✅ | trial countdown surfaced to FE |
| period current (`now < currentPeriodEnd`) | `ACTIVE` | ✅ | |
| `currentPeriodEnd ≤ now < graceUntil` | `GRACE` | ✅ | `banner: true` |
| `graceUntil ≤ now` | `READ_ONLY` | ❌ writes | reads allowed |
| status `LOCKED`/`CANCELLED`, or SuperAdmin lock | `LOCKED` | ❌ all | except auth + billing |

`GRACE_DAYS` and the trial default come from config (§3.5). The helper also returns `transitionTo` when the **persisted** `status` is stale relative to the computed one (drives lazy transition, §3.4).

### 3.3 Enforcement hook + `requireWritableSchool`
A `src/plugins/subscription.plugin.ts` (wrapped in `fastify-plugin`, `dependencies: ['prisma', 'auth']`) adds:
- an `onRequest`/`preHandler` hook (runs **after** PRP-12's `requireSchoolContext`) that, for school-scoped requests, loads `SchoolSubscription` for `request.schoolContext.schoolId`, runs `computeEffectiveAccess`, and decorates `request.subscriptionState = { status, writable, banner }`;
- a `requireWritableSchool` guard (decorated on the instance, like `authenticate`) that throws `fastify.httpErrors.forbidden('School is read-only — subscription action required')` (or a 402-style payment-required via `httpErrors.paymentRequired`) when `!writable`, **unless** the route is allow-listed.

**Allow-list (fail-safe, D5):** auth routes (`/auth/*`), the billing/renew + subscription-read routes, and SuperAdmin (`/developer/*`) are **never** blocked, so a `LOCKED` school's Admin can always reach billing. Implement the allow-list as a route `config.subscription = { bypass: true }` flag checked in the guard (mirrors PRP-01's per-route `config.rateLimit`), defaulting school write routes to enforced.

> **Decision — write detection:** writes are gated **explicitly** by adding `onRequest: [fastify.requireWritableSchool]` to mutating routes (the school feature modules in P2+ opt in), not by sniffing the HTTP method. This is unambiguous and lets read-only-safe POSTs (e.g. search) opt out. P1 ships the guard + the `request.subscriptionState` decoration; P2+ routes consume it.

### 3.4 Lazy + scheduled transitions
- **Lazy:** when the hook computes a `transitionTo` that differs from the persisted `status`, it persists the new status (e.g. `TRIALING → GRACE → READ_ONLY`) in a guarded `updateMany` and writes an audit entry (PRP-18). This keeps state correct even with no cron.
- **Scheduled:** a daily `src/jobs/subscription-transition.job.ts` (`transitionLapsedSubscriptions(prisma)`) sweeps subscriptions whose `trialEndsAt`/`currentPeriodEnd`/`graceUntil` crossed, applying the same transitions in bulk — so banners/locks fire even for schools nobody is hitting. **Reuse PRP-05's job+script pattern:** add `src/scripts/runSubscriptionTransitions.ts` and a `"subscriptions:transition"` package.json script, schedulable by external cron or the same `node-cron`/`ENABLE_INPROCESS_*` flag PRP-05 introduces. When PRP-05's enum-mirror to `School.status` (READ_ONLY/LOCKED) is in play, keep both in sync via PRP-16's `transitionSchoolStatus` helper.

### 3.5 Services & config
`src/modules/subscription/subscription.service.ts` exports (controllers thin, `fastify` first arg):
- `createSubscriptionForSchool(fastify, schoolId, { planId?, cadence?, trialDays = 60 })` — **called by PRP-16 `activate`**; sets `trialEndsAt = now + trialDays`, status `TRIALING` (or `ACTIVE`/lapsed if `trialDays === 0`).
- `extendTrial(fastify, schoolId, extraDays)` — **called by PRP-16 `extendTrial`** and PRP-20.
- `recomputeSeatCount`, `getSubscriptionState`, plan CRUD helpers (surfaced via PRP-20), `generateInvoiceForPeriod`, `markInvoicePaid`.
Config keys in `src/config/shared-env.ts`: `TRIAL_DEFAULT_DAYS` (default 60), `SUBSCRIPTION_GRACE_DAYS` (default 7). Add matching fields to `AppConfig` + `readSharedEnv()`.

## 4. Implementation steps
1. **Schema:** add the enums + three models + `School.subscription` back-relation to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name subscription_and_trial` then `pnpm prisma:generate`. Seed one default `SubscriptionPlan` (mirror `src/scripts/createDeveloper.ts` for a seed script if needed).
2. **Module:** add `src/modules/subscription/{routes,controller,service,schema,types}.ts`. Implement `computeEffectiveAccess` (pure, unit-testable) in the service or a `subscription.access.ts` helper. Import enums from `src/generated/prisma/enums.js`.
3. **Enforcement plugin:** add `src/plugins/subscription.plugin.ts` (the hook + `requireWritableSchool`); register it in `src/plugins/index.ts` **after** the auth/school-context wiring so `request.schoolContext` (PRP-12) exists. Decorate `request.subscriptionState` + extend `src/@types/fastify.d.ts` (add `subscriptionState` to `FastifyRequest` and `requireWritableSchool` to `FastifyInstance`).
4. **Lazy transition:** in the hook, persist `transitionTo` via a guarded `updateMany` + `writeAudit()` (PRP-18).
5. **Daily job:** add `src/jobs/subscription-transition.job.ts` + `src/scripts/runSubscriptionTransitions.ts` + package.json script, following PRP-05.
6. **Config:** add `TRIAL_DEFAULT_DAYS` + `SUBSCRIPTION_GRACE_DAYS` to `shared-env.ts` (`sharedEnvProperties`, `AppConfig`, `readSharedEnv`).
7. **PRP-16 hook-up:** export `createSubscriptionForSchool`/`extendTrial` for PRP-16's `activate`/`extendTrial`.

## 5. Files added / changed
- **Add:** `src/modules/subscription/{routes,controller,service,schema,types}.ts`, `src/plugins/subscription.plugin.ts`, `src/jobs/subscription-transition.job.ts`, `src/scripts/runSubscriptionTransitions.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/index.ts`, `src/@types/fastify.d.ts`, `src/config/shared-env.ts`, `package.json`

## 6. Acceptance criteria
- [ ] A school activated with `trialDays: 60` has a `TRIALING` subscription with `trialEndsAt = now + 60d`; `request.subscriptionState.writable` is `true`.
- [ ] After `trialEndsAt`, effective status becomes `GRACE` (writable + `banner: true`), then `READ_ONLY` after `graceUntil`, then `LOCKED` per rules.
- [ ] `requireWritableSchool` blocks a write on a `READ_ONLY` school with a clear error, and **passes** auth/billing/`/developer/*` routes regardless of status.
- [ ] Lazy transition persists a stale status on the next request; the daily job transitions schools with no traffic.
- [ ] `computeEffectiveAccess` has unit tests covering each ladder rung and the `trialDays: 0` (no-trial) case.
- [ ] Subscription/status changes are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name subscription_and_trial` applies; default plan seeds.
- Manual: activate a school (PRP-16) → inspect `request.subscriptionState`; backdate `trialEndsAt`, hit a guarded route → expect `GRACE` banner then a `403/402` on a write past grace; confirm billing route still reachable when `LOCKED`.

## 8. Risks & rollback
- **Fail-safe is paramount (D5):** a bug that locks the Admin out of billing is the worst outcome — the allow-list must be verified by test; default school-write routes to enforced but never include `/auth/*` or billing.
- **Ordering with PRP-16:** mutually dependent (PRP-16 `activate` calls this; this enforcement reads PRP-16's status). Land together; until then stub `createSubscriptionForSchool` so `activate` degrades gracefully.
- **Clock/timezone:** all math in UTC; `trialEndsAt` is a timestamp, not a date, to avoid off-by-one at TZ boundaries.
- **Decimal handling:** use Prisma `Decimal` for money; never float.
- Rollback: the hook is inert until routes opt in via `requireWritableSchool`; revert the plugin + drop the tables (additive migration).
