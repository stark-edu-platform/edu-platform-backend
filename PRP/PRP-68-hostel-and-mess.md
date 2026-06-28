# PRP-68 — Hostel & mess (rooms, allocation, mess plans)

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟢 Low · **Size:** M
> **Depends on:** PRP-31 (`Student` + guardian linkage — a hostel allocation is for a student; the parent sees their child's room/warden), PRP-32 (`Enrollment` — allocation is per-year; occupancy lists join enrolment for class/section context), PRP-44/45/46 (the **fee stack** — hostel + mess charges reuse the `OPTIONAL_HEAD` mechanism (PRP-45) against optional `FeeHead`s (PRP-44) so `computeStudentDues` (PRP-46) bills them, exactly like transport in PRP-64), PRP-30 (`StaffProfile` — a warden is a staff member; loose ref), PRP-28 (academic-year scoping), PRP-17 (RBAC — new `hostel.*` strings), PRP-12 (school context / tenant scoping), PRP-15 (`requireWritableSchool` on writes), PRP-18 (`writeAudit` on allocation/fee-linking) · **Feeds:** the FE hostel screens (this combined PRP, §3-FE/§4-FE) · **Gated on O-P8** (Extended-module priority + hostel/mess depth — master §10)

## 1. Problem / current state
The platform has no **residential** model: nothing records the school's **hostels/buildings**, the **rooms** and their capacity, **which student occupies which room** (and bed), the **warden**, or the **mess plan** a boarder is on — and therefore no clean way to bill the **hostel** and **mess** fees that, like transport (D21, PRP-64), are **optional per-student charges**. This PRP adds a lean residential domain and **reuses the same optional-head fee mechanism PRP-64 established for transport**: allocating a student to a room (and/or a mess plan) creates an `OPTIONAL_HEAD` `FeeAdjustment` (PRP-45) so the charge flows through the existing dues/receipts/defaulter machinery — no parallel money path.

This is a **low-severity, self-contained** Extended module, **far-future and O-P8-gated** (implementation-plan §P8 ⚠︎). The model is solid (hostel/room/allocation + a configurable mess plan) but the surface is deliberately lean: **no** detailed mess attendance/coupon accounting, **no** inventory/kitchen stock, **no** visitor/leave registers (seams noted).

> ⚠︎ **Open questions (master §10 O-P8 — Extended-module priority + hostel/mess depth):**
> - **Mess accounting depth is unresolved.** **Assumption (inline):** mess is billed as a **flat per-plan charge** (a `MessPlan` with a monthly/term `amount`) via the optional-head mechanism — **not** a per-meal/coupon ledger. Daily mess attendance, coupon books, and consumption-based billing are **out**; the `MessPlan.amount` lives as data so a later consumption model is additive, not a rewrite.
> - **Hostel fee model (flat vs. per-room-type/AC/occupancy) is open.** **Assumption:** hostel fee is a per-`Room` (or per-room-type) `fee` resolved into an `OPTIONAL_HEAD` against a "Hostel" `FeeHead`; occupancy-tier pricing is later config on `Room`, not a migration.
> - **Mess attendance / leave / discipline registers are out of scope** for v1 (note the seam; a future PRP gated on O-P8).

## 2. Goal & non-goals
- **Goal:** a `src/modules/hostel/` module (house split) with: `Hostel` (a residential building, with a warden + gender designation), `Room` (capacity + optional hostel fee), `HostelAllocation` (a per-year student↔room+bed assignment), `MessPlan` (a per-school configurable meal plan with a charge), and an optional `StudentMess` (a student on a mess plan); admin CRUD; **allocation** + **mess-enrolment** flows that **reuse PRP-45 `OPTIONAL_HEAD`** so hostel + mess fees bill through PRP-46; a parent/student read of "my child's hostel room + warden + mess plan"; and a simple **occupancy report**. Plus the matching **FE** screens (hostel admin + a parent/student hostel card).
- **Non-goals:** the generic `FeeHead`/plan/adjustment **engine** (PRP-44/45 — this PRP *uses* `OPTIONAL_HEAD`), payment recording/receipts (PRP-46), **per-meal mess accounting / coupons / consumption billing** (⚠︎ O-P8 — flat plan charge only), kitchen **inventory/stock** (could fold into PRP-70 inventory later — note the seam), **visitor / leave / gate registers** and discipline logs, room-allocation *optimization*. A **warden** is a loose link to a staff member (PRP-30), not a new role.

## 3. Target design

### Backend

#### 3.1 Schema (`prisma/schema.prisma`)
Denormalize `schoolId`; `Decimal @db.Decimal(12,2)` for any fee (PRP-44/15 rule); enums from `src/generated/prisma/enums.js`.

```prisma
enum HostelType {
  BOYS
  GIRLS
  MIXED
}

enum AllocationStatus {
  ACTIVE
  VACATED         // checked out (history retained)
}

model Hostel {
  hostelId       String     @id @default(uuid())
  schoolId       String
  name           String                                   // "Boys Hostel A"
  type           HostelType @default(MIXED)
  wardenStaffProfileId String?                            // loose ref to PRP-30 StaffProfile; null otherwise
  address        String?
  rooms          Room[]
  school         School     @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
}

model Room {
  roomId       String   @id @default(uuid())
  schoolId     String
  hostelId     String
  roomNumber   String                                     // "A-204"
  capacity     Int      @default(1)                       // beds
  roomType     String?                                    // "AC Double", "Non-AC Triple" — free-text (⚠︎ O-P8 pricing tier)
  fee          Decimal? @db.Decimal(12, 2)                // optional per-room hostel fee (else a hostel/type default)
  hostel       Hostel   @relation(fields: [hostelId], references: [hostelId], onDelete: Cascade)
  allocations  HostelAllocation[]
  school       School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([hostelId, roomNumber])
  @@index([schoolId])
  @@index([hostelId])
}

// Per-year allocation of a student to a room + bed. This row drives the hostel OPTIONAL_HEAD fee (§3.3).
model HostelAllocation {
  hostelAllocationId String           @id @default(uuid())
  schoolId           String
  academicYearId     String                               // year-scoped (D18/PRP-28)
  studentId          String
  roomId             String
  bedNo              String?                              // optional bed label within the room
  status             AllocationStatus @default(ACTIVE)
  allocatedAt        DateTime         @default(now())
  vacatedAt          DateTime?
  feeAdjustmentId    String?                              // the hostel OPTIONAL_HEAD adjustment (PRP-45)
  room               Room             @relation(fields: [roomId], references: [roomId])
  student            Student          @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school             School           @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt

  @@unique([studentId, academicYearId])                   // one active hostel allocation per student per year
  @@index([schoolId])
  @@index([roomId])
  @@index([academicYearId, status])
}

// A configurable mess/meal plan (flat charge — ⚠︎ O-P8, no per-meal accounting).
model MessPlan {
  messPlanId   String   @id @default(uuid())
  schoolId     String
  name         String                                     // "Standard Veg", "Premium"
  amount       Decimal  @db.Decimal(12, 2)                // flat charge (per the school's billing cadence)
  description  String?
  isActive     Boolean  @default(true)
  students     StudentMess[]
  school       School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
}

// A student enrolled on a mess plan for a year — drives the mess OPTIONAL_HEAD fee (§3.3).
model StudentMess {
  studentMessId   String   @id @default(uuid())
  schoolId        String
  academicYearId  String
  studentId       String
  messPlanId      String
  feeAdjustmentId String?                                 // the mess OPTIONAL_HEAD adjustment (PRP-45)
  isActive        Boolean  @default(true)
  messPlan        MessPlan @relation(fields: [messPlanId], references: [messPlanId])
  student         Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school          School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([studentId, academicYearId])                   // one active mess plan per student per year
  @@index([schoolId])
  @@index([messPlanId])
}
```
Add back-relations to `School` (`hostels`, `rooms`, `hostelAllocations`, `messPlans`, `studentMesses`) and **`hostelAllocations`/`studentMesses` to the existing `Student`** (coordinate the shared `Student` edit with PRP-31/32/44/45/46/64 — §8). `Hostel.wardenStaffProfileId` and the `feeAdjustmentId`s are **loose references** (no FK blocks) to stay decoupled from PRP-30/45.

> **Decision — allocation/mess-enrolment ARE the opt-ins; reuse PRP-45, mirror PRP-64.** Exactly as transport (PRP-64), residential charges are **not** a new money path: allocating a student to a room creates an `OPTIONAL_HEAD` `FeeAdjustment` (PRP-45) against the school's **"Hostel" `FeeHead`** at the resolved room fee; enrolling on a mess plan creates one against the **"Mess" `FeeHead`** at the plan amount. `computeStudentDues` (PRP-46) bills both automatically; vacating / un-enrolling deactivates the respective adjustment (soft — history kept). This deliberately copies PRP-64's pattern so the platform has **one** optional-head fee idiom (transport/hostel/mess), not three.

#### 3.2 Module layout (`src/modules/hostel/`)
House split, registered under `src/plugins/school.plugin.ts`, mirroring `src/modules/transport/` (PRP-64):
- `hostel.routes.ts` / `hostel.controller.ts` / `hostel.service.ts` / `hostel.schema.ts` / `hostel.types.ts`.
- Imports: `resolveCurrentAcademicYear` (PRP-28), `createAdjustment`/`deactivateAdjustment` (PRP-45), the "Hostel"/"Mess" `FeeHead` lookup via PRP-44, and `resolveParentChildren` (PRP-41) for the parent read.

#### 3.3 Services & routes
`hostel.service.ts` exports (all `fastify`-first, tenant-scoped via `request.schoolContext.schoolId`):
- **Hostels/Rooms:** `createHostel`/`listHostels`/`updateHostel` (set warden), `createRoom`/`listRooms`/`updateRoom` (capacity + optional fee + type). Soft-deactivate; never hard-delete a room/hostel with allocation history.
- **Mess plans:** `createMessPlan`/`listMessPlans`/`updateMessPlan` (flat `amount`).
- **Allocation (fee-linked):** `allocateRoom(fastify, schoolId, { studentId, roomId, bedNo?, academicYearId? })` — one transaction: validate the room has free capacity (`ACTIVE` allocations < `room.capacity`) and the student is enrolled that year (PRP-32); upsert `HostelAllocation` (one per student/year); resolve the hostel fee (`room.fee` ?? hostel/type default); **call PRP-45 `createAdjustment(OPTIONAL_HEAD, "Hostel" head, AMOUNT, fee)`** and store `feeAdjustmentId`. `vacateRoom(...)` — set `VACATED` + `vacatedAt` and `deactivateAdjustment(feeAdjustmentId)`. Audited (`hostel.allocate`/`hostel.vacate`).
- **Mess enrolment (fee-linked):** `enrollMess(fastify, schoolId, { studentId, messPlanId, academicYearId? })` — upsert `StudentMess`; `createAdjustment(OPTIONAL_HEAD, "Mess" head, AMOUNT, plan.amount)`; store `feeAdjustmentId`. `unenrollMess(...)` — deactivate row + adjustment. Audited.
- **Parent/student read:** `getStudentHostel(fastify, ctx, studentId, { academicYearId? })` — the child's hostel name, room/bed, warden name/contact, and mess plan. PARENT → only linked children (reuse **PRP-41 `resolveParentChildren`**); STUDENT → self. Never trusts a client `studentId`.
- **Occupancy report:** `getOccupancy(fastify, schoolId, { hostelId?, academicYearId? })` — rooms with capacity vs. `ACTIVE` allocations (free/occupied beds), for the admin `DataGrid`.

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations also `fastify.requireWritableSchool` PRP-15):
- `POST|GET /api/school/hostel/hostels`, `PATCH /api/school/hostel/hostels/:hostelId` — (`hostel.manage` / `hostel.read`)
- `POST|GET /api/school/hostel/rooms`, `PATCH /api/school/hostel/rooms/:roomId` — (`hostel.manage` / `hostel.read`)
- `POST|GET /api/school/hostel/mess-plans`, `PATCH /api/school/hostel/mess-plans/:messPlanId` — (`hostel.manage` / `hostel.read`)
- `POST /api/school/hostel/allocations` (`hostel.allocate`) · `DELETE /api/school/hostel/allocations/:hostelAllocationId` (vacate) (`hostel.allocate`) · `GET /api/school/hostel/allocations` (`hostel.read`)
- `POST /api/school/hostel/mess-enrollments` (`hostel.allocate`) · `DELETE /api/school/hostel/mess-enrollments/:studentMessId` (`hostel.allocate`)
- Parent/student: `GET /api/school/hostel/students/:studentId` (`hostel.read`, ownership-scoped) · Occupancy: `GET /api/school/hostel/occupancy` (`hostel.read`)

All responses use `successResponse`/`errorResponse`; `Decimal` fees serialized as strings.

#### 3.4 Permission strings (extends PRP-17 §3.4)
Introduce the **`hostel`** resource (PRP-17 owns the canonical list + seed matrix; this PRP adds rows). `hostel.allocate` = the student↔room / student↔mess assignment (the fee-linked verbs); `hostel.manage` = hostels/rooms/mess-plans config; `hostel.read` = occupancy + the parent/student "my hostel" view.

| Resource | Actions (P8) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `hostel` | `read`, `manage`, `allocate` | read+manage+allocate | read+manage+allocate | – | `read` (own §3.3) | `read` (children's §3.3) |

(A warden is modeled as STAFF with `hostel.*` — no new role. Student/parent read-scope is enforced **in the service** via `resolveParentChildren`/session, not the matrix — PRP-30/49/64 pattern.)

### Frontend

#### 3.5 FE design (`src/modules/hostel/` + `src/store/hostel/`)
Mirror the FE feature/state convention (CLAUDE.md): UI in `src/modules/hostel/`, client state/API in `src/store/hostel/` (`hostel.store.ts` / `hostel.services.ts` / `hostel.type.ts`), TanStack Query for server state, `helper.*` normalization, routes from `APP_ROUTES`, `cn()` for classes, `DataGrid` for occupancy/allocation lists, `src/components/ui/` primitives.
- **Admin/Warden (`hostel.manage`/`allocate`):** Hostels (+ warden), Rooms (capacity/type/fee), Mess Plans, an **Allocation** screen (search a student → pick room+bed; shows the resulting hostel fee — surfaced from the allocation response / `computeStudentDues`), a **Mess enrolment** screen, and an **Occupancy** report (`DataGrid`, free/occupied beds).
- **Parent/Student:** a "Hostel" card (hostel/room/bed, warden contact, mess plan) on the PRP-43 parent/student dashboard; hostel + mess **fees** appear in the existing PRP-48 fee view (no separate hostel-fee UI — optional heads).
- Combined PRP per the implementation-plan "Hostel/mess" `BE/FE` row; no separate FE PRP number — FE work specified here.

## 4. Implementation steps

### Backend
1. **Schema:** add `HostelType`/`AllocationStatus`, the `Hostel`/`Room`/`HostelAllocation`/`MessPlan`/`StudentMess` models + `School` back-relations + `Student.hostelAllocations`/`studentMesses`; coordinate the `Student` edit (§8). `pnpm exec prisma migrate dev --name hostel_and_mess` then `pnpm prisma:generate`.
2. **Module scaffold:** add `src/modules/hostel/{routes,controller,service,schema,types}.ts` (controllers thin; service `fastify`-first). Enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Services:** implement hostel/room/mess-plan CRUD; `allocateRoom`/`vacateRoom` and `enrollMess`/`unenrollMess` — the fee links via PRP-45 `createAdjustment(OPTIONAL_HEAD)` / `deactivateAdjustment`, persisting `feeAdjustmentId`; capacity guard on allocation; the ownership-scoped parent/student read; the occupancy report.
4. **Hostel/Mess `FeeHead` bootstrap:** ensure (or lazily create) `isOptional` "Hostel" and "Mess" `FeeHead`s via PRP-44 before creating adjustments — one head each, not per room/plan (mirrors PRP-64's transport-head bootstrap).
5. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; ownership scoping in the parent/student read (PRP-41).
6. **Permissions:** add `hostel.read`/`manage`/`allocate` rows + matrix to `src/modules/authz/permissions.ts` (PRP-17); re-run `pnpm seed:permissions`.
7. **Audit:** `writeAudit()` (PRP-18) on `hostel.allocate`/`vacate`, mess enrol/unenrol, and hostel/room/mess-plan mutations.
8. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + `CreateHostelBody`, `CreateRoomBody`, `AllocateRoomBody`, `EnrollMessBody`, `HostelDto`.

### Frontend
1. **Store layer:** add `src/store/hostel/{hostel.store.ts,hostel.services.ts,hostel.type.ts}` — services call `apiClient` against §3.3, normalized via `helper.*`; TanStack Query hooks.
2. **Routes/menu:** add hostel route strings to `APP_ROUTES` (`src/constants/routes.ts`) and the menu entry to `getMenuList` (`src/constants/project.menu.ts`) gated on `hostel.*` (PRP-11).
3. **Admin UI:** `src/modules/hostel/` — Hostels, Rooms, Mess Plans, Allocation (student → room/bed → fee preview), Mess enrolment, Occupancy (`DataGrid`).
4. **Parent/student card:** a hostel summary card slotted into the PRP-43 parent/student dashboard.
5. **Validation:** forms via the PRP-13 stack; `cn()` for classes; no axios in components.

## 5. Files added / changed

### Backend
- **Add:** `src/modules/hostel/hostel.routes.ts`, `hostel.controller.ts`, `hostel.service.ts`, `hostel.schema.ts`, `hostel.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `hostel.*`)

### Frontend
- **Add:** `src/modules/hostel/*` (admin screens + parent/student card), `src/store/hostel/hostel.store.ts`, `hostel.services.ts`, `hostel.type.ts`
- **Edit:** `src/constants/routes.ts` (`APP_ROUTES`), `src/constants/project.menu.ts` (menu), the PRP-43 parent/student dashboard (slot the hostel card)

## 6. Acceptance criteria
- [ ] `Hostel`/`Room`/`HostelAllocation`/`MessPlan`/`StudentMess` tables exist with the documented uniques + indexes; all carry `schoolId`; allocation + mess enrolment are one-per-student-per-year; fees are `Decimal`.
- [ ] An admin/warden can create hostels (+warden), rooms (capacity/type/fee), and mess plans, and allocate a student to a room+bed (blocked when the room is full).
- [ ] Allocating a room creates a "Hostel" `OPTIONAL_HEAD` `FeeAdjustment` (PRP-45) at the room fee, and enrolling on a mess plan creates a "Mess" one at the plan amount — so `computeStudentDues` (PRP-46) bills both with no new money code; vacating / un-enrolling deactivates the respective adjustment (soft).
- [ ] A PARENT/STUDENT reads **only** their own/children's hostel (room/bed/warden/mess) via `resolveParentChildren` (PRP-41); an unlinked `studentId` is `403/404`.
- [ ] The occupancy report shows free vs. occupied beds per room/hostel.
- [ ] All routes are tenant-scoped (client `schoolId` ignored) + permission-guarded; mutations `403/402` on a non-writable school (PRP-15); allocation/mess changes audited (PRP-18).
- [ ] ⚠︎ O-P8 assumptions recorded inline: mess is a **flat per-plan charge** (no per-meal/coupon accounting), hostel fee uses the optional-head mechanism (no occupancy-tier engine), visitor/leave registers out.
- [ ] **FE:** hostel admin screens + a parent/student hostel card exist; hostel + mess fees appear in the existing PRP-48 fee view; routes via `APP_ROUTES`, menu gated on `hostel.*`.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; `pnpm exec prisma migrate dev --name hostel_and_mess` applies cleanly; `pnpm seed:permissions` adds `hostel.*`.
- **Frontend:** `yarn type-check && yarn lint && yarn build` (and `yarn check`).
- Manual (against PRP-31/32/44/45/46 data): create "Hostel" + "Mess" optional heads → create a hostel + a capacity-2 room + a mess plan → allocate a student (and enrol on mess) → `GET /students/:id/dues` (PRP-45) includes both hostel + mess; allocate a 3rd student to the full room → rejected; vacate one → its adjustment deactivates and dues drop. Fetch the parent hostel card as the linked parent (visible) and as an unrelated parent (denied); pull occupancy.

## 8. Risks & rollback
- **Fee-link correctness (headline, shared with PRP-64):** room allocation ↔ "Hostel" adjustment and mess enrolment ↔ "Mess" adjustment must stay in sync (track via each `feeAdjustmentId`); allocate creates exactly one active adjustment per concern, vacate/un-enrol deactivates exactly that one. A **mid-year room-fare / mess-plan change** must use **PRP-45's real verb: deactivate-then-create** (`deactivateAdjustment(oldId)` then `createAdjustment(...)` at the new fee) — PRP-45 exports **no `updateAdjustment`** (adjustments are immutable, PRP-45 §3.3), so do not assume an in-place update. Reuse PRP-45's `createAdjustment`/`deactivateAdjustment` — **one** optional-head idiom across transport/hostel/mess, no fourth money path. Cover with a test (allocate → dues up → vacate → dues back).
- **Capacity integrity:** `allocateRoom` must count `ACTIVE` allocations against `room.capacity` **inside the transaction** so two admins can't over-fill a room; the `@@unique([studentId, academicYearId])` stops double-allocating a student. Cover with a full-room rejection test.
- **Decimal fees:** `room.fee` / `MessPlan.amount` are `Decimal`; never float (D1, PRP-44/45). Resolve and pass strings to PRP-45.
- **⚠︎ O-P8 mess depth is a seam, not a feature:** v1 is a flat per-plan charge — **no** per-meal accounting, coupons, consumption billing, or kitchen inventory. Those are future PRPs gated on O-P8 (mess→inventory could fold into PRP-70). Keep the flat-charge assumption and resist scope creep.
- **Parent-scope safety:** the "my hostel" read must go through PRP-41's `resolveParentChildren` (single guardian-edge gate) — never re-implement the `ParentStudent` join.
- **Warden ≠ employee record here:** `wardenStaffProfileId` is a loose link to PRP-30 (no FK) — do not couple to PRP-30/67.
- **Shared `Student` edit (§8):** adds `hostelAllocations`/`studentMesses` to a `Student` model also extended by PRP-31/32/44/45/46/64 — land in dependency order and rebase the relation block so it accretes without duplicate fields (PRP-29 §8 convention).
- **Rollback:** additive module + tables (BE) and additive feature dir + store (FE); revert the module/feature, drop the five tables, remove the two `Student` back-relations. Inert until routes are registered.
