# PRP-67 — Payroll (salary structures, payslips)

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟠 Med · **Size:** L
> **Depends on:** PRP-30 (`StaffProfile`/`TeacherProfile` + `EmploymentType` + `Department` — payroll attaches a salary structure to a **staff/teacher member**; PRP-30 explicitly listed **payroll as a deferred non-goal for P8/PRP-67**, so this PRP owns it), PRP-46 (reuses the cross-cutting **`src/modules/pdf/` renderer + `src/lib/storage/`** + the **Decimal money discipline** — a payslip is a PDF over the shared service; ₹ amounts are `Decimal`, never float), PRP-39 (`StaffAttendance` — optional LOP/loss-of-pay input to a payslip run; loose, optional), PRP-28 (academic-year scoping is incidental; payroll is **month-scoped** — see §3.1), PRP-17 (RBAC — new `payroll.*` strings), PRP-12 (school context / tenant scoping), PRP-15 (`requireWritableSchool` on payroll writes), PRP-18 (`writeAudit` on structure changes + payslip finalize — money actions, D22) · **Feeds:** the FE payroll screens (this combined PRP, §3-FE/§4-FE) · **Gated on O-P8 + O-P2** (HR/payroll depth — master §10)

## 1. Problem / current state
The platform onboards and manages staff/teachers (PRP-30) but has **no payroll**: no **salary structure** (the earnings/deductions that make up a member's pay), no **payslip** (a finalized monthly statement), and no PDF to hand the employee. PRP-30 was explicit — *"payroll (P8/PRP-67 — explicitly deferred)"* and its **minimal HR record** assumption left **payroll fields out** pending **O-P2**. So this PRP owns the entire payroll surface, building on PRP-30's staff records.

Two existing pieces make this tractable: PRP-46's **shared PDF service** (`src/modules/pdf/` + `src/lib/storage/`, designed for reuse — a payslip is just another template) and PRP-46's **`Decimal` money discipline** (all ₹ as `Decimal @db.Decimal`, accept/return as strings, never float). This PRP reuses both.

Payroll is one of the **most policy-sensitive** modules in the product (statutory PF/ESI/PT/TDS rules, attendance-linked LOP, arrears) and is **gated on two open questions** — so it is deliberately scoped to a **solid, configurable core** (structures of typed components + a month payslip run that computes net pay), with statutory specifics left as **configurable components**, not hard-coded.

> ⚠︎ **Open questions (master §10 O-P8 Extended-module priority **and** O-P2 "staff HR depth … payroll in/out of scope"):**
> - **Statutory depth (PF / ESI / Professional Tax / TDS) is unresolved.** **Assumption (inline):** v1 models pay as **typed, configurable components** — `EARNING` (Basic, HRA, allowances) and `DEDUCTION` (PF, ESI, PT, TDS, advances) — each a fixed amount **or** a percentage of a base (e.g. Basic), with no statutory slab engine baked in. PF/ESI/PT/TDS are **just deduction components a school configures**; an actual statutory-rule engine (slabs, ceilings, YTD TDS) is a **future PRP** gated on O-P2. Treat component math as the deliverable, statutory automation as the seam.
> - **Attendance-linked Loss-of-Pay (LOP) and arrears depth is open.** **Assumption:** a payslip run accepts an **optional `lopDays`** (manually entered, or read from PRP-39 `StaffAttendance` if present) that pro-rates pay; **arrears/bonus/reimbursements** are entered as ad-hoc components on a payslip, not a separate arrears engine. Bank-file/NEFT export and e-filing are **out**.

## 2. Goal & non-goals
- **Goal:** a `src/modules/payroll/` module (house split) with: a `SalaryComponent` catalog (per-school, `EARNING`/`DEDUCTION`, fixed or %-of-base), a `SalaryStructure` per member (effective-dated, a set of `SalaryStructureItem` component values), a `Payslip` per member per pay-month with computed `PayslipLine`s (gross/deductions/net) and a status (`DRAFT`→`FINALIZED`→`PAID`), a **payslip run** that generates a month's payslips for a set of members (pro-rating by `lopDays`), a **payslip PDF** (new template over PRP-46's shared renderer), and an employee read of their own payslips. Plus the matching **FE** screens (payroll admin: components/structures/runs + an employee payslip view). All money is **`Decimal`** (PRP-46 discipline).
- **Non-goals:** a **statutory rule engine** (PF/ESI/PT/TDS slabs/ceilings/YTD — ⚠︎ O-P2; components are configurable, automation is a future PRP), **bank-file / NEFT export** and **e-filing/Form-16**, leave-management/leave-encashment (PRP-39 is attendance only; leave types are O-P2), the **staff records themselves** (PRP-30 — this PRP attaches pay to them), the PDF **engine** (PRP-46 — reuse), reimbursement/expense-claim workflows, multi-currency (₹ only, D1). A payslip is a single-month statement; multi-month YTD summaries are out (note the seam).

## 3. Target design

### Backend

#### 3.1 Schema (`prisma/schema.prisma`)
**Money is `Decimal @db.Decimal(12,2)` everywhere (PRP-46/15 rule; never float).** Denormalize `schoolId`; enums from `src/generated/prisma/enums.js`. Payroll is **month-scoped** (`payMonth` as a `YYYY-MM` string or a first-of-month date), independent of academic year.

```prisma
enum ComponentType {
  EARNING         // Basic, HRA, conveyance, special allowance
  DEDUCTION       // PF, ESI, Professional Tax, TDS, advance recovery (⚠︎ O-P2 statutory)
}

enum ComponentCalc {
  FIXED           // a flat ₹ amount
  PERCENT_OF_BASE // a % of a base component (usually Basic) — resolved to Decimal at compute
}

enum PayslipStatus {
  DRAFT           // computed, editable, not released
  FINALIZED       // locked statement (immutable) — payslip PDF issuable
  PAID            // marked disbursed
  CANCELLED
}

model SalaryComponent {
  salaryComponentId String        @id @default(uuid())
  schoolId          String
  name              String                                    // "Basic", "HRA", "PF", "TDS"
  type              ComponentType
  calc              ComponentCalc @default(FIXED)
  isBase            Boolean       @default(false)             // marks the % base (typically Basic)
  isStatutory       Boolean       @default(false)             // PF/ESI/PT/TDS flag (⚠︎ O-P2; informational v1)
  isActive          Boolean       @default(true)
  structureItems    SalaryStructureItem[]
  payslipLines      PayslipLine[]
  school            School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
}

// A member's pay structure, effective-dated (a raise = a new structure with a later effectiveFrom).
model SalaryStructure {
  salaryStructureId String   @id @default(uuid())
  schoolId          String
  userSchoolId      String                                    // the staff/teacher member (PRP-30 → UserSchool)
  effectiveFrom     DateTime                                  // structure applies from this month onward
  effectiveTo       DateTime?                                 // null = current; set when superseded
  isActive          Boolean  @default(true)
  items             SalaryStructureItem[]
  school            School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([schoolId])
  @@index([userSchoolId, effectiveFrom])
}

model SalaryStructureItem {
  salaryStructureItemId String   @id @default(uuid())
  schoolId              String
  salaryStructureId     String
  salaryComponentId     String
  amount                Decimal  @db.Decimal(12, 2)           // ₹ for FIXED; the percentage for PERCENT_OF_BASE
  salaryStructure       SalaryStructure @relation(fields: [salaryStructureId], references: [salaryStructureId], onDelete: Cascade)
  salaryComponent       SalaryComponent @relation(fields: [salaryComponentId], references: [salaryComponentId])
  createdAt             DateTime @default(now())

  @@unique([salaryStructureId, salaryComponentId])
  @@index([schoolId])
}

// A finalized (or draft) monthly statement for a member. Lines snapshot the structure at run time.
model Payslip {
  payslipId       String        @id @default(uuid())
  schoolId        String
  userSchoolId    String                                      // the member (PRP-30)
  payMonth        String                                      // "2026-06" — month-scoped (§3.1)
  status          PayslipStatus @default(DRAFT)
  paidDays        Int?                                        // days paid (after LOP)
  lopDays         Int?          @default(0)                   // loss-of-pay days (manual or from PRP-39)
  grossEarnings   Decimal       @db.Decimal(12, 2) @default(0)
  totalDeductions Decimal       @db.Decimal(12, 2) @default(0)
  netPay          Decimal       @db.Decimal(12, 2) @default(0)
  pdfKey          String?                                     // storage key for the payslip PDF (PRP-46)
  finalizedAt     DateTime?
  paidAt          DateTime?
  lines           PayslipLine[]
  school          School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@unique([schoolId, userSchoolId, payMonth])                // one payslip per member per month
  @@index([schoolId])
  @@index([userSchoolId, payMonth])
  @@index([status])
}

model PayslipLine {
  payslipLineId     String        @id @default(uuid())
  schoolId          String
  payslipId         String
  salaryComponentId String?                                   // loose ref (component may be renamed later)
  label             String                                    // snapshot component name
  type              ComponentType
  amount            Decimal       @db.Decimal(12, 2)          // resolved ₹ for this line (Decimal, never float)
  payslip           Payslip       @relation(fields: [payslipId], references: [payslipId], onDelete: Cascade)
  salaryComponent   SalaryComponent? @relation(fields: [salaryComponentId], references: [salaryComponentId])
  createdAt         DateTime      @default(now())

  @@index([schoolId])
  @@index([payslipId])
}
```
Add back-relations to `School` (`salaryComponents`, `salaryStructures`, `salaryStructureItems`, `payslips`, `payslipLines`). `SalaryStructure.userSchoolId`/`Payslip.userSchoolId` are **loose references** to PRP-30's `UserSchool` (no FK blocks) so payroll stays decoupled from the shared membership relation blocks (§8). LOP optionally reads PRP-39's `StaffAttendance` (loose, by `userSchoolId` + month) — no FK.

> **Decision — typed configurable components + effective-dated structures + snapshotted payslips.** Pay is built from a **per-school catalog** of `SalaryComponent`s (earnings/deductions, fixed or %-of-base), so PF/ESI/PT/TDS are *configured rows*, not hard-coded logic (⚠︎ O-P2). A member's `SalaryStructure` is **effective-dated** — a raise creates a new structure (`effectiveFrom` next month) and supersedes the prior (sets `effectiveTo`), preserving history (the same "version, don't overwrite" pattern PRP-44 uses for fee plans). A `Payslip` **snapshots** the resolved lines at run time so a later structure/component edit never rewrites a released payslip (PRP-51's snapshot discipline). Net pay = Σ earnings − Σ deductions, pro-rated by `paidDays/monthDays` when `lopDays > 0`. All `Decimal`.

#### 3.2 Payroll run / computation (the core)
A pure, testable computation in `src/modules/payroll/compute.ts`, fed by the member's active structure for the month:
1. Resolve the member's `SalaryStructure` where `effectiveFrom <= payMonth` and (`effectiveTo` is null or `>= payMonth`) — the active structure that month.
2. Resolve each `SalaryStructureItem`: `FIXED` → its amount; `PERCENT_OF_BASE` → `percent × base-component amount` (the `isBase` component) as `Decimal`.
3. **Pro-rate** earnings (not statutory deductions, by convention — ⚠︎ O-P2 leaves this a config flag) by `paidDays = monthDays − lopDays`.
4. Sum `grossEarnings`, `totalDeductions`, `netPay = gross − deductions`; emit a `PayslipLine` per component. All `Decimal`, rounded at 2dp deterministically; serialized as strings.

This is unit-testable in isolation (a stated acceptance criterion) — exactly the calc/settlement split PRP-45 (`computeStudentDues`) uses.

#### 3.3 Module layout, services & routes (`src/modules/payroll/`)
House split, registered under `src/plugins/school.plugin.ts`:
- `payroll.routes.ts` / `payroll.controller.ts` / `payroll.service.ts` / `payroll.schema.ts` / `payroll.types.ts` + `compute.ts` (the pure §3.2 calc).
- Imports: `renderPdf` + storage helpers (PRP-46 `src/modules/pdf/` + `src/lib/storage/`), the staff member read (PRP-30), and (optionally) PRP-39's `StaffAttendance` for LOP.

`payroll.service.ts` exports (all `fastify`-first, tenant-scoped via `request.schoolContext.schoolId`):
- **Components:** `createComponent`/`listComponents`/`updateComponent` (toggle `isActive`; one `isBase`). Audited on change.
- **Structures:** `setSalaryStructure(fastify, schoolId, userSchoolId, { effectiveFrom, items[] })` — supersede the prior active structure (set `effectiveTo`) and create the new one (effective-dated history); validates components are active + the `%` base exists. `getActiveStructure(userSchoolId, payMonth)` / `listStructures(userSchoolId)`. Audited (`payroll.structure_set`).
- **Payslip run:** `runPayroll(fastify, schoolId, { payMonth, userSchoolIds?, lopByMember? })` — for each member (default: all active staff/teachers with a structure): resolve the active structure, optionally pull `lopDays` (from `lopByMember` or PRP-39), run `compute.ts`, **upsert** a `DRAFT` `Payslip` + its `PayslipLine`s. Idempotent (re-runnable until finalized). Audited (`payroll.run`, count + month in metadata).
- **Finalize / pay / cancel:** `finalizePayslip(payslipId)` (DRAFT→FINALIZED, **immutable** thereafter; renders + stores the PDF; **awaited** audit `payroll.finalize`), `markPaid(payslipId)` (FINALIZED→PAID), `cancelPayslip(payslipId)`.
- **PDF:** `getPayslipPdf(fastify, schoolId, payslipId)` — signed URL / streamed buffer; regenerates from the immutable payslip if `pdfKey` null (PRP-46 reproducible pattern). New `payslip` template over the shared renderer.
- **Employee read:** `getMyPayslips(fastify, ctx, { payMonth? })` — the **caller's own** payslips only (resolve `userSchoolId` from session; never trust a client id). A member reads their own; an admin reads any via the staff-scoped list.

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations also `fastify.requireWritableSchool` PRP-15):
- `POST|GET /api/school/payroll/components`, `PATCH /api/school/payroll/components/:salaryComponentId` — (`payroll.manage` / `payroll.read`)
- `PUT /api/school/payroll/members/:userSchoolId/structure` (`payroll.manage`) · `GET /api/school/payroll/members/:userSchoolId/structure` (`payroll.read`)
- `POST /api/school/payroll/run` (`payroll.run`) — body `{ payMonth, userSchoolIds?, lopByMember? }`
- `GET /api/school/payroll/payslips` (`payroll.read`, `?payMonth=`/`?userSchoolId=`) · `POST /api/school/payroll/payslips/:payslipId/finalize` (`payroll.run`) · `POST /api/school/payroll/payslips/:payslipId/pay` (`payroll.run`) · `POST /api/school/payroll/payslips/:payslipId/cancel` (`payroll.manage`)
- `GET /api/school/payroll/payslips/:payslipId/pdf` (`payroll.read`, own-or-admin) → `application/pdf`
- Employee self: `GET /api/school/payroll/my-payslips` (`payroll.read_own`) — caller's own payslips

All JSON responses use `successResponse`/`errorResponse`; `Decimal`s serialized as strings; PDF route returns `application/pdf`.

#### 3.4 Permission strings (extends PRP-17 §3.4)
Introduce the **`payroll`** resource (PRP-17 owns the canonical list + seed matrix; this PRP adds rows). Payroll is **sensitive** — restrict tightly: `payroll.manage` = components/structures/cancel; `payroll.run` = run/finalize/pay (the disbursement-affecting verbs); `payroll.read` = staff-side payslip/structure views; `payroll.read_own` = a member's own payslips.

| Resource | Actions (P8) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `payroll` | `read`, `manage`, `run`, `read_own` | read+manage+run | `read_own` (own payslips; `+manage/run` only if an HR/accounts staff per matrix) | `read_own` | – | – |

⚠︎ Whether non-admin **accounts/HR staff** get `payroll.manage`/`run` is an O-P2 policy call; v1 grants full payroll to ADMIN and **own-payslip** read to every staff/teacher (`payroll.read_own`), leaving broader staff grants to the SuperAdmin permission editor (PRP-17/PRP-22). Own-scope is enforced **in the service** (session `userSchoolId`), not the matrix.

### Frontend

#### 3.5 FE design (`src/modules/payroll/` + `src/store/payroll/`)
Mirror the FE feature/state convention (CLAUDE.md): UI in `src/modules/payroll/`, client state/API in `src/store/payroll/` (`payroll.store.ts` / `payroll.services.ts` / `payroll.type.ts`), TanStack Query for server state, `helper.*` normalization, routes from `APP_ROUTES`, `cn()` for classes, `DataGrid` for payslip lists, `src/components/ui/` primitives. **All ₹ amounts come from the API as strings and are displayed verbatim** (no float math in the FE — PRP-44/46 rule).
- **Payroll admin (`payroll.manage`/`run`):** a **Components** screen (earnings/deductions, fixed/%, base flag), a member **Structure** editor (effective-dated, with a live gross/net preview from the run/compute response), a **Payroll Run** screen (pick month + members, optional LOP, generate drafts → review `DataGrid` → finalize → mark paid → download payslip PDFs).
- **Employee:** a **My Payslips** view (own monthly payslips + download), slotted into the staff/teacher dashboard (PRP-25 landing).
- Combined PRP per the implementation-plan "Payroll" `BE/FE` row; no separate FE PRP number — FE work specified here.

## 4. Implementation steps

### Backend
1. **Schema:** add `ComponentType`/`ComponentCalc`/`PayslipStatus`, `SalaryComponent`/`SalaryStructure`/`SalaryStructureItem`/`Payslip`/`PayslipLine` + `School` back-relations. `pnpm exec prisma migrate dev --name payroll` then `pnpm prisma:generate`. (No `UserSchool` relation block — `userSchoolId` is a loose column, §8.) Confirm `Decimal` columns generate.
2. **PDF template:** add `src/modules/pdf/templates/payslip.*` to the **existing** shared PDF service (PRP-46) + register it. **Do not** add a new PDF dependency.
3. **Module scaffold:** add `src/modules/payroll/{routes,controller,service,schema,types}.ts` + `compute.ts` (controllers thin; service `fastify`-first). Enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
4. **Compute:** implement the pure `compute.ts` (§3.2 — resolve active structure, %-of-base, LOP pro-ration, sums) with **unit tests** (fixed + %, LOP pro-ration, deduction handling) using `Decimal` (reuse PRP-46's `Decimal` import path; round 2dp deterministically; serialize as strings).
5. **Services:** implement component CRUD, effective-dated `setSalaryStructure` (supersede prior), `runPayroll` (idempotent draft upsert), `finalizePayslip` (lock + render + store PDF + awaited audit), `markPaid`/`cancel`, `getPayslipPdf` (regenerable), and own-scoped `getMyPayslips`.
6. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; own-scope `getMyPayslips` by session `userSchoolId`.
7. **Permissions:** add `payroll.read`/`manage`/`run`/`read_own` rows + matrix to `src/modules/authz/permissions.ts` (PRP-17); re-run `pnpm seed:permissions`.
8. **Audit:** **awaited** `writeAudit()` (PRP-18) on `payroll.structure_set`, `payroll.run`, `payroll.finalize`, `payroll.pay` (D22 — pay is a money action).
9. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + `SetStructureBody`, `RunPayrollBody`, `PayslipDto`, `SalaryComponentDto`.

### Frontend
1. **Store layer:** add `src/store/payroll/{payroll.store.ts,payroll.services.ts,payroll.type.ts}` — services call `apiClient` against §3.3, normalized via `helper.*`; TanStack Query hooks; PDF endpoints fetched as blobs. Amounts kept as strings.
2. **Routes/menu:** add payroll route strings to `APP_ROUTES` (`src/constants/routes.ts`) and the menu entry to `getMenuList` (`src/constants/project.menu.ts`) gated on `payroll.*` (PRP-11).
3. **Admin UI:** `src/modules/payroll/` — Components, member Structure editor (gross/net preview), Payroll Run (month/members → drafts → finalize → pay → download).
4. **Employee view:** a "My Payslips" panel on the staff/teacher dashboard.
5. **Validation:** forms via the PRP-13 stack; `cn()` for classes; no axios in components; never compute money in JS (display API strings).

## 5. Files added / changed

### Backend
- **Add:** `src/modules/payroll/payroll.routes.ts`, `payroll.controller.ts`, `payroll.service.ts`, `payroll.schema.ts`, `payroll.types.ts`, `compute.ts`; `src/modules/pdf/templates/payslip.*` (template in the **existing** shared PDF service)
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `payroll.*`), `src/modules/pdf/pdf.registry.ts` (register the payslip template)

### Frontend
- **Add:** `src/modules/payroll/*` (Components / Structure / Run / My-Payslips screens), `src/store/payroll/payroll.store.ts`, `payroll.services.ts`, `payroll.type.ts`
- **Edit:** `src/constants/routes.ts` (`APP_ROUTES`), `src/constants/project.menu.ts` (menu)

## 6. Acceptance criteria
- [ ] `SalaryComponent`/`SalaryStructure`/`SalaryStructureItem`/`Payslip`/`PayslipLine` tables exist with the documented uniques + indexes; all carry `schoolId`; **all money columns are `Decimal`** (no float); one payslip per member per month.
- [ ] An admin can define earnings/deductions (fixed + %-of-base), set a member's effective-dated structure (a raise supersedes the prior, history preserved), and run a month's payroll.
- [ ] `compute.ts` resolves the active structure, computes %-of-base lines, pro-rates by `lopDays`, and produces correct gross/deductions/net with `Decimal` math — covered by **unit tests**; re-running a draft month recomputes.
- [ ] `finalizePayslip` locks the payslip (immutable), renders + stores a payslip **PDF** via the **shared** renderer (PRP-46 — no second PDF engine), and writes an **awaited** `payroll.finalize` audit entry; a finalized payslip never changes when a structure is later edited (snapshot).
- [ ] An employee reads **only their own** payslips (`payroll.read_own`, session-scoped) and downloads their PDF; an admin reads any.
- [ ] All routes are tenant-scoped (client `schoolId` ignored) + permission-guarded; payroll mutations `403/402` on a non-writable school (PRP-15); structure/run/finalize/pay audited (PRP-18).
- [ ] ⚠︎ O-P8/O-P2 assumptions recorded inline: PF/ESI/PT/TDS are **configurable components** (no statutory slab engine), LOP is an optional pro-ration input, bank-file/e-filing are out.
- [ ] **FE:** Components / Structure / Run / My-Payslips screens exist; amounts displayed as API strings; routes via `APP_ROUTES`, menu gated on `payroll.*`.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; `pnpm exec prisma migrate dev --name payroll` applies cleanly; `pnpm seed:permissions` adds `payroll.*`.
- **Frontend:** `yarn type-check && yarn lint && yarn build` (and `yarn check`).
- Manual (against PRP-30 staff): define Basic (base) + HRA (40% of Basic) + PF (12% of Basic, deduction) → set a teacher's structure → run payroll for 2026-06 with 2 LOP days → inspect the draft (HRA = 40% Basic, pro-rated, PF deducted, net correct) → finalize → payslip PDF downloads → fetch "my payslips" as that teacher (own only) and confirm an unrelated staff cannot read it; edit the structure and confirm the finalized payslip is unchanged.

## 8. Risks & rollback
- **Money correctness (paramount):** every amount is `Decimal`; %-of-base, LOP pro-ration, and net = gross − deductions must reconcile to the paisa — resolve percentages to `Decimal`, round 2dp deterministically, **never** `Number()` a salary value (D1, PRP-44/45/46). Cover `compute.ts` with fixed/%/LOP tests. This is the highest-stakes correctness surface in P8.
- **⚠︎ O-P2/O-P8 statutory depth is the defining risk:** PF/ESI/PT/TDS slabs, ceilings, and YTD TDS are **not** built — they are configurable deduction components. A school needing true statutory automation is a **future PRP gated on O-P2**; do **not** hard-code any statutory rule into `compute.ts`. The mitigation is component-as-data + the `isStatutory` flag as a marker for that later engine.
- **Snapshot + finalize immutability:** a finalized payslip must not change when a structure/component is later edited — snapshot lines at run, freeze at finalize, require cancel→re-run to change (PRP-51's discipline). Silently altered released payslips are the worst outcome; the finalize lock is the rail.
- **Reuse the shared PDF service:** the payslip is a template over PRP-46's `renderPdf` + `src/lib/storage/` — **no** second PDF dependency (PRP-46 §8). Record this in the PR.
- **Effective-dating correctness:** resolving "the active structure for month M" (`effectiveFrom <= M <= effectiveTo|∞`) must pick exactly one; superseding must set the prior `effectiveTo` so two structures never overlap. Cover with a raise-mid-tenure test.
- **Sensitivity / least privilege:** payroll is salary data — keep `payroll.manage`/`run` tightly scoped (ADMIN by default), own-payslip read session-scoped, and audit every money action. A leak (one staff seeing another's pay) is high-severity — enforce own-scope in the service, never via a client-supplied id.
- **Loose member ref (§8):** `userSchoolId` is a loose column (no FK) to avoid touching the shared `UserSchool`/`Student` relation blocks; LOP from PRP-39 is an optional, loose read.
- **Rollback:** additive module + tables + one shared-PDF template (BE) and additive feature dir + store (FE); revert the module/template, drop the five tables. Inert until routes are registered; the shared PDF service is untouched (only extended with a template).
