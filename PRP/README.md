# PRP — Backend change plans

This folder holds **Product Requirement Prompts (PRPs)**: one self-contained, implementable plan per PR-sized work-item. The cross-repo master plan (all phases, dependencies, scope) is [`/PRD/implementation-plan.md`](../../PRD/implementation-plan.md); the product vision + decision log is [`/PRD/master-prp.md`](../../PRD/master-prp.md).

Each PRP follows: **Problem → Goal/Non-goals → Target design → Implementation steps → Files changed → Acceptance criteria → Validation → Risks**. Numbering is **global across all three repos** (this repo + `edu-platform-frontend/PRP/` + `edu-platform-mobile/PRP/`); IDs are stable.

## How to use a PRP
1. Read it top to bottom; the "Implementation steps" are ordered and concrete.
2. Implement on a branch (do **not** commit without explicit approval — see `CLAUDE.md`).
3. Run the **Validation** block before opening a PR.
4. Flip the status below to `Done`.

## Conventions (house style — keep these)
- ESM imports use explicit `.js` extensions even for `.ts` sources.
- Prisma types import from `src/generated/prisma/…`; run `pnpm prisma:generate` after any schema edit.
- All responses use `successResponse` / `errorResponse` (`src/utils/api-response.ts`); throw `fastify.httpErrors.*`.
- New features follow the `src/modules/<name>/{routes,controller,service,schema,types}.ts` split; controllers stay thin.
- Validation per PRP: `pnpm typecheck` · `pnpm lint:check` · `pnpm build`. Migrations: `pnpm exec prisma migrate dev --name <change>`.
- **Permission strings** (`resource.action`) are owned by [`PRP-17`](./PRP-17-data-driven-rbac-permissions.md); never fork the vocabulary — it is shared with frontend `PRP-10/11` + mobile.

## Phase 0 — hardening (from the architecture review)

| PRP | Title | Addresses | Severity | Status |
|----|-------|-----------|----------|--------|
| [01](./PRP-01-auth-rate-limiting.md) | Auth rate limiting & abuse control | SB2 | 🔴 High | Proposed |
| [02](./PRP-02-cors-and-secret-hardening.md) | CORS allow-list + env/secret hardening | SB3, SB4 | 🔴 High | **Update** — allow-list parsing exists but defaults to `*`; `JWT_SECRET` no min-length |
| [03](./PRP-03-refresh-token-reuse-detection.md) | Refresh-token reuse detection (token family) | SB1 | 🔴 High | Proposed |
| [04](./PRP-04-cookies-and-samesite.md) | @fastify/cookie + SameSite=Lax | SB5, SB6 | 🟠 Med | **Update** — cookies work but hand-rolled + `SameSite=None` in prod |
| [05](./PRP-05-token-cleanup-job.md) | Expired/revoked token cleanup job | SB7 | 🟠 Med | Proposed |

## Tooling

| PRP | Title | Severity | Status |
|----|-------|----------|--------|
| [73](./Tests/PRP-73-backend-test-harness.md) | Unit-test harness (Vitest) — in `PRP/Tests/` | 🟠 Med | Proposed |

## Product phases (P1–P8)

| PRP | Title | Phase | Status |
|----|-------|-------|--------|
| [12](./PRP-12-backend-school-authorization.md) | School-scoped authorization & tenant scoping | 1 | Proposed |
| [15](./PRP-15-subscription-and-trial-enforcement.md) | Subscription, trial model & write-enforcement | 1 | Proposed |
| [16](./PRP-16-school-lifecycle-and-onboarding.md) | School lifecycle & self-serve onboarding | 1 | Proposed |
| [17](./PRP-17-data-driven-rbac-permissions.md) | Data-driven RBAC (Permission/RolePermission) | 1 | Proposed |
| [18](./PRP-18-audit-log.md) | Audit log | 1 | Proposed |
| [19](./PRP-19-mobile-token-auth.md) | Mobile token-auth variant | 1 | Proposed |
| [20](./PRP-20-superadmin-console-apis.md) | SuperAdmin console APIs (+ impersonation) | 1 | Proposed |
| [21](./PRP-21-owner-and-additional-admins.md) | Owner & additional admins / ownership transfer | 1 | Proposed |
| [28](./PRP-28-academic-year-and-terms.md) | Academic year & terms | 2 | Proposed |
| [29](./PRP-29-classes-sections-subjects-streams.md) | Classes, sections, subjects & streams | 2 | Proposed |
| [30](./PRP-30-staff-teacher-management.md) | Staff/teacher management | 2 | Proposed |
| [31](./PRP-31-student-sis-and-guardians.md) | Student SIS & guardians | 2 | Proposed |
| [32](./PRP-32-enrollment-and-promotion.md) | Enrollment & promotion | 2 | Proposed |
| [33](./PRP-33-admissions.md) | Admissions | 2 | Proposed |
| [34](./PRP-34-bulk-import.md) | Bulk import (CSV/Excel) | 2 | Proposed |
| [38](./PRP-38-attendance-config-and-records.md) | Attendance config & records (daily/period + sync) | 3 | Proposed |
| [39](./PRP-39-staff-attendance.md) | Staff attendance | 3 | Proposed |
| [40](./PRP-40-absence-alerts-and-reports.md) | Absence alerts & reports | 3 | Proposed |
| [41](./PRP-41-parent-portal-apis.md) | Parent portal APIs (multi-child) | 3 | Proposed |
| [44](./PRP-44-fee-heads-and-plans.md) | Fee heads & year-versioned plans | 4 | Proposed |
| [45](./PRP-45-fee-adjustments-and-fines.md) | Fee adjustments & fines | 4 | Proposed |
| [46](./PRP-46-payments-receipts-defaulters.md) | Payments, receipts & defaulters | 4 | Proposed |
| [49](./PRP-49-exams-and-scheduling.md) | Exams & scheduling | 5 | Proposed |
| [50](./PRP-50-grading-and-marks.md) | Grading schemes & marks entry | 5 | Proposed |
| [51](./PRP-51-report-cards-and-results.md) | Report cards & results publishing | 5 | Proposed |
| [54](./PRP-54-notification-engine.md) | Notification engine (push/email/SMS/WhatsApp) | 6 | Proposed |
| [55](./PRP-55-notices-and-events.md) | Notices & events | 6 | Proposed |
| [56](./PRP-56-messaging-and-ptm.md) | Messaging & PTM | 6 | Proposed |
| [57](./PRP-57-homework-and-materials.md) | Homework & materials | 6 | Proposed |
| [61](./PRP-61-online-payment-gateway.md) | Online payment gateway (school's-own account) | 7 | Proposed |
| [63](./PRP-63-online-platform-billing.md) | Online platform billing (optional) | 7 | Proposed |
| [64](./PRP-64-transport.md) | Transport (BE+FE) | 8 | Proposed |
| [65](./PRP-65-library.md) | Library (BE+FE) | 8 | Proposed |
| [66](./PRP-66-certificates-and-id-cards.md) | Certificates & ID cards (BE+FE) | 8 | Proposed |
| [67](./PRP-67-payroll.md) | Payroll (BE+FE) | 8 | Proposed |
| [68](./PRP-68-hostel-and-mess.md) | Hostel & mess (BE+FE) | 8 | Proposed |
| [69](./PRP-69-health-infirmary.md) | Health / infirmary (BE+FE) | 8 | Proposed |
| [70](./PRP-70-inventory-assets.md) | Inventory / assets (BE+FE) | 8 | Proposed |
| [71](./PRP-71-school-branding.md) | School branding / white-label (BE+FE) | 8 | Proposed |
| [72](./PRP-72-analytics-and-reporting.md) | Analytics & reporting (BE+FE) | 8 | Proposed |

> P8 items are combined BE+FE docs (data-model-anchored) with Backend/Frontend subsections.

## Recommended order
- **Phase 0 (hardening):** `02 → 01 → 03 → 04 → 05` (+ SB8). Low blast-radius; do first.
- **P1 foundation:** `12` + `17` (tenant scope + permission contract) → `16` ↔ `15` (school lifecycle + subscription; land together) → `18` (audit) → `19` (mobile auth) → `20` (console) → `21` (admins). Pairs with frontend `PRP-10/11`.
- **P2 → P8:** follow the dependency order in [`/PRD/implementation-plan.md`](../../PRD/implementation-plan.md); each phase builds on the prior.

## Minor / opportunistic items (no standalone PRP)
- **SB8 — return `schools` on login.** `loginUser` (`src/modules/auth/auth.service.ts:85`) selects only base user fields, so the login response `user.schools` is `undefined` even though `authUserSchema` advertises it; the frontend then makes a second `/auth/me` call. Fix: add the `userSchools` select (same shape as `getCurrentUser`) and return the full user. Enables frontend `PRP-14`/`LG5` to drop the extra round-trip. ~10-line change; fold into `PRP-04` or do standalone.
- **SB9** access token not revocable on logout — acceptable at 15m TTL; only add a `jti` deny-list if instant kill is required.
- **SB10** `trustProxy: true` (`app.ts:43`) — fine behind a known LB; scope to trusted proxies otherwise.
- **SB11** password policy is length-only — owned by frontend `PRP-13` (shared policy); the backend counterpart updates `isValidPassword` (`src/modules/auth/auth.utils.ts:24`) + `setPasswordRouteSchema`.
