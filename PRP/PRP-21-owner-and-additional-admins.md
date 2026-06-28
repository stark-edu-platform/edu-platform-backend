# PRP-21 — Owner + additional admins / ownership transfer

> **Status:** Proposed · **Phase:** 1 · **Severity:** 🟠 Med · **Size:** M
> **Addresses:** P1-BE-7 (master-prp §5.2/§7.1.7, decision D16) · **Depends on:** PRP-16 (`School.ownerUserId` + lifecycle) · **Builds on:** PRP-17 (`admin.invite` / `admin.transfer_ownership` permission strings, owner-only gate), PRP-18 (audit), the existing invite/email flow · **Consumed by:** FE PRP-26 (additional-admin invite + transfer UI)

## 1. Problem / current state
A school has exactly one admin and no concept of an **owner** vs. additional admins. The founding admin is created by the developer flow (`DeveloperService.createSchoolWithAdmin`, `src/modules/developer/developer.service.ts:102-130`: one `User` + one `UserSchool(ADMIN)` + `AdminProfile`); PRP-16 adds `School.ownerUserId` pointing at that admin. There is **no way to invite a second ADMIN** to an existing school, and **no ownership-transfer** action. Decision D16 requires: one founding **owner** admin (the billing/legal contact, **ownership transferable**) **plus** additional full-access Admins.

The reusable building block already exists: invite-based onboarding via `createPasswordSetupInvite` (`src/modules/auth/token.service.ts:11-46`) + the `schoolAdminInvite` email template (`src/modules/email/email-template.registry.ts:23`, `email-template.service.ts:20`). PRP-17 reserves the `admin.invite` and `admin.transfer_ownership` permission strings and notes that `school.manage_billing` + `admin.transfer_ownership` are **owner-only** (a runtime check, not a role row).

## 2. Goal & non-goals
- **Goal:** an authenticated school-admin endpoint to **invite additional `ADMIN` users** (reusing the Verification/email invite flow), an **ownership-transfer** endpoint that reassigns `School.ownerUserId` between existing admins, and a guard so that **only the owner** can transfer ownership / manage billing.
- **Non-goals:** non-admin role invites (staff/teacher onboarding is P2, PRP-30), removing/deactivating admins beyond what's needed for transfer (basic deactivate may be included), the FE screens (PRP-26), multi-owner/co-owner models.

## 3. Target design
Lives in the school module (PRP-16's `src/modules/school/`) under PRP-12's school-scoped, permission-guarded subtree (`requireSchoolContext` resolves the active school; `requirePermission` checks the ability).

### 3.1 Invite an additional admin — `POST /api/school/admins/invite`
Guarded by `requirePermission('admin.invite')` (ADMIN role per PRP-17). Body: `{ name, email, phone?, designation? }`. In one transaction (mirroring `createSchoolWithAdmin` but for an **existing** school):
- find-or-reject if a `User` with that email already has a `UserSchool` for this school (`409`); otherwise create the `User` (`UserStatus.INACTIVE`, placeholder hash) **or** reuse an existing global `User` (cross-school users are allowed — D17 notes parents span branches; an admin could too);
- create `UserSchool(primaryRole: ADMIN, isActive: true)` for `request.schoolContext.schoolId` + its `AdminProfile`;
- issue a PASSWORD_RESET invite via `createPasswordSetupInvite` + send the `schoolAdminInvite` email.
The new admin is a **full-access** ADMIN but **not** the owner (no `ownerUserId` change). `writeAudit('admin.invite', ...)` (PRP-18).

> **Decision — scope the invite to the active school only:** the endpoint never accepts a client-supplied `schoolId`; it always uses `request.schoolContext.schoolId` (PRP-12 tenant rule). This prevents an admin of school A from minting an admin in school B.

### 3.2 Ownership transfer — `POST /api/school/ownership/transfer`
Guarded by the **owner-only** check (§3.3) — `requirePermission('admin.transfer_ownership')` is necessary but **not sufficient**; the actor must also be the current `ownerUserId`. Body: `{ toUserId }`. Validates that `toUserId` is an **active ADMIN** `UserSchool` of this school, then sets `School.ownerUserId = toUserId` in a transaction. The previous owner remains a full ADMIN (just no longer the billing/legal contact). `writeAudit('ownership.transfer', { fromUserId, toUserId })` (PRP-18, awaited).

### 3.3 Owner-only guard
A `requireSchoolOwner` guard (decorated like PRP-12's guards, or a small `preHandler` in the school module): after `requireSchoolContext`, assert `request.schoolContext.userId === school.ownerUserId` (load `ownerUserId` once; it's on `School` from PRP-16). Applied to: ownership-transfer and **billing/subscription-management** routes for the school (the `school.manage_billing` surface — PRP-15's Admin-reachable billing endpoints should additionally require ownership, per D16: the **owner** is the billing/legal contact). Throws `fastify.httpErrors.forbidden('Only the school owner can perform this action')`.

> **Interaction with PRP-15 fail-safe:** the billing routes stay reachable even when the school is `LOCKED` (PRP-15 allow-list), but among admins only the **owner** may act on billing. Read-only billing/status may be visible to all admins; the *mutating* billing actions are owner-gated. Keep the allow-list (writable bypass) and the owner-gate as two independent checks.

### 3.4 Schemas/types
Add `InviteAdminBody`, `TransferOwnershipBody` to the school module's `types.ts`; Fastify schemas (`successEnvelope` style) in its `schema.ts`. Reuse the email-invite response shape from the developer create-school schema where convenient.

## 4. Implementation steps
1. **Routes:** add `POST /school/admins/invite` and `POST /school/ownership/transfer` to `src/modules/school/school.routes.ts` under the PRP-12 school-scoped plugin; attach `requirePermission('admin.invite')` and the owner-gate respectively.
2. **Service:** add `inviteAdditionalAdmin(fastify, schoolId, body)` and `transferOwnership(fastify, schoolId, actorUserId, toUserId)` to `school.service.ts`, reusing `createPasswordSetupInvite` (`src/modules/auth/token.service.ts`), `emailTemplateService.sendTemplate({ template: 'schoolAdminInvite' })`, and the `generateUniqueUsername`/`hashPassword`/`normalizeEmail` helpers (from `developer.service.ts` / `auth.utils.ts`). Both call `writeAudit` (PRP-18).
3. **Owner guard:** add `requireSchoolOwner` (in the school module or `src/middlewares/`); apply to transfer + the PRP-15 billing-mutation routes.
4. **Validation rules:** reject self-transfer to a non-admin, reject inviting an email already an admin of this school, reject transfer by a non-owner even if ADMIN.
5. **Schemas/types:** add the two bodies + response schemas.
6. **(If needed) deactivate-admin:** optionally add `POST /school/admins/:userSchoolId/deactivate` (`member.deactivate`) guarded so the **owner cannot be deactivated** while owning — out of scope unless trivially co-located.

## 5. Files added / changed
- **Edit:** `src/modules/school/school.routes.ts`, `school.controller.ts`, `school.service.ts`, `school.schema.ts`, `school.types.ts`
- **Add (optional):** `src/middlewares/owner.middleware.ts` (`requireSchoolOwner`) if not co-located in the school module
- No schema/migration change (uses `School.ownerUserId` from PRP-16)

## 6. Acceptance criteria
- [ ] An ADMIN with `admin.invite` can invite a second ADMIN to **their** school; the invitee gets a setup-password email and becomes a full ADMIN (not owner).
- [ ] The invite is scoped to the active school; a client-supplied `schoolId` cannot retarget it (PRP-12 rule).
- [ ] Inviting an email already an admin of the school returns `409`.
- [ ] Only the current owner can transfer ownership; a non-owner ADMIN (even with the permission) gets `403`.
- [ ] Transfer reassigns `School.ownerUserId` to an active ADMIN of the school; the old owner stays a full ADMIN.
- [ ] Mutating billing actions are owner-gated; billing remains reachable (read) for admins even when the school is LOCKED (PRP-15 allow-list).
- [ ] `admin.invite` and `ownership.transfer` are audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- No migration (relies on PRP-16). Manual: as the owner admin, invite a second admin → invitee sets password and logs in as ADMIN; transfer ownership to them → `ownerUserId` updates; confirm the former owner can no longer mutate billing/transfer, and a non-owner ADMIN gets 403 on transfer.

## 8. Risks & rollback
- **Lock-out / orphaned ownership:** never allow transfer to a non-admin or to a deactivated user, and never deactivate the current owner — otherwise a school could be left with no owner (billing contact). Validate the target is an active ADMIN before reassigning.
- **Owner-gate vs. permission:** keep the two checks distinct — `admin.transfer_ownership`/`school.manage_billing` (PRP-17 ability) *and* `ownerUserId` match. An ADMIN matrix row alone must not grant owner powers.
- **Cross-school user reuse:** reusing an existing global `User` for an invite is allowed (D17), but the per-school `UserSchool` uniqueness (`@@unique([userId, schoolId])`, `prisma/schema.prisma:109`) must be respected — handle the conflict cleanly.
- Rollback: routes are additive under existing guards; revert the school-module additions. The owner-gate is inert until applied to billing routes.
