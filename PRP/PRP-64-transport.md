# PRP-64 — Transport (routes / stops / vehicles / drivers, student assignment, transport-fee link, optional GPS)

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟠 Med · **Size:** L
> **Depends on:** PRP-31 (`Student` + guardian linkage — a student is assigned a route/stop; the parent sees their child's transport), PRP-46 (`computeStudentDues`/`StudentFee`/`Payment` — the transport fee settles through the same ledger), PRP-45 (`FeeAdjustment` `OPTIONAL_HEAD` + `FeeHead.isOptional` — a route assignment **is** the transport opt-in; `computeStudentDues` already adds opted-in optional heads), PRP-44 (`FeeHead` catalog — a "Transport" head is the charge target), PRP-32 (`Enrollment` — assignment is per-year; seat/route lists are per class/section), PRP-28 (academic-year scoping), PRP-30 (`StaffProfile` — a driver may be a staff member; loose ref), PRP-17 (RBAC — new `transport.*` strings), PRP-12 (school context / tenant scoping), PRP-15 (`requireWritableSchool` on writes), PRP-18 (`writeAudit` on assignment/fee-linking changes) · **Feeds:** the FE transport screens (this combined PRP, §3-FE/§4-FE), and is **gated on O-P8** (Extended-module priority + GPS depth — master §10)

## 1. Problem / current state
The platform models students (PRP-31), enrollment (PRP-32) and a full fee stack (PRP-44/45/46), but has **no transport model**: nothing records the school's bus **routes**, the **stops** on each route, the **vehicles** and their **drivers**, or **which student rides which route/stop** — and therefore no clean way to bill the transport fee that decision **D21** lists as an *optional, per-route head*. Today a school wanting bus fees has to hand-create a generic optional `FeeHead` (PRP-44) and a manual `OPTIONAL_HEAD` adjustment per student (PRP-45) with no route context. This PRP adds the transport domain and **wires the route assignment to that existing optional-head machinery** so transport billing is a by-product of assigning a student to a route — not a parallel money path.

This is the **first** Phase-8 Extended module. P8 modules are explicitly **far-future and open-question-gated** (implementation-plan §P8; the row carries the **⚠︎** flag). This PRP keeps the model solid but the surface lean: routes/stops/vehicles/drivers/assignment + the fee link as the core; **GPS/live-tracking is modeled behind a flag and left mostly stubbed** pending O-P8.

> ⚠︎ **Open questions (master §10 O-P8 — Extended-module priority + depth):**
> - **GPS / live tracking depth is unresolved.** This PRP includes a `gpsDeviceId` on `Vehicle` and a thin, optional `VehicleLocation` ping model **behind a `transport.gpsEnabled` school flag**, but builds **no** real-time pipeline (no websockets, no device ingest protocol, no map). Treat GPS as a **schema seam + assumption**, not a deliverable; a future PRP wires real ingestion once O-P8 fixes scope/provider.
> - **Fee model for transport (flat vs. per-route vs. per-distance/slab) is not finalized.** **Assumption (inline):** transport is charged via a per-route (optionally per-stop) **amount** that resolves into the existing `OPTIONAL_HEAD` opt-in against a "Transport" `FeeHead` (PRP-45). Distance-slab pricing is out; the `fareAmount` lives on `Route`/`Stop` so a slab policy is later data, not a migration.

## 2. Goal & non-goals
- **Goal:** a `src/modules/transport/` module (house split) with: `Vehicle`, `Driver`, `Route`, `Stop`, and a per-year `StudentTransport` assignment; admin CRUD for each; a **fee link** so assigning a student to a route creates/keeps the `OPTIONAL_HEAD` transport adjustment (PRP-45) at the route/stop fare, so `computeStudentDues` (PRP-46) bills it automatically; a parent/student read of "my child's bus" (route, stop, vehicle, driver contact); and an optional `VehicleLocation` seam behind a GPS flag (⚠︎ O-P8). Plus the matching **FE** screens (transport admin management + a parent transport card).
- **Non-goals:** the generic `FeeHead`/plan/adjustment **engine** (PRP-44/45 — this PRP *uses* `OPTIONAL_HEAD`), payment recording/receipts (PRP-46), real-time GPS ingestion / maps / driver app (⚠︎ O-P8 — schema seam only), route-optimization, attendance-on-bus / boarding scans (out — could be a later P8 add), vehicle maintenance/fuel logs (out — note the seam on `Vehicle`). Driver is a lightweight contact record here, **not** a payroll employee (payroll is PRP-67; if a driver is also staff, link by a loose `staffProfileId`).

## 3. Target design

### Backend

#### 3.1 Schema (`prisma/schema.prisma`)
Denormalize `schoolId` on every row (house convention); `Decimal @db.Decimal(12,2)` for any money (PRP-44/15 rule); enums from `src/generated/prisma/enums.js`.

```prisma
enum VehicleStatus {
  ACTIVE
  MAINTENANCE     // temporarily off-road (seam for a future maintenance log — out of scope)
  RETIRED
}

model Vehicle {
  vehicleId      String        @id @default(uuid())
  schoolId       String
  regNumber      String                                  // registration plate, unique per school
  model          String?                                 // "Tata Starbus", free-text
  capacity       Int?                                    // seats
  status         VehicleStatus @default(ACTIVE)
  gpsDeviceId    String?                                 // ⚠︎ O-P8 GPS seam; null unless a device is fitted
  driverId       String?                                 // primary driver (loose; a vehicle may swap drivers)
  routes         Route[]
  locations      VehicleLocation[]
  school         School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  @@unique([schoolId, regNumber])
  @@index([schoolId])
}

model Driver {
  driverId       String   @id @default(uuid())
  schoolId       String
  name           String
  phone          String?                                  // parents may see this (masked per policy — §3.4)
  licenseNumber  String?
  staffProfileId String?                                  // loose ref to PRP-30 StaffProfile if the driver is staff; null otherwise
  isActive       Boolean  @default(true)
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([schoolId])
}

model Route {
  routeId      String   @id @default(uuid())
  schoolId     String
  name         String                                     // "Route 3 — East City"
  code         String?
  vehicleId    String?                                    // assigned vehicle (and its driver)
  fareAmount   Decimal? @db.Decimal(12, 2)                // default route fare (⚠︎ O-P8 fee model); stop can override
  isActive     Boolean  @default(true)
  vehicle      Vehicle? @relation(fields: [vehicleId], references: [vehicleId])
  stops        Stop[]
  assignments  StudentTransport[]
  school       School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([schoolId, name])
  @@index([schoolId])
}

model Stop {
  stopId       String   @id @default(uuid())
  schoolId     String
  routeId      String
  name         String                                     // "Green Park Gate"
  sequence     Int                                        // order along the route (1-based)
  pickupTime   String?                                    // wall-clock "07:25" (see TZ note §3.6)
  dropTime     String?
  fareAmount   Decimal? @db.Decimal(12, 2)                // optional per-stop fare override (else route.fareAmount)
  latitude     Decimal? @db.Decimal(9, 6)                 // ⚠︎ O-P8 — geocode for a future map; optional
  longitude    Decimal? @db.Decimal(9, 6)
  route        Route    @relation(fields: [routeId], references: [routeId], onDelete: Cascade)
  assignments  StudentTransport[]
  school       School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([routeId, sequence])
  @@index([schoolId])
  @@index([routeId])
}

// Per-year assignment of a student to a route + stop. This row IS the transport opt-in
// that drives the OPTIONAL_HEAD fee adjustment (PRP-45) — §3.3.
model StudentTransport {
  studentTransportId String   @id @default(uuid())
  schoolId           String
  academicYearId     String                               // year-scoped (D18/PRP-28) — re-assigned each year
  studentId          String
  routeId            String
  stopId             String
  direction          String   @default("BOTH")            // PICKUP | DROP | BOTH (free-text v1; could be enum later)
  feeAdjustmentId    String?                              // the OPTIONAL_HEAD adjustment this assignment created (PRP-45)
  isActive           Boolean  @default(true)
  route              Route    @relation(fields: [routeId], references: [routeId])
  stop               Stop     @relation(fields: [stopId], references: [stopId])
  student            Student  @relation(fields: [studentId], references: [studentId], onDelete: Cascade)
  school             School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@unique([studentId, academicYearId])                   // one active transport assignment per student per year
  @@index([schoolId])
  @@index([routeId])
  @@index([academicYearId, routeId])
}

// ⚠︎ O-P8 GPS seam ONLY — a thin location ping store, written by a future ingest path.
// No real-time delivery is built here; this exists so the schema doesn't churn later.
model VehicleLocation {
  vehicleLocationId String   @id @default(uuid())
  schoolId          String
  vehicleId         String
  latitude          Decimal  @db.Decimal(9, 6)
  longitude         Decimal  @db.Decimal(9, 6)
  recordedAt        DateTime @default(now())
  vehicle           Vehicle  @relation(fields: [vehicleId], references: [vehicleId], onDelete: Cascade)
  school            School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)

  @@index([schoolId])
  @@index([vehicleId, recordedAt])
}
```
Add back-relations to `School` (`vehicles`, `drivers`, `routes`, `stops`, `studentTransports`, `vehicleLocations`) and **`studentTransports StudentTransport[]` to the existing `Student`** (coordinate the shared `Student` edit with PRP-31/32/44/45/46 — §8). `Driver.staffProfileId` and `StudentTransport.feeAdjustmentId` are **loose references** (no FK blocks) to stay decoupled from PRP-30/45.

> **Decision — the assignment IS the opt-in; transport billing reuses PRP-45, it does not fork it.** Rather than invent a transport-specific charge, assigning a student to a route creates (or refreshes) an `OPTIONAL_HEAD` `FeeAdjustment` (PRP-45) against the school's **"Transport" `FeeHead`** (an `isOptional` head, PRP-44) with `amount = stop.fareAmount ?? route.fareAmount`. `computeStudentDues` (PRP-45/46) already adds opted-in optional heads, so the transport fee appears in dues/receipts/defaulter reports with **zero** new money code. Un-assigning (or deactivating) the row deactivates that adjustment (soft — PRP-45 keeps history). This is the whole reason PRP-64 depends on PRP-44/45/46.

#### 3.2 Module layout (`src/modules/transport/`)
House split, registered under `src/plugins/school.plugin.ts` (the school-scoped subtree PRP-12 owns), mirroring `src/modules/fees/`:
- `transport.routes.ts` / `transport.controller.ts` / `transport.service.ts` / `transport.schema.ts` / `transport.types.ts`.
- Imports: `resolveCurrentAcademicYear` (PRP-28), `createAdjustment`/`deactivateAdjustment` (PRP-45 `fee-adjustments.service.js`), and (read-only) the "Transport" `FeeHead` lookup via PRP-44's `fee-config.service.js`. Reuses `resolveParentChildren` (PRP-41) for the parent read.

#### 3.3 Services & routes
`transport.service.ts` exports (all `fastify`-first, all tenant-scoped via `request.schoolContext.schoolId` — never a client `schoolId`):
- **Vehicles/Drivers:** `createVehicle`/`listVehicles`/`updateVehicle`, `createDriver`/`listDrivers`/`updateDriver` (soft-deactivate, never hard-delete a driver/vehicle with route history).
- **Routes/Stops:** `createRoute`/`listRoutes`/`updateRoute` (assign a `vehicleId`), `setRouteStops(fastify, schoolId, routeId, stops[])` — full-replace of a route's stops in a transaction (validates `sequence` uniqueness, optional fares parse to `Decimal`). `getRoute` returns the route + ordered stops + vehicle + driver.
- **Assignment (the fee-linked action):** `assignStudentTransport(fastify, schoolId, { studentId, routeId, stopId, academicYearId?, direction? })` — one transaction: validate the stop belongs to the route and the student is enrolled that year (PRP-32); upsert `StudentTransport` (one per student/year); resolve the fare (`stop.fareAmount ?? route.fareAmount`); **call PRP-45 `createAdjustment` with `kind: OPTIONAL_HEAD`, the Transport `FeeHead`, `valueType: AMOUNT`, `amount: fare`** and store the returned `feeAdjustmentId` on the row. `unassignStudentTransport(...)` — deactivate the row **and** `deactivateAdjustment(feeAdjustmentId)` (PRP-45), so dues stop billing transport. `listAssignments({ academicYearId?, routeId?, stopId? })` (a route's manifest). Audited (`transport.assign` / `transport.unassign`, fare + route in metadata).
- **Parent/student read:** `getStudentTransport(fastify, ctx, studentId, { academicYearId? })` — the child's route name, stop (name + pickup/drop time), vehicle reg, and driver name/phone (**masked** per policy, §3.4). PARENT → only linked children (reuse **PRP-41 `resolveParentChildren`**); STUDENT → self only. Never trusts a client `studentId`.
- **GPS seam (⚠︎ O-P8, behind a flag):** `recordVehicleLocation(...)` and `getVehicleLatestLocation(...)` exist as thin stubs guarded by a `transport.gpsEnabled` school flag; with the flag off they `fastify.httpErrors.notImplemented()`. **No** ingest endpoint or socket is wired — this is the seam, documented as deferred.

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations also `fastify.requireWritableSchool` PRP-15):
- `POST|GET /api/school/transport/vehicles`, `PATCH /api/school/transport/vehicles/:vehicleId` — (`transport.manage` / `transport.read`)
- `POST|GET /api/school/transport/drivers`, `PATCH /api/school/transport/drivers/:driverId` — (`transport.manage` / `transport.read`)
- `POST|GET /api/school/transport/routes`, `GET /api/school/transport/routes/:routeId`, `PATCH /api/school/transport/routes/:routeId`, `PUT /api/school/transport/routes/:routeId/stops` — (`transport.manage` / `transport.read`)
- `POST /api/school/transport/assignments` (`transport.assign`) · `DELETE /api/school/transport/assignments/:studentTransportId` (`transport.assign`) · `GET /api/school/transport/assignments` (`transport.read`)
- Parent/student: `GET /api/school/transport/students/:studentId` (`transport.read`, ownership-scoped per §3.4)
- ⚠︎ GPS (stubbed, flag-gated): `GET /api/school/transport/vehicles/:vehicleId/location` (`transport.read`) → `501` unless `gpsEnabled`

All responses use `successResponse`/`errorResponse`; `Decimal` fares serialized as strings.

#### 3.4 Permission strings (extends PRP-17 §3.4)
Introduce the **`transport`** resource (PRP-17 owns the canonical list + seed matrix in `src/modules/authz/permissions.ts`; this PRP adds the rows).

| Resource | Actions (P8) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `transport` | `read`, `manage`, `assign` | read+manage+assign | read+manage+assign | – | `read` (own bus §3.4) | `read` (children's bus §3.4) |

`transport.manage` = vehicles/drivers/routes/stops config; `transport.assign` = student↔route assignment (the fee-linked action); `transport.read` = manifests + the parent/student "my bus" view. Student/parent read-scope (own/children) is enforced **in the service** (`resolveParentChildren`, PRP-41), not the matrix — same pattern as PRP-30/49. ⚠︎ **Driver-phone masking** is a policy call (some schools share the driver number, some mask it): default to returning a **masked** phone to PARENT/STUDENT (last 4 digits) and the full number to staff; the mask threshold is a stated assumption.

#### 3.6 Timezone note
`Stop.pickupTime`/`dropTime` are **wall-clock strings** ("07:25"), not UTC instants (same rule PRP-49 §3.6 uses for exam `startTime`) — a pickup is "07:25 local" regardless of server TZ; the renderer/FE prints them verbatim.

### Frontend

#### 3.5 FE design (`src/modules/transport/` + `src/store/transport/`)
Mirror the FE feature/state convention (CLAUDE.md): UI in `src/modules/transport/`, client state/API in `src/store/transport/` (`transport.store.ts` / `transport.services.ts` / `transport.type.ts`), server state via **TanStack Query**, service responses normalized through `helper.successResponse`/`helper.errorResponse`, routes from `APP_ROUTES` (add the transport entries — never hardcode), classes via `cn()`, tables via the `DataGrid` system, primitives from `src/components/ui/`.
- **Admin (`transport.manage`/`assign`):** Vehicles, Drivers, Routes (with an inline ordered Stops editor + per-stop fare), and an Assignment screen (search a student → pick route+stop → confirm; shows the resulting transport fare so the admin sees the billing consequence — surfaced from `computeStudentDues`/the assignment response). A route **manifest** view (students on a route) using `DataGrid`.
- **Parent/Student:** a compact "Transport" card on the parent multi-child dashboard / student dashboard (route, stop + pickup/drop time, vehicle reg, masked driver contact), reusing the PRP-43 parent-portal layout slot. The transport **fee** shows in the existing PRP-48 fee view (no separate transport-fee UI — it is an optional head).
- This combined PRP follows the implementation-plan's "Transport" row which is `BE/FE`; there is **no** separate FE PRP number — the FE work is specified here.

## 4. Implementation steps

### Backend
1. **Schema:** add `VehicleStatus`, the `Vehicle`/`Driver`/`Route`/`Stop`/`StudentTransport`/`VehicleLocation` models + `School` back-relations + `Student.studentTransports`; coordinate the `Student` edit (§8). `pnpm exec prisma migrate dev --name transport` then `pnpm prisma:generate`.
2. **Module scaffold:** add `src/modules/transport/{routes,controller,service,schema,types}.ts` following the module split (controllers thin; service `fastify`-first). Enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Services:** implement vehicle/driver/route/stop CRUD + `setRouteStops` (full-replace transaction). Implement `assignStudentTransport` / `unassignStudentTransport` — the fee link: call PRP-45 `createAdjustment(OPTIONAL_HEAD)` / `deactivateAdjustment` and persist `feeAdjustmentId`. Resolve fare `stop.fareAmount ?? route.fareAmount` as `Decimal`. Validate stop∈route + student enrolled (PRP-32).
4. **Parent/student read:** implement `getStudentTransport` with `resolveParentChildren` (PRP-41) ownership scoping + driver-phone masking.
5. **Transport `FeeHead` bootstrap:** ensure a school has (or lazily creates) an `isOptional` "Transport" `FeeHead` via PRP-44's service before creating the adjustment — do not duplicate the head per route.
6. **GPS seam (⚠︎ O-P8):** add the `transport.gpsEnabled` flag check + `notImplemented` stubs; build no ingestion.
7. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; ownership scoping in the parent/student read.
8. **Permissions:** add `transport.read`/`manage`/`assign` rows + matrix to `src/modules/authz/permissions.ts` (PRP-17) and re-run `pnpm seed:permissions`.
9. **Audit:** `writeAudit()` (PRP-18) on `transport.assign`/`unassign` and route/stop/vehicle/driver mutations.
10. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + `CreateVehicleBody`, `SetRouteStopsBody`, `AssignTransportBody`, `StudentTransportDto`.

### Frontend
1. **Store layer:** add `src/store/transport/{transport.store.ts,transport.services.ts,transport.type.ts}` — `transport.services.ts` calls `apiClient` against the §3.3 routes, normalized via `helper.*`; TanStack Query hooks for lists/details.
2. **Routes/menu:** add transport route strings to `APP_ROUTES` (`src/constants/routes.ts`) and the menu entry to `getMenuList` (`src/constants/project.menu.ts`) gated on the `transport.*` ability (PRP-11).
3. **Admin UI:** `src/modules/transport/` screens — Vehicles, Drivers, Routes (+ ordered Stops editor), Assignment (student search → route/stop → fare preview), route Manifest (`DataGrid`).
4. **Parent/student card:** a transport summary card slotted into the PRP-43 parent/student dashboard.
5. **Validation:** forms via the PRP-13 `react-hook-form`/`zod` stack; classes via `cn()`; no axios in components (go through the store services layer).

## 5. Files added / changed

### Backend
- **Add:** `src/modules/transport/transport.routes.ts`, `transport.controller.ts`, `transport.service.ts`, `transport.schema.ts`, `transport.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `transport.*`)

### Frontend
- **Add:** `src/modules/transport/*` (admin screens + parent/student card), `src/store/transport/transport.store.ts`, `transport.services.ts`, `transport.type.ts`
- **Edit:** `src/constants/routes.ts` (`APP_ROUTES` transport entries), `src/constants/project.menu.ts` (menu entry), the PRP-43 parent/student dashboard (slot the transport card)

## 6. Acceptance criteria
- [ ] `Vehicle`/`Driver`/`Route`/`Stop`/`StudentTransport`(+`VehicleLocation`) tables exist with the documented uniques + indexes; all carry `schoolId`; assignment is one-per-student-per-year; fares are `Decimal`.
- [ ] An admin can create vehicles/drivers/routes, order stops with per-stop fares, and assign a student to a route+stop.
- [ ] Assigning a student creates an `OPTIONAL_HEAD` transport `FeeAdjustment` (PRP-45) at the resolved fare, so `computeStudentDues` (PRP-46) bills transport with no new money code; un-assigning deactivates that adjustment (soft) and dues stop billing it.
- [ ] A PARENT/STUDENT can read **only** their own/children's transport (route/stop/time/vehicle/masked driver) via `resolveParentChildren` (PRP-41); an unlinked `studentId` is `403/404`.
- [ ] All routes are tenant-scoped (client `schoolId` ignored) + permission-guarded; mutations `403/402` on a non-writable school (PRP-15); assignment changes audited (PRP-18).
- [ ] ⚠︎ O-P8 assumptions recorded inline: GPS is a flag-gated schema seam returning `501` (no ingestion built); the transport fee uses the existing optional-head mechanism (no distance-slab pricing).
- [ ] **FE:** admin transport screens + a parent/student transport card exist; transport fee appears in the existing PRP-48 fee view; routes via `APP_ROUTES`, menu gated on `transport.*`.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; `pnpm exec prisma migrate dev --name transport` applies cleanly; `pnpm seed:permissions` adds `transport.*`.
- **Frontend:** `yarn type-check && yarn lint && yarn build` (and `yarn check`).
- Manual (against PRP-31/32/44/45/46 data): create a "Transport" optional head → create a route with 3 stops + fares → assign a student → `GET /students/:id/dues` (PRP-45) now includes transport; un-assign → it drops. Fetch the parent transport card as the linked parent (visible, masked driver phone) and as an unrelated parent (denied). Hit the GPS route → `501` (flag off).

## 8. Risks & rollback
- **Fee-link correctness (headline):** the route assignment ↔ `OPTIONAL_HEAD` adjustment must stay in sync — assign creates exactly one active adjustment, un-assign deactivates exactly that one (track via `feeAdjustmentId`). A **mid-year route-fare change / re-assign** must use **PRP-45's real verb: deactivate-then-create** (`deactivateAdjustment(oldId)` then `createAdjustment(...)` at the new fare) — PRP-45 deliberately exports **no `updateAdjustment`** (adjustments are immutable for an auditable billed-history; see PRP-45 §3.3), so do **not** assume an in-place update verb exists. A leak here over/under-bills transport. Reuse PRP-45's `createAdjustment`/`deactivateAdjustment` — **do not** write a second money path. Cover with a test (assign → dues up by fare → un-assign → dues back).
- **Decimal fares:** `fareAmount` is `Decimal`; never float (D1, PRP-44/45). Resolve `stop.fareAmount ?? route.fareAmount` and pass the string to PRP-45.
- **⚠︎ O-P8 GPS is a seam, not a feature:** `VehicleLocation` + `gpsDeviceId` + the lat/long columns exist only so the schema doesn't churn; building real-time tracking, a device protocol, or a map is a **separate** future PRP gated on O-P8. Keep the stub returning `501` and resist scope creep here.
- **Shared `Student` edit (§8):** adds `studentTransports` to a `Student` model also extended by PRP-31/32/44/45/46 — land in dependency order and rebase the relation block so it accretes without duplicate fields (PRP-29 §8 convention).
- **Driver ≠ employee:** `Driver` is a contact record; if a driver is also staff, link by the loose `staffProfileId` (no FK) — do **not** couple to PRP-30/67. Driver-phone masking is a policy default (stated assumption).
- **Parent-scope safety:** the "my bus" read must go through PRP-41's `resolveParentChildren` (the single guardian-edge gate) — never re-implement the `ParentStudent` join, so the link rule stays single-sourced.
- **Rollback:** additive module + tables (BE) and additive feature dir + store (FE); revert the module/feature, drop the six tables, remove `Student.studentTransports`. Inert until routes are registered.
