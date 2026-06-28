# PRP-16 — School lifecycle & self-serve onboarding

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🔴 High · **Size:** L
> **Addresses:** P1-BE-1 (master-prp §7.1.1, decisions D6/D12/D16) · **Depends on:** PRP-12 (school authorization/tenant scoping) · **Feeds:** PRP-15 (subscription created at activation), PRP-20 (SuperAdmin console), PRP-21 (owner + admins)

## 1. Problem / current state
There is no self-serve onboarding and no lifecycle state machine. Schools are created **only** by a DEVELOPER via `POST /api/developer/schools` (`src/modules/developer/developer.routes.ts:19`), which immediately creates a `School` in status `INVITED`, the owner `User` (`INACTIVE`), a `UserSchool(ADMIN)`, an `AdminProfile`, and a PASSWORD_RESET invite (`DeveloperService.createSchoolWithAdmin`, `src/modules/developer/developer.service.ts:53-195`). The `INVITED → ACTIVE` flip is a side effect buried in `setPasswordFromInvite` (`src/modules/auth/auth.service.ts:305-318`) — it activates the school the moment the admin sets a password, with no SuperAdmin gate and no trial.

`School` (`prisma/schema.prisma:70-89`) has **no `ownerUserId`, no `groupId`**, and `SchoolStatus` (`prisma/schema.prisma:21-26`) is `INVITED | ACTIVE | INACTIVE | SUSPENDED` — missing the `PENDING / READ_ONLY / LOCKED` states the subscription ladder (D5) needs. This contradicts the agreed flow (D6): a **public request** creates a `PENDING` school + pending admin (no usable session), and **only SuperAdmin activation** (which sets the trial length, default 60 days — D4) starts the trial and triggers the setup-password invite.

## 2. Goal & non-goals
- **Goal:** a `School` lifecycle state machine + an `ownerUserId`/`groupId` schema, a public `POST /api/schools/request` that parks a school in `PENDING` with no login, and SuperAdmin lifecycle actions (`activate` / `suspend` / `lock` / `extendTrial`) where `activate` sets the trial and fires the invite.
- **Non-goals:** the subscription tables + enforcement (PRP-15 — `activate` only **calls into** it), the SuperAdmin console wiring/auth (PRP-20), additional-admin invites + ownership transfer (PRP-21), the School-Group/Trust feature (D12 — `groupId` is reserved nullable only).

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
Reconcile `SchoolStatus` to the lifecycle in master-prp §5.2 while preserving the legacy values so existing rows migrate cleanly:

```
enum SchoolStatus {
  PENDING       // public request, awaiting SuperAdmin activation — no usable session
  INVITED       // legacy: created by developer, invite sent (kept; treated like PENDING-with-invite)
  ACTIVE        // activated; trial/subscription governs writability (PRP-15)
  READ_ONLY     // subscription lapsed past grace — reads only (PRP-15)
  LOCKED        // subscription locked — only auth + billing reachable (PRP-15)
  SUSPENDED     // SuperAdmin-suspended (manual)
  INACTIVE      // legacy/soft-off (kept)
}
```
Add to `School`: `ownerUserId String?` (FK → `User.userId`, the founding/billing-contact admin, transferable in PRP-21) and `groupId String?` (nullable, **no relation yet** — reserved for the future Trust layer, D12). Index `ownerUserId` and `status`.

> **Decision — status vs. subscription:** `School.status` is the *administrative/lifecycle* state (who turned it on/off). The *billing* state lives on `SchoolSubscription.status` (PRP-15). PRP-15's enforcement hook derives effective write access from **both**; `READ_ONLY`/`LOCKED` on `School.status` are SuperAdmin-driven mirrors that PRP-15 may also set on transition. This PRP owns the enum + the manual transitions; PRP-15 owns the automatic (trial/grace) transitions. Keep the two in sync via the shared transition helper (§3.3).
>
> **Precedence — both gates must allow (AND, not OR):** a school is **writable only if `School.status` permits writes (admin override) AND the subscription gate (billing, PRP-15) permits writes**. Either gate alone can downgrade to read-only/locked; neither alone can grant write access. So a `SUSPENDED`/`READ_ONLY`/`LOCKED` `School.status` blocks writes regardless of a healthy subscription, and a lapsed/locked subscription blocks writes even on an `ACTIVE` `School.status`. PRP-15's enforcement hook computes the conjunction.
>
> **FE coordination:** the new `PENDING`/`READ_ONLY`/`LOCKED` enum values must be handled by the frontend (PRP-23/24) — status badges, banners, and the read-only/locked UI states — not just the existing `INVITED`/`ACTIVE`/`SUSPENDED`/`INACTIVE` set.

### 3.2 Public onboarding — `POST /api/schools/request` (unauthenticated)
A new `src/modules/school/` module. The endpoint accepts the school + prospective-owner-admin details (reuse the `createSchoolWithAdmin` field set), and in one transaction creates:
- `School` in `PENDING` (no subscription yet, `ownerUserId` set to the pending admin);
- the owner `User` in `UserStatus.INACTIVE` with a placeholder scrypt hash (mirror `developer.service.ts:86-113`);
- a `UserSchool(primaryRole: ADMIN)` with **`isActive: false`** (so even if a token were minted, PRP-12's `requireSchoolContext` rejects it) + its `AdminProfile`;
- **no `Verification` invite and no tokens** — there is no usable session pre-activation (D6).

It returns a neutral acknowledgement only (no userId/schoolId leakage beyond a request reference) and is rate-limited (reuse PRP-01's limiter; key by IP). Duplicate subdomain/email behaves like the developer path's `P2002` mapping (`developer.service.ts:174-193`).

### 3.3 Lifecycle state machine + SuperAdmin actions
A single `transitionSchoolStatus(fastify, schoolId, action, actor)` service enforces legal transitions and is the only writer of `School.status`:

| Action | From → To | Side effects |
|--------|-----------|--------------|
| `activate` | `PENDING`/`INVITED` → `ACTIVE` | create `SchoolSubscription` via **PRP-15** with `trialDays` (body, **default 60**, may be `0`); set `UserSchool(ADMIN).isActive = true`; activate the owner via the existing PASSWORD_RESET invite (`createPasswordSetupInvite`, `src/modules/auth/token.service.ts:11`) + `schoolAdminInvite` email (`emailTemplateService.sendTemplate`, `src/modules/email/email-template.service.ts:20`) |
| `suspend` | `ACTIVE`/`READ_ONLY`/`LOCKED` → `SUSPENDED` | block all school access except auth/billing (PRP-15 honours it) |
| `lock` | any active state → `LOCKED` | same gating as a subscription lock |
| `extendTrial` | `ACTIVE` (trialing) | delegate to PRP-15 to push `trialEndsAt`; no `School.status` change |
| `reactivate` | `SUSPENDED` → `ACTIVE` | restore writability subject to subscription state |

Illegal transitions throw `fastify.httpErrors.conflict(...)`. Every transition calls `writeAudit()` (PRP-18) with `entityType: 'School'`, the action, and before/after status. `activate` is the **only** place the trial length is chosen (D4); the value is passed straight to PRP-15.

> **Note on the legacy `setPasswordFromInvite` flip:** the `school.updateMany({ status: INVITED → ACTIVE })` block (`auth.service.ts:305-318`) must be **removed** in the same PR — activation is now SuperAdmin-driven, not a side effect of the admin setting a password. Setting a password on a `PENDING`/`INVITED` school must not change its status.

> **Decision — don't strand the developer-created-school path:** today `DeveloperService.createSchoolWithAdmin` (`developer.service.ts:53-195`) creates the school in `INVITED` and relies on the `setPasswordFromInvite` flip to reach `ACTIVE`. Removing that flip (above) would leave developer-created schools stuck in `INVITED` forever. **We adopt option (a):** migrate `createSchoolWithAdmin` to create the school in **`PENDING`** (with `UserSchool(ADMIN).isActive = false` and **no** invite minted at creation) and route it through the same SuperAdmin **`activate`** transition as the public `/schools/request` path — a single activation gate for both flows. (The rejected option (b) — keep `INVITED` auto-activation for the developer path and gate only the new public request — leaves two divergent activation paths and re-introduces the buried side effect.) Concretely: `createSchoolWithAdmin` no longer sends the invite or sets status `ACTIVE`; the invite + trial now fire from `activateSchool` exactly as for the public path.

### 3.4 Routing
- Public: `src/modules/school/school.routes.ts` registers `POST /schools/request` **outside** any auth scope (top-level `/api`, alongside auth routes in `registerPlugins`, `src/plugins/index.ts:12-21`).
- SuperAdmin lifecycle actions are exposed through the **developer** module/plugin (already guarded by `authenticate` + `authorizeDeveloper`, `src/plugins/developer.plugin.ts:9-19`); the thin controllers there delegate to `transitionSchoolStatus` (full surface specified in PRP-20).

## 4. Implementation steps
1. **Schema:** edit `prisma/schema.prisma` — extend `SchoolStatus` (add `PENDING`/`READ_ONLY`/`LOCKED`, keep existing), add `School.ownerUserId` (+`@@index`) and `School.groupId`, add the `User`↔`School` owner relation. Run `pnpm exec prisma migrate dev --name school_lifecycle` then `pnpm prisma:generate`. In the migration, backfill `ownerUserId` from each school's existing `UserSchool(primaryRole: ADMIN)` row.
2. **Module scaffold:** add `src/modules/school/{routes,controller,service,schema,types}.ts` following the module split (controllers thin; service takes `fastify` first arg). Implement the public request flow (§3.2) in `school.service.ts`, reusing helpers from `src/modules/auth/auth.utils.js` (`normalizeEmail`, `isEmail`, `buildUsernameFromEmail`, `hashPassword`) and the `generateUniqueUsername`/`normalizeSubdomain` patterns from `developer.service.ts`.
3. **State machine:** implement `transitionSchoolStatus` + a `SCHOOL_TRANSITIONS` map in `school.service.ts`; export `activateSchool`, `suspendSchool`, `lockSchool`, `extendTrial`, `reactivateSchool` wrappers. `activateSchool` calls the PRP-15 `createSubscriptionForSchool(fastify, schoolId, { trialDays })` service and then the invite/email.
4. **Public route registration:** register `school.routes.ts` in `src/plugins/index.ts` inside the `/api` scope but **before/around** the auth-guarded subtrees (no `onRequest` guard on `/schools/request`); add the rate-limit `config` per PRP-01.
5. **Remove the legacy auto-activation:** delete the `prisma.school.updateMany(... INVITED → ACTIVE ...)` block from `setPasswordFromInvite` (`auth.service.ts:305-318`).
5a. **Re-route the developer path:** change `DeveloperService.createSchoolWithAdmin` (`developer.service.ts:53-195`) to create the school in `PENDING` with `UserSchool(ADMIN).isActive = false` and **without** minting the PASSWORD_RESET invite, so it flows through the same SuperAdmin `activate` as the public request (option (a) above). The invite + trial fire from `activateSchool`, not at creation.
6. **Schemas:** add Fastify JSON schemas in `school.schema.ts` mirroring the `successEnvelope` helper style in `src/modules/developer/developer.schema.ts`; tag `['School']` (public) — developer-side action schemas live with PRP-20.
7. **Types:** add `SchoolRequestBody`, `ActivateSchoolBody { trialDays?: number }`, `SchoolLifecycleAction` to `school.types.ts`; import enums from `src/generated/prisma/enums.js`.

## 5. Files added / changed
- **Add:** `src/modules/school/school.routes.ts`, `school.controller.ts`, `school.service.ts`, `school.schema.ts`, `school.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/index.ts`, `src/modules/auth/auth.service.ts` (remove auto-activation), `src/modules/developer/developer.service.ts` (`createSchoolWithAdmin` → create `PENDING` + inactive `UserSchool(ADMIN)`, no invite; route through `activate`), `src/@types/fastify.d.ts` (only if a decorator is added)

## 6. Acceptance criteria
- [ ] `POST /api/schools/request` creates a `PENDING` school + `INACTIVE` owner + **inactive** `UserSchool(ADMIN)`, sends **no** invite, mints **no** tokens, and returns a neutral acknowledgement.
- [ ] A `PENDING` school is unusable: there is no path to a session until activation, and setting a password does not change school status.
- [ ] SuperAdmin `activate` moves `PENDING → ACTIVE`, creates a `SchoolSubscription` (PRP-15) with the supplied `trialDays` (default 60, may be 0), activates the `UserSchool(ADMIN)`, and sends the setup-password invite.
- [ ] `suspend` / `lock` / `reactivate` enforce legal transitions and reject illegal ones with `409`.
- [ ] `ownerUserId` is populated for every school (new + backfilled); `groupId` exists and is nullable with no FK constraint failures.
- [ ] Every transition writes an audit entry (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name school_lifecycle` applies cleanly; existing rows gain `ownerUserId`.
- Manual: `POST /api/schools/request` → confirm PENDING + no login possible; SuperAdmin `activate` with `trialDays: 60` → owner receives invite, school ACTIVE, subscription TRIALING (PRP-15).

## 8. Risks & rollback
- **Enum migration:** Postgres enum additions are safe; ensure no code still branches on the removed semantics of `INVITED`. The legacy auto-activation removal (step 5) is the behavioural change to call out in review.
- **Ordering vs. PRP-15:** `activate` depends on PRP-15's `createSubscriptionForSchool`. Land PRP-15 and PRP-16 together (they are a mutually-recursive pair: PRP-15 §1 depends on this enum, this PRP's `activate` depends on PRP-15's service). Until PRP-15 lands, gate `activate` behind a feature check or stub the subscription call.
- **Fail-safe:** never let `lock`/`suspend` block the auth or billing routes (PRP-15 enforcement guarantees this; verify the public `/schools/request` and `/auth/*` stay reachable in every status).
- Rollback: the public route is additive; revert the module + restore the `setPasswordFromInvite` flip. The nullable columns are harmless if unused.
