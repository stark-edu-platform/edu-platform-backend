# PRP-72 — Advanced analytics & cross-module reporting (dashboards · exports) ⚠︎

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟡 Low · **Size:** L (capstone — breadth ⚠︎)
> **Depends on (many — this is the cross-module capstone):** PRP-12 (school context / tenant scoping — every metric is school-scoped), PRP-17 (`reports.*` permissions), PRP-18 (`AuditLog` is itself a reportable source + report exports are audited), PRP-15 (subscription state — analytics is a *read* surface, available even READ_ONLY), PRP-46 (the `src/lib/storage` + `src/modules/pdf` infra — **reuse** for PDF/CSV exports), PRP-71 (branding — exports + dashboards skin with the school logo/colors); **data sources (read-only):** PRP-32 (enrollment/strength), PRP-38/40 (attendance), PRP-44/45/46 (fees/dues/collections), PRP-49/50/51 (exams/results), PRP-31 (students/guardians), PRP-30 (staff), PRP-69 (health — vaccination compliance), PRP-70 (inventory — stock/asset value); **platform tier:** PRP-20 (SuperAdmin console — the cross-school platform dashboard) · **Feeds:** the SuperAdmin (PRP-22) + per-role landing pages (PRP-25) which embed dashboard widgets

## 1. Problem / current state
Each module ships its own narrow report (PRP-40 attendance reports, PRP-46 defaulter reports, PRP-51 merit lists), but there is **no cross-module analytics layer** and **no general reporting/export surface**. There is no school-overview dashboard ("strength, today's attendance %, fees collected this month, upcoming exams"), no per-role dashboard composition, no cross-cutting query (e.g. "attendance vs. results correlation", "fee collection by grade"), and no SuperAdmin **cross-school** operational view beyond the schools list (PRP-20/22). master §6/§10 lists "advanced analytics & reporting — cross-module dashboards & exports" as a P8 deliverable, **⚠︎ flagged O-P8** and **depends on many modules** (it can only be as rich as the phases that have shipped).

This PRP defines the **reporting approach** (a read-only aggregation layer + a generic export mechanism + composable dashboards per role) rather than enumerating every metric — the metric catalog grows as upstream modules land. It is deliberately **additive and read-only**: it owns **no new domain tables**, only reads existing ones (optionally a small materialized-snapshot table for expensive cross-school rollups).

> ⚠︎ **O-P8 (analytics breadth + which modules exist):** master §10 leaves module priority open, and analytics depends on **what has shipped**. **Assumptions (inline, flagged ⚠︎):**
> - **Read-only, derived layer — no new source-of-truth tables.** Analytics queries the existing module tables through their **services/repositories**, not by reaching into other modules' Prisma models directly (keeps tenant scoping + business rules in one place). The only optional new table is a `ReportSnapshot` cache for expensive aggregates (esp. the SuperAdmin cross-school rollup), regenerated on a schedule — not a parallel data model.
> - **Graceful degradation by available module.** A dashboard widget renders only if its source module has shipped (capability-gated). The PRP describes the **full** target set; the implementation lights up widgets as PRP-32/38/46/51/etc. exist. Each widget declares its source dependency.
> - **No external BI / data-warehouse / streaming** in v1 — aggregation is in-DB (SQL `GROUP BY` / Prisma `groupBy`/`aggregate`) over the operational Postgres, with the snapshot cache for the heavy cross-school view. A warehouse/BI export is an explicit future seam.
> - **Exports = the existing PDF (PRP-46 `src/modules/pdf`) + a new CSV path**, reusing `src/lib/storage`. No custom report **builder** (drag-drop/ad-hoc query designer) in v1 — a fixed (but parameterized) set of reports. An ad-hoc builder is a future seam.
> Resolving O-P8 sets the metric catalog + which dashboards are prioritized; the architecture below does not change.

## 2. Goal & non-goals
- **Goal — Backend:** a `src/modules/reports/` (analytics) module exposing (a) **per-role dashboard summary endpoints** that aggregate across whichever modules have shipped (school-overview for Admin, teacher dashboard, parent multi-child summary via PRP-41, SuperAdmin cross-school via PRP-20); (b) a small set of **parameterized cross-module reports** (e.g. enrollment, attendance, fee-collection, results — each by grade/section/term/date-range); (c) a **generic export mechanism** (any report → CSV or branded PDF, reusing PRP-46's `pdf`/`storage`, skinned via PRP-71); (d) an optional `ReportSnapshot` cache for expensive rollups. All read-only, tenant-scoped, permission-gated, with export actions audited.
- **Goal — Frontend:** a **dashboards layer** — role-aware dashboard pages composed of **capability-gated widget cards** (each widget hidden if its source module isn't present or the user lacks the permission), a **Reports** screen with a parameter form + table preview + **Export (CSV/PDF)** action, and the **SuperAdmin cross-school analytics** view. All via a new `src/store/reports/` slice; dashboards feed the PRP-25 landing pages and the PRP-22 SuperAdmin console.
- **Non-goals:** any new operational/source data (this module **only reads**); the module-specific narrow reports already owned upstream (PRP-40 attendance, PRP-46 defaulters, PRP-51 merit — analytics *links to / re-aggregates* them, doesn't replace them); an external BI tool / data warehouse / event streaming (⚠︎ future seam); an ad-hoc report **builder** (⚠︎ future seam — v1 is fixed parameterized reports); real-time/live-updating dashboards (v1 is on-load + snapshot-cached, not websockets); predictive/ML analytics (out of scope). The PDF/CSV *engine* is PRP-46's (reused, not rebuilt) and branding is PRP-71's (consumed).

## 3. Target design

### 3.1 Backend

#### 3.1.1 Reporting architecture (the core of this PRP)
A layered, read-only design — **no new domain model**, only derived reads:
1. **Source adapters (no direct cross-module Prisma):** analytics reads each domain through that module's **service/repository** (e.g. attendance summaries via the PRP-40 service, dues via PRP-46's `getStudentLedger`/defaulter helpers, results via PRP-51, strength via PRP-32) — so tenant scoping + business rules stay in the owning module. Where a thin read isn't exposed, add a **read-only aggregate query** to the owning module's service (not a new table). This is the load-bearing rule: **analytics never bypasses a module's scoping by querying its tables directly.**
2. **Aggregation services (`reports.service.ts`):** compose adapter reads into dashboard summaries + report rows using Prisma `groupBy`/`aggregate` / SQL `GROUP BY` over the operational DB, all filtered by `request.schoolContext.schoolId` (and `academicYearId`/term/grade/section params).
3. **Capability gating:** a `getAvailableReportSources(fastify, schoolId)` returns which modules/widgets are live (by feature presence) so the FE renders only shippable widgets — the **graceful-degradation** mechanism (⚠︎ O-P8).
4. **Export pipeline:** a generic `exportReport(fastify, schoolId, reportKey, params, format)` → builds the report rows once, then renders **CSV** (a new lightweight serializer) or **PDF** (reuse `src/modules/pdf`, PRP-46) skinned with PRP-71 branding, stored via `src/lib/storage` (PRP-46), returned as a signed URL. Audited.
5. **Optional snapshot cache (`ReportSnapshot`):** for expensive aggregates — chiefly the **SuperAdmin cross-school** rollup (strength/collections/active-schools across all tenants) — a small cached-aggregate table regenerated on a schedule (the PRP-05 job pattern / a cron), read cheaply by the dashboard. The only optional new table; everything else is computed on demand.

##### 3.1.2 Optional schema (`prisma/schema.prisma`) — only if the snapshot cache is built
```prisma
model ReportSnapshot {                                // OPTIONAL — cache for expensive (esp. cross-school) aggregates
  reportSnapshotId String   @id @default(uuid())
  schoolId         String?                            // null = a platform-wide (cross-school) snapshot for SuperAdmin
  key              String                             // "school_overview", "platform_rollup", …
  periodLabel      String?                            // "2026-06" / academic-year label the snapshot covers
  payload          Json                               // the precomputed aggregate (read-only render)
  generatedAt      DateTime @default(now())
  @@index([schoolId, key])
  @@index([key, generatedAt])
}
```
No `Student`/`School` structural edits (read-only module) — at most a `School` back-relation if `ReportSnapshot.schoolId` is made an FK (optional; a loose index avoids even that). So this PRP is **outside** the shared-`Student`-edit coordination (§8).

> **Decision — derived layer, services-not-tables, fixed-but-parameterized (⚠︎ O-P8):** analytics is a **projection** over the operational data, read through module services to preserve scoping/rules; the only persistent addition is an optional aggregate cache. Reports are a **fixed catalog with parameters** (grade/section/term/range), not an ad-hoc query builder — this keeps the surface safe (no arbitrary user SQL, no tenant-leak risk) and shippable, while covering the real K-12 reporting needs (D1). Breadth scales with shipped modules via capability gating.

#### 3.1.3 Dashboards & reports per role (the target set — capability-gated)
**Admin — school-overview dashboard** (`GET /api/school/dashboard`): current **strength** (enrolled by grade/section, PRP-32), **today's attendance %** + 7-day trend (PRP-38/40), **fees** collected this month + outstanding/defaulter count (PRP-46), **upcoming exams** + last-term result distribution (PRP-49/51), plus low-stock (PRP-70) and vaccination-compliance (PRP-69) tiles where present. Each tile is a widget with a declared source.

**Teacher — dashboard** (`GET /api/school/dashboard` role-shaped, or `/teacher/dashboard`): my assigned sections (PRP-30), today's classes + attendance-to-mark (PRP-38), marks-entry pending (PRP-50), recent low-attendance students in my sections (PRP-40).

**Parent — multi-child summary** (via **PRP-41**'s aggregation): per child — attendance %, fees due, latest result, recent notices; this PRP supplies the analytics block, PRP-41 owns the parent route + own-children scoping.

**SuperAdmin — cross-school platform analytics** (via **PRP-20**, developer-guarded): active/trialing/locked school counts (PRP-15/16), total students across tenants, platform-wide collections trend, signups/activations funnel, audit-activity summary (PRP-18). This is the rollup the `ReportSnapshot` cache backs (querying every tenant live is the expensive case).

**Parameterized cross-module reports** (the export catalog, each with grade/section/term/date-range params): enrollment/strength register, attendance summary (re-aggregating PRP-40), fee-collection & outstanding (PRP-46), result/performance analysis (PRP-51), and a few cross-cuts (e.g. attendance-vs-result, collection-by-grade). Each report is a `{ key, paramsSchema, run(params) → rows }` entry in a **report registry** (mirroring PRP-46's `pdf` template registry / the email-template registry pattern).

#### 3.1.4 Services & routes
`reports.service.ts` exports: `getAdminDashboard(fastify, schoolId, { academicYearId })`, `getTeacherDashboard(...)`, `getPlatformDashboard(fastify)` (SuperAdmin, snapshot-backed), `getAvailableReportSources(...)`, `runReport(fastify, schoolId, reportKey, params)` (returns rows + columns for the table preview), and `exportReport(fastify, schoolId, reportKey, params, format)` (CSV/PDF via PRP-46 infra + PRP-71 branding → signed URL).

Routes (all **read**; tenant-scoped; gated by `requirePermission('reports.read')` — dashboards may use a lighter `dashboard.read`):
- `GET /api/school/dashboard?academicYearId=` (`dashboard.read`) — role-shaped summary
- `GET /api/school/reports/available` (`reports.read`) — capability list
- `GET /api/school/reports/:reportKey?…params` (`reports.read`) — run + preview rows
- `POST /api/school/reports/:reportKey/export` (`reports.export`, body `{ params, format: 'csv'|'pdf' }`) — returns a signed URL; **audited**
- Parent block: supplied to **PRP-41**'s `/api/parent/dashboard` (own-children scoping owned there)
- Platform: `GET /api/developer/analytics` (`platform.read`/developer guard) — cross-school rollup (PRP-20)

Reads are available even when the school is `READ_ONLY` (analytics is a read surface; only `exportReport` — a write of a file — uses `requireWritableSchool` if review wants exports gated; default: allow exports in READ_ONLY since they're reports, not data mutations — note the choice). All responses use `successResponse`/`errorResponse`; `Decimal`s as strings.

#### 3.1.5 Permission strings (extends PRP-17)
| Resource | Actions | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|---------|:-----:|:-----:|:-------:|:-------:|:------:|
| `dashboard` | `read` | read | read | read | read (self) | read (children) |
| `reports` | `read`, `export` | read, export | read, export | read (own scope) | – | – |

`reports.read`/`export` is staff-facing; **per-role/per-scope filtering happens in the service** (a teacher's reports are limited to assigned sections; a parent uses the PRP-41 children block, not `reports.*`). The SuperAdmin platform analytics uses the developer guard + a `platform.read`, not the school matrix. Cross-school data is **never** exposed through a school-scoped route.

#### 3.1.6 Audit (PRP-18)
`writeAudit()` on `exportReport` (who exported what report with which params — a data-egress event worth tracking, esp. for student PII reports). Dashboard/preview reads are **not** audited (too high-volume, no egress artifact). Export metadata: `{ reportKey, format, params }` (identifiers only — no row data).

### 3.2 Frontend
House conventions (PRP-43/47): UI in `src/modules/<feature>/` (dashboards + reports), state/API in `src/store/reports/` (`*.store.ts`/`*.services.ts`/`*.type.ts`), TanStack Query (PRP-09), routes from **`APP_ROUTES`**, `helper.*`, `cn()`, guards via `<Can>` (PRP-11) + `deriveAbilities` (PRP-10); reuse `DataGrid` for report tables and a charting approach consistent with the existing UI primitives.

- **Routes (`src/constants/routes.ts`):** dashboards live on the **existing per-role landing routes** (PRP-25) — this PRP supplies widgets, not new dashboard routes. Add `APP_ROUTES.school.reports` → `/reports` and the SuperAdmin `APP_ROUTES.developer.analytics` → `/developer/analytics`.
- **State & services (`src/store/reports/`):** `reports.type.ts` mirrors the dashboard-summary + report-row/column + available-sources shapes verbatim. `reports.services.ts` via `apiClient` + `helper.*`: `fetchDashboard(params)`, `fetchAvailableReports()`, `runReport(key, params)`, `exportReport(key, params, format)` (→ downloads/opens the signed URL), `fetchPlatformAnalytics()` (SuperAdmin).
- **UI modules:**
  - `src/modules/dashboard/` — a **widget framework**: a `DashboardGrid` that takes a list of widget descriptors and renders each as a card (`StrengthWidget`, `AttendanceWidget`, `FeesWidget`, `ResultsWidget`, `LowStockWidget`, `VaccinationWidget`, …). Each widget is **capability-gated** — it renders only if `fetchAvailableReports()` says its source is live **and** `<Can>` (PRP-11) passes. Composed into the PRP-25 role landing pages (Admin/Teacher), so the landing page is the dashboard.
  - `src/modules/reports/ReportsScreen.tsx` (page `(school)/reports/page.tsx`) — a report picker (the available catalog) → a parameter form (grade/section/term/date-range) → a `DataGrid` preview → an **Export** control (CSV / PDF) calling `exportReport`. `<Can reports.export>` gates Export.
  - `src/modules/developer/analytics/PlatformAnalytics.tsx` (page `developer/analytics/page.tsx`) — the SuperAdmin cross-school rollup cards + trends; DEVELOPER-guarded (PRP-22 layout guard).
- **Charts:** keep them dependency-light and consistent with the existing UI; if a chart lib is introduced it is a single shared choice (note it), reused across widgets — do not scatter ad-hoc charting.
- **Menu + guards (`src/constants/project.menu.ts`, PRP-11/25):** add a **Reports** entry (staff/admin, `reports.read`) and the SuperAdmin **Analytics** entry (`platform.read`); visibility from `deriveAbilities` (PRP-10). Dashboards need no menu entry (they're the landing pages).

## 4. Implementation steps
1. **Backend — module:** add `src/modules/reports/{routes,controller,service,schema,types}.ts` + a `reports.registry.ts` (the report catalog, mirroring PRP-46's `pdf` registry). Implement the aggregation services reading through module services (§3.1.1), `getAvailableReportSources`, `runReport`, and `exportReport`.
2. **Backend — exports:** add a CSV serializer; reuse `src/modules/pdf` (PRP-46) for PDF + `src/lib/storage` for the file + PRP-71 `getBrandingForArtifacts` to skin it.
3. **Backend — optional snapshot:** if the cross-school rollup is built now, add `ReportSnapshot` (+ migration) and a scheduled regenerator (PRP-05 job pattern); otherwise compute the platform rollup live behind a clear "may be slow at scale" note and reserve the table.
4. **Backend — routing + guards:** register the school dashboard/reports routes under `src/plugins/school.plugin.ts` (`dashboard.read`/`reports.read`/`reports.export`); the platform analytics under the developer plugin; supply the parent block to PRP-41's route.
5. **Backend — permissions + audit:** add `dashboard.*` + `reports.*` (+ a `platform.read` for the developer view) to PRP-17 + default role map; `writeAudit()` on `exportReport` only.
6. **Backend — schemas/types:** Fastify JSON schemas + types; per-role service filtering (teacher→assigned sections, parent→PRP-41); `Decimal`s as strings.
7. **Frontend — routes/types/services:** add `reports` + `developer.analytics` to `APP_ROUTES`; add `src/store/reports/{reports.type,reports.services}.ts`.
8. **Frontend — widget framework:** add `src/modules/dashboard/DashboardGrid` + the capability-gated widget cards; compose into the PRP-25 Admin/Teacher landing pages.
9. **Frontend — reports + platform:** add `ReportsScreen` (picker → params → `DataGrid` → Export) and `PlatformAnalytics` (DEVELOPER-guarded); wire Export to the signed-URL download.
10. **Frontend — menu/guards:** add the Reports + Analytics entries to `project.menu.ts` (via `APP_ROUTES`, PRP-11); `<Can>`-gate every widget/report/export.

## 5. Files added / changed
- **Backend — add:** `src/modules/reports/reports.routes.ts`, `reports.controller.ts`, `reports.service.ts`, `reports.registry.ts`, `reports.schema.ts`, `reports.types.ts`; a CSV serializer (e.g. `src/lib/csv.ts`); optionally a `ReportSnapshot` regenerator job
- **Backend — edit:** `prisma/schema.prisma` (+ migration — **only** if `ReportSnapshot` is built), `src/plugins/school.plugin.ts` (dashboard/reports routes), the developer plugin/module (platform analytics), PRP-41's parent route (analytics block), `src/modules/authz/permissions.ts` (PRP-17 — add `dashboard.*`/`reports.*`/`platform.read`), and read-only aggregate queries added to the source module services (PRP-32/38/40/46/51/etc.) where a thin read isn't already exposed
- **Frontend — add:** `src/store/reports/reports.type.ts`, `src/store/reports/reports.services.ts`, `src/modules/dashboard/` (`DashboardGrid` + widget cards), `src/modules/reports/ReportsScreen.tsx`, `src/modules/developer/analytics/PlatformAnalytics.tsx`, pages `src/app/(school)/reports/page.tsx`, `src/app/developer/analytics/page.tsx`, optional `src/store/reports/reports.queries.ts`
- **Frontend — edit:** `src/constants/routes.ts` (reports + analytics routes), `src/constants/project.menu.ts` (Reports + Analytics entries), the PRP-25 Admin/Teacher landing pages (mount `DashboardGrid`)

## 6. Acceptance criteria
- [ ] No new **source-of-truth** tables: analytics reads existing data through module **services** (not by querying other modules' Prisma models directly); the only optional addition is `ReportSnapshot` (cache).
- [ ] The Admin school-overview dashboard returns strength + today's attendance + fees + upcoming-exams tiles, each **capability-gated** (a tile is absent if its source module hasn't shipped) and permission-gated (`<Can>`).
- [ ] Teacher dashboard is scoped to the teacher's assigned sections; the parent multi-child summary is delivered via PRP-41 (own-children scoping); the SuperAdmin cross-school analytics is developer-guarded and never exposed on a school-scoped route.
- [ ] A parameterized report (e.g. fee-collection by grade/term) runs and previews in a `DataGrid`, and **Export** produces a **CSV** and a **branded PDF** (reusing PRP-46's `pdf`/`storage` + PRP-71 branding) as a downloadable signed URL.
- [ ] `exportReport` is **audited** (PRP-18) with `{ reportKey, format, params }` metadata (no row data); high-volume dashboard reads are not audited.
- [ ] All report/dashboard reads are tenant-scoped and permission-gated; per-role scope filtering happens server-side; cross-school data is SuperAdmin-only.
- [ ] FE: dashboards/reports flow through `store/reports/*.services.ts` + TanStack Query (no direct axios); routes from `APP_ROUTES`; widgets render only when capability + permission allow; any chart lib is a single shared choice.
- [ ] The ⚠︎ O-P8 assumptions (read-only derived layer, graceful degradation by module, no external BI/builder, exports reuse PRP-46) are recorded.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; if `ReportSnapshot` is added, `pnpm exec prisma migrate dev --name report_snapshot` applies cleanly (otherwise no migration).
- **Frontend:** `yarn type-check && yarn lint && yarn build`.
- **Manual (against a backend with at least PRP-32/38/46 shipped):** open the Admin dashboard → strength + attendance + fees tiles render, tiles for unshipped modules are absent; run a fee-collection report for a grade/term → preview rows, then Export CSV and PDF → both download (PDF shows the school logo via PRP-71); as a teacher, confirm the dashboard is limited to assigned sections; as SuperAdmin, open `/developer/analytics` and see cross-school counts; confirm an export writes an audit row.

## 8. Risks & rollback
- **Tenant-isolation in aggregation (paramount):** every query must be `schoolId`-scoped (PRP-12) and go through module services so scoping/business rules aren't duplicated or bypassed — a cross-module `GROUP BY` that forgets the tenant filter is a **data-leak** risk. The SuperAdmin cross-school view is the *only* place that reads across tenants, and it lives behind the developer guard on a developer route — never on a school route. This is the central review checkpoint.
- **Breadth depends on shipped modules (⚠︎ O-P8):** analytics is only as rich as P2–P8's landed modules — capability gating (`getAvailableReportSources`) keeps it from referencing modules that don't exist yet; describe the full target, light up widgets incrementally. Resolving O-P8 sets the metric catalog/priority without changing the architecture.
- **Performance:** cross-module aggregates over operational Postgres can get heavy (esp. the platform rollup across all tenants) — use indexed `groupBy`/`aggregate`, the `ReportSnapshot` cache for the expensive cross-school case (regenerated on a schedule, not per request), and avoid N+1 by aggregating in SQL. A warehouse/BI export is the future seam if scale demands it.
- **Reuse, don't rebuild (load-bearing):** exports reuse PRP-46's `src/modules/pdf` + `src/lib/storage` and PRP-71's branding accessor; a second PDF/storage/branding path is the anti-pattern to reject. The narrow module reports (PRP-40/46/51) are linked/re-aggregated, not replaced.
- **PII egress:** report exports can contain student PII (attendance/results/fees by name) — `exportReport` is audited as a data-egress event, gated by `reports.export`, and scoped per role; document the data-residency constraint (master §8) for stored export files.
- **No ad-hoc builder in v1 (⚠︎ O-P8):** the report catalog is fixed-but-parameterized (no user-authored SQL/queries) — this is the safety boundary; an ad-hoc builder is a deferred seam.
- **Read-only / outside shared-`Student` coordination (§8):** this module adds no structural `Student`/`School` edits (at most the optional `ReportSnapshot` cache), so it does not participate in the shared-`Student`-edit migration sequencing.
- **Far-future / low severity:** the capstone of P8 — gated behind O-P8 and the prerequisite modules; ships last with no impact on earlier phases.
- **Rollback:** additive read-only module on both repos (+ optional `ReportSnapshot`); revert the modules, drop `ReportSnapshot` if added, remove the read-only aggregate queries added to source services. Dashboards/reports are inert if reverted (landing pages fall back to their non-dashboard state; the catch-all reclaims `/reports`).
