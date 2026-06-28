# PRP-41 — Parent portal APIs (multi-child aggregation)

> **Status:** Proposed · **Phase:** 3 · **Severity:** 🟠 Med · **Size:** M
> **Addresses:** P3-BE-4 (master-prp §5.7/§6, decisions D17/D20) · **Depends on:** PRP-31 (Student SIS + `ParentStudent` many-to-many guardian linkage + sibling grouping — the parent↔child graph), PRP-38 (`AttendanceRecord` — child attendance), PRP-12 (school context / tenant scoping), PRP-28 (year-scoped data) · **Pairs with:** PRP-40 (absence alerts — a parent may also pull recent alerts) · **Feeds:** PRP-42 (parent mobile views), PRP-43 (parent web multi-child dashboard) · **Forward-looking:** notices/fees/results aggregation slots are stubbed here and filled by P4/P5/P6 (PRP-46/51/55)

## 1. Problem / current state
A **parent is a first-class account linked many-to-many to students** (D17): siblings under one login, a student can have two guardians, and (per D17) a parent can have children **across branches/schools**. PRP-31 builds that graph (`ParentStudent`, sibling grouping, guardian linkage on top of the existing `ParentProfile`/`Student`/`ParentStudent` models, `prisma/schema.prisma:167-217`). But there is **no parent-facing aggregation API**: a parent has no way to list their children and pull each child's attendance (and later fees/results/notices) through one authenticated surface, correctly tenant-scoped.

The existing authz (PRP-12) is **single-school** — `request.schoolContext` resolves one active school. A parent with children in two schools needs either (a) a per-school parent surface (parent picks the active school/child like a school switcher) or (b) a cross-school "my children" read. This PRP defines that contract. The hard rule: a parent may read **only** data for students they're actually linked to via `ParentStudent` — never an arbitrary `studentId` (the PRP-12 tenant rule, applied at the parent↔child edge).

## 2. Goal & non-goals
- **Goal:** a `/school/parent/*` (and a thin cross-school `/me/children`) API that, for the authenticated PARENT, (a) lists their linked children with the school/class context (PRP-31/32), (b) returns a per-child **attendance** summary + history (PRP-38/40 data) and an aggregated **multi-child dashboard** payload, and (c) provides forward-looking, additively-extensible slots for notices/fees/results so P4–P6 fill them without reshaping the response. Every read is hard-scoped to the caller's `ParentStudent` links.
- **Non-goals:** the parent UI (web PRP-43, mobile PRP-42); attendance marking (PRP-38) or the alert trigger (PRP-40 — this surface may *re-expose* recent alerts read-only); fees/results/notices themselves (P4/P5/P6 — only the response slots are reserved); student self-login reads (a STUDENT reads their own data via PRP-38's `attendance.read_own` + PRP-43's student view, not this parent surface); messaging/PTM (P6/PRP-56).

## 3. Target design

### 3.1 The parent↔child access rule (the core guard)
A reusable resolver `resolveParentChildren(fastify, parentUserId, { schoolId? }) → LinkedChild[]` is the **single authorization gate** for everything here. It:
1. resolves the caller's `ParentProfile`(s) (a parent has one `ParentProfile` per school they're a guardian in — `ParentProfile.userSchoolId`, `prisma/schema.prisma:167`),
2. joins `ParentStudent` → `Student` to get the linked children (optionally filtered to one `schoolId`),
3. returns each child with `{ studentId, schoolId, name, admissionNo, sectionId?, className?, relation, isPrimary }` (section/class from PRP-32 enrollment for the active year, PRP-28).

**Every** child-scoped endpoint takes a `studentId` and verifies it is in `resolveParentChildren(...)` for the caller — a `studentId` the parent isn't linked to → `403/404` (don't leak existence). This is the tenant rule (PRP-12) applied at the guardian edge; the parent never supplies a `schoolId` that widens access.

### 3.2 Permission strings (extend PRP-17 contract)
New `resource.action` keys for the PARENT role — defined here, mirrored verbatim by FE PRP-43 + mobile PRP-42:
- `parent.read_children` — list own linked children + aggregate dashboard.
- `parent.read_child_attendance` — read a linked child's attendance (re-uses PRP-38 data but a distinct parent-scoped key so the matrix can grant parents attendance-read without granting staff `attendance.read`).
Seed into PRP-17's default role→permission map (PARENT gets both). Later phases add `parent.read_child_fees` / `parent.read_child_results` / `parent.read_notices` (reserve the names; P4–P6 seed them).

### 3.3 Module (`src/modules/parent-portal/`)
Standard split; controllers thin; services take `fastify` first; reads only (no `requireWritableSchool` — parents don't write here in P3). Two registration surfaces:

**(a) School-scoped (`/school/parent/*`, under PRP-12's plugin — parent has picked an active school):**

| Method & path | Guard | Returns |
|---|---|---|
| `GET /school/parent/children` | `parent.read_children` | linked children in the active school (`LinkedChild[]`) |
| `GET /school/parent/dashboard` | `parent.read_children` | aggregated multi-child payload for the active school (§3.4) |
| `GET /school/parent/children/:studentId/attendance?from=&to=` | `parent.read_child_attendance` (+ link check) | the child's attendance history + tallies (delegates to PRP-40's report service, scoped to the verified child) |
| `GET /school/parent/children/:studentId/attendance/summary` | `parent.read_child_attendance` (+ link check) | a compact recent summary (last N days + % present) for cards |

**(b) Cross-school (`/me/children`, authenticated-only — for the parent-with-children-across-branches case, D17):**

| Method & path | Guard | Returns |
|---|---|---|
| `GET /me/children` | `requireAuth` + PARENT membership | every linked child across **all** schools the caller is a guardian in, each with its `schoolId`/school name + class — lets the client render a school/child switcher |

`/me/children` is the only cross-school read; it lists children + their school context but **does not** return per-school detail (the client then enters that school's scope via `/school/parent/*`). It iterates the caller's `ParentProfile`s across schools and unions the linked children. This keeps the heavy per-domain reads inside the normal single-school `request.schoolContext` (PRP-12), with only the lightweight roster being cross-school.

### 3.4 Aggregated dashboard payload (`GET /school/parent/dashboard`)
A single response composing each linked child's headline data for the active school, shaped for extension:
```
{
  children: Array<{
    student: { studentId, name, admissionNo, sectionId?, className? },
    attendance: { last7: { present, absent, late, leave, halfDay }, percentPresent, recentAbsences: Array<{ date, status }> },
    // P4–P6 fill these; present as null/empty in P3 so the FE can render placeholders:
    fees:    null,   // → PRP-46 (dues summary)
    results: null,   // → PRP-51 (latest result/report-card link)
    notices: []      // → PRP-55 (recent notices for the child's class)
  }>
}
```
Attendance fields delegate to PRP-40's report/summary service per verified child (reuse, don't re-aggregate). The `fees`/`results`/`notices` slots are reserved now (typed nullable/empty) so P4–P6 populate them **without** changing the response shape — the FE/mobile clients code against the stable contract today.

### 3.5 Reuse, not re-implementation
- Attendance reads call **PRP-40's** `summarize`/report services (passing a `studentId` already verified by `resolveParentChildren`) — this module does **not** re-query `AttendanceRecord` directly, so the `%-present` math + half-day weighting stay in one place (PRP-40 §3.3).
- Recent absence-alerts (optional) read PRP-40's `AttendanceAlert` ledger for the verified child (read-only) — gives the parent a "recent alerts" view without re-deriving.
- Child roster/class context comes from PRP-31 (`ParentStudent`/`Student`) + PRP-32 (`Enrollment`) — joined in `resolveParentChildren`.

## 4. Implementation steps
1. **Resolver:** add `resolveParentChildren(fastify, parentUserId, { schoolId? })` (in `parent-portal.service.ts`) — the single link-verification + roster join (PRP-31/32). No schema change (reads existing/PRP-31 models).
2. **Permissions:** add `parent.read_children` / `parent.read_child_attendance` to PRP-17's default role→permission seed + the shared permission module (FE PRP-43 / mobile PRP-42 mirror verbatim); reserve the P4–P6 key names in a comment.
3. **Module:** add `src/modules/parent-portal/{routes,controller,service,schema,types}.ts`; types include `LinkedChild` + the dashboard payload shape (with the reserved nullable slots). Enums from `src/generated/prisma/enums.js` where needed.
4. **School-scoped routes** under PRP-12's plugin (`/school/parent/*`), each child-scoped one calling the link check; **cross-school** `/me/children` registered as an authenticated (non-school-scoped) route resolving PARENT memberships.
5. **Delegate attendance** to PRP-40's report/summary services (verified `studentId`); optionally expose recent `AttendanceAlert`s.
6. **Schemas/Swagger:** Fastify JSON schemas (`successResponse` envelope) documenting `LinkedChild` + the dashboard payload (so PRP-42/43 code against it); mark the `fees`/`results`/`notices` slots as forward-looking/nullable.

## 5. Files added / changed
- **Add:** `src/modules/parent-portal/{routes,controller,service,schema,types}.ts`
- **Edit:** PRP-17's permission seed/module, the school-scoped plugin registration, and the authenticated route table for `/me/children` (likely `src/plugins/index.ts` or a small `me` route group). No schema migration (reads PRP-31/32/38/40 models).

## 6. Acceptance criteria
- [ ] An authenticated PARENT can list their linked children for the active school (`/school/parent/children`) and across schools (`/me/children`), each with school/class context.
- [ ] A parent reading `/school/parent/children/:studentId/attendance` for a child they're linked to gets the child's attendance (delegated to PRP-40); a `studentId` they're **not** linked to returns `403/404` (no existence leak) — the link check is enforced server-side, not by client input.
- [ ] The dashboard payload returns per-child attendance summaries and includes the reserved `fees`/`results`/`notices` slots (null/empty in P3) so the shape is stable for P4–P6.
- [ ] Attendance numbers come from PRP-40's services (no duplicate aggregation in this module).
- [ ] Permission keys match the shared contract (PRP-17) and are mirrored by FE PRP-43 / mobile PRP-42.
- [ ] No write endpoints (parents don't mutate here in P3); all reads tenant- + link-scoped.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- (No migration — reads existing/PRP-31 models.)
- Manual (against PRP-31/38/40 seed: a parent linked to two students, one with absences): `/me/children` lists both; `/school/parent/dashboard` shows each child's last-7 summary + recent absences; request a non-linked `studentId` → `403/404`; confirm the `fees`/`results`/`notices` slots are present and empty.

## 8. Risks & rollback
- **Link-check is the security boundary:** every child-scoped read must pass through `resolveParentChildren` — a missed check leaks another family's child. Centralize it (one resolver), never trust a client `studentId`/`schoolId`, and return `403/404` uniformly (don't disclose whether the student exists). This is the PRP-12 rule at the guardian edge — verify by test.
- **Cross-school scope (D17) vs single-school authz (PRP-12):** `/me/children` is the only cross-school read and is deliberately lightweight (roster only); all detail stays inside single-school `request.schoolContext`. Keep that split — don't let detail endpoints go cross-school, or tenant isolation blurs. ⚠︎ If O-P3/PRP-12 later formalizes a parent "active child/school" selector, align `/me/children` with it.
- **Forward-looking slots:** reserving `fees`/`results`/`notices` now avoids a response reshape in P4–P6, but keep them strictly typed (nullable/empty) and documented so clients don't assume data exists in P3. Don't over-design the slot shapes before those phases — minimal placeholders.
- **Aggregation cost:** the dashboard fans out per child to PRP-40's summaries — bound the child count sensibly and reuse PRP-38's indexes; avoid N+1 by batching the per-child summary queries where the report service allows.
- Rollback: additive, read-only, no migration — revert the module + permission seed; nothing else depends on it writing.
