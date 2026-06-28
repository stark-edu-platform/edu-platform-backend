# PRP-34 — CSV/Excel bulk import (students & staff)

> **Status:** Proposed · **Phase:** 2 · **Severity:** 🟠 Med · **Size:** L
> **Addresses:** P2-BE-34 (implementation-plan §P2, master-prp §5.6/§6) · **Depends on:** PRP-31 (reuses `createStudent` per student row + the guardian model), PRP-30 (reuses `inviteMember` per staff row), PRP-29 (resolves grade/section/stream by name during import), PRP-32 (optional: seed enrollments during student import), PRP-28 (intake year), PRP-17 (`import.*` permissions) · **Feeds:** PRP-37 (bulk-import UI). **⚠︎ gated on O-P2** (import column spec)

## 1. Problem / current state
Onboarding a real school means loading **hundreds of students and dozens of staff at once** — typing them one by one (PRP-31 `createStudent` / PRP-30 `inviteMember`) is a non-starter for go-live. master-prp §5.6 lists **CSV/Excel bulk import (students/staff) from P2** as a cross-cutting service. Today there is no upload handling, no validation pipeline, and no error-reporting mechanism. This PRP adds a **validated import pipeline** that parses an uploaded file, validates each row, and creates records by **reusing the existing single-record service paths** (so business rules + audit + uniqueness checks are identical to the manual flows — no parallel creation logic).

### 1.1 ⚠︎ Open question (O-P2 — import column spec)
master-prp §10 leaves the **CSV import column spec** open; this PRP is **⚠︎-flagged** in the implementation plan. **Assumption (inline, flagged):** v1 defines a **canonical column set per entity** (documented below) and ships a **downloadable template** matching it; columns map 1:1 to the `createStudent`/`inviteMember` inputs, with grade/section/stream/department resolved **by name** within the school. **Header-based mapping** (column order-independent, case-insensitive) is supported; arbitrary custom-column mapping UI is **out** until O-P2 resolves. Excel (`.xlsx`) and CSV are both accepted (one parsing layer). Any reviewer needing a configurable column-mapping UI or extra columns must **resolve O-P2 first**; the canonical set + `formData`-style passthrough is the v1 contract.

## 2. Goal & non-goals
- **Goal:** a `src/modules/import/` module with: a file-upload endpoint (CSV/`.xlsx`), a **two-phase** import (validate → commit) that returns a per-row **error report**, reuse of PRP-31 `createStudent` / PRP-30 `inviteMember` per row (inside per-row or chunked transactions), name-resolution of grade/section/stream/department, and an `ImportBatch`/`ImportRow` record so a run is auditable and its report retrievable.
- **Non-goals:** importing anything other than **students** and **staff** (admissions/applications import is out — PRP-33; fees/marks import are later phases), a configurable column-mapping UI (⚠︎ O-P2), updates/upserts of existing records (v1 is **insert-only**; duplicates are reported as row errors, not merged), the FE upload screen (PRP-37). The creation logic itself is owned by PRP-30/PRP-31 — this PRP **orchestrates**, it does not re-implement row creation.

## 3. Target design
### 3.1 Schema (`prisma/schema.prisma`)
```prisma
enum ImportKind   { STUDENT STAFF }
enum ImportStatus { PENDING VALIDATED PARTIALLY_COMMITTED COMMITTED FAILED }

model ImportBatch {
  importBatchId String       @id @default(uuid())
  schoolId      String
  kind          ImportKind
  status        ImportStatus @default(PENDING)
  fileName      String?
  fileKey       String?                              // original upload archived to S3 (master-prp §5.6)
  totalRows     Int          @default(0)
  validRows     Int          @default(0)
  errorRows     Int          @default(0)
  committedRows Int          @default(0)
  uploadedByUserId String?                            // loose ref (no FK), audit-friendly
  rows          ImportRow[]
  school        School       @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  @@index([schoolId])
  @@index([schoolId, kind])
}

model ImportRow {
  importRowId   String   @id @default(uuid())
  importBatchId String
  rowNumber     Int                                   // 1-based source row (for the error report)
  rawData       Json                                  // the parsed source row
  errors        Json     @default("[]")               // [{ field, message }] — validation failures
  committed     Boolean  @default(false)
  createdEntityId String?                             // studentId / userSchoolId on success
  batch         ImportBatch @relation(fields: [importBatchId], references: [importBatchId], onDelete: Cascade)

  @@index([importBatchId])
  @@index([importBatchId, committed])
}
```
Add `importBatches` back-relation to `School`.

> **Decision — two-phase, reuse single-record paths, insert-only:** importing happens in two steps so a school never half-imports a bad file blind:
> 1. **Validate** (`POST …/imports` with the file) — parse, normalize headers, validate every row (required fields, email/phone format via `auth.utils.js`, name-resolution of grade/section/stream/department, **dry-run** uniqueness checks for `admissionNo`/`email`/`employeeCode`), persist an `ImportBatch` (`VALIDATED`) + one `ImportRow` per source row with any `errors`. **No records are created yet.**
> 2. **Commit** (`POST …/imports/:id/commit`) — for each `ImportRow` with no errors, call the **existing** `createStudent` (PRP-31) or `inviteMember` (PRP-30) — *the same path the manual UI uses* — so uniqueness, audit, and the invite/email behaviour are identical. Rows are committed in **chunks**, each chunk in a `$transaction`; a row that fails at commit (e.g. a race) is marked with its error, not silently dropped → `PARTIALLY_COMMITTED` if any fail, else `COMMITTED`.
>
> Insert-only: a duplicate `admissionNo`/`email`/`employeeCode` is an **error row** in the report, never an update. This keeps the importer free of merge semantics (deferred).

### 3.2 Canonical columns (⚠︎ O-P2 assumption)
Header-mapped, case-insensitive; resolved by name within the school.
- **Student** (`kind: STUDENT`): `admissionNo`*, `firstName`*, `lastName`, `dateOfBirth`, `gender`, `gradeName`* , `sectionName`, `streamName`, `guardianName`, `guardianEmail`, `guardianPhone`, `guardianRelation`, `category`, `isRteQuota`. (`*` = required.) If `sectionName` is present, the importer also calls PRP-32 `enrollStudent` in the same row transaction (intake year via `resolveCurrentAcademicYear`, PRP-28) so a freshly-imported student is placed + roster-seeded.
- **Staff** (`kind: STAFF`): `name`*, `email`*, `role`* (`STAFF`|`TEACHER`), `phone`, `employeeCode`, `departmentName`, `designation`, `qualification`, `dateOfJoining`, `employmentType`.

### 3.3 Module layout (`src/modules/import/`)
- `import.routes.ts` / `import.controller.ts` / `import.service.ts` / `import.schema.ts` / `import.types.ts`.
- `import.service.ts` imports `createStudent` (PRP-31), `inviteMember` (PRP-30), `enrollStudent` (PRP-32), grade/section/stream/department resolvers (PRP-29/PRP-30), `resolveCurrentAcademicYear` (PRP-28), and `auth.utils.js` validators (`isEmail`, `normalizeEmail`).
- **Parsing dependency:** a single parsing layer over CSV + `.xlsx`. Add a well-maintained parser (e.g. `papaparse` for CSV + `exceljs`/`xlsx` for spreadsheets) to `package.json` (pnpm). Multipart upload via `@fastify/multipart` (add the plugin if not present); cap file size + row count in config.

### 3.4 Services & routes
`import.service.ts` exports (`fastify`-first, tenant-scoped):
- `validateImport(fastify, schoolId, kind, fileBuffer, fileName)` — parse + header-map + per-row validate (incl. name-resolution + dry-run uniqueness), persist `ImportBatch` (`VALIDATED`) + `ImportRow`s, return `{ importBatchId, totalRows, validRows, errorRows }`.
- `getImportReport(fastify, schoolId, importBatchId)` — the batch + rows (errors included) for download/UI; tenant-scoped.
- `commitImport(fastify, schoolId, importBatchId)` — chunked commit calling PRP-30/PRP-31 (and optionally PRP-32) per valid row; updates counts + status; idempotent (already-committed rows are skipped). Audited once per batch (`action: 'import.commit'`, kind + counts in metadata).
- `downloadTemplate(kind)` — returns the canonical-column template (CSV) for the UI.

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations `requireWritableSchool` PRP-15):
- `POST /api/school/imports?kind=STUDENT|STAFF` (`import.create`) — multipart upload → validate phase.
- `GET /api/school/imports/:importBatchId` (`import.read`) — the report.
- `POST /api/school/imports/:importBatchId/commit` (`import.create`) — commit phase.
- `GET /api/school/imports/template?kind=STUDENT|STAFF` (`import.read`) — download template.

### 3.5 Permission strings (extends PRP-17 §3.4)
| Resource | Actions (P2) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `import` | `read`, `create` | read+create | read+create | – | – | – |

(Import implicitly creates students/staff, so a holder of `import.create` must also hold the underlying `student.create`/`staff.invite` — enforce that the committer's abilities include the target create permission, not just `import.create`.)

## 4. Implementation steps
1. **Schema:** add `ImportKind`/`ImportStatus`, `ImportBatch`, `ImportRow` + `School` back-relation. `pnpm exec prisma migrate dev --name bulk_import` then `pnpm prisma:generate`.
2. **Deps:** add the CSV/xlsx parser(s) + `@fastify/multipart` to `package.json` (pnpm); register multipart in `src/app.ts`/plugins with size + row caps in `src/config/shared-env.ts` (`IMPORT_MAX_ROWS`, `IMPORT_MAX_FILE_BYTES`).
3. **Module:** add `src/modules/import/{routes,controller,service,schema,types}.ts`; import the PRP-28/29/30/31/32 helpers in §3.3.
4. **Validate phase:** implement parsing + header-mapping + per-row validation + dry-run uniqueness; persist `ImportBatch`/`ImportRow`.
5. **Commit phase:** implement the chunked, transactional commit that **reuses** `createStudent`/`inviteMember` (+ optional `enrollStudent`); mark per-row outcome; set batch status/counts; idempotent.
6. **Permission coupling:** in `commitImport`, assert the actor's resolved abilities (PRP-17) include `student.create`/`staff.invite` for the kind — not just `import.create`.
7. **Audit:** `writeAudit()` (PRP-18) once per `commitImport` (kind + counts). (Per-row `createStudent`/`inviteMember` already audit individually via their own PRPs.)
8. **Template + schemas/types:** `downloadTemplate`, Fastify schemas, types; enums from `src/generated/prisma/enums.js`.

## 5. Files added / changed
- **Add:** `src/modules/import/import.routes.ts`, `import.controller.ts`, `import.service.ts`, `import.schema.ts`, `import.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/app.ts` or a plugin (register `@fastify/multipart`), `src/config/shared-env.ts` (import caps), `package.json` (parser + multipart deps), `src/modules/authz/permissions.ts` (PRP-17 — add `import.*`)

## 6. Acceptance criteria
- [ ] `ImportBatch` + `ImportRow` tables exist; an import run is recorded with per-row `errors` retrievable as a report.
- [ ] Uploading a student/staff CSV **or** `.xlsx` validates every row, persists a `VALIDATED` batch, and creates **no** records in the validate phase.
- [ ] The error report flags each bad row with `{ field, message }` (missing required field, bad email, unresolvable grade/section, duplicate `admissionNo`/`email`/`employeeCode`).
- [ ] Commit reuses `createStudent` (PRP-31) / `inviteMember` (PRP-30) — identical uniqueness/audit/invite behaviour to the manual path — and (with `sectionName`) enrolls + roster-seeds via PRP-32.
- [ ] A row that fails at commit is reported (not silently dropped); the batch ends `COMMITTED` or `PARTIALLY_COMMITTED`; re-commit is idempotent.
- [ ] Import is insert-only (duplicates are errors, never updates).
- [ ] `import.create` holders are additionally checked for the underlying `student.create`/`staff.invite`.
- [ ] The ⚠︎ O-P2 column-spec assumption + canonical columns are documented; a template is downloadable.
- [ ] Each commit run is audited (PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name bulk_import` applies; `pnpm seed:permissions` adds `import.*`.
- Manual: download the student template; upload a file with one valid + one duplicate + one missing-field row → report shows 1 valid, 2 errors; commit → 1 student created (+ enrolled if `sectionName` given), 0 from the error rows; re-commit → no duplicates. Repeat for staff (invite emails sent for valid rows).

## 8. Risks & rollback
- **⚠︎ O-P2 (column spec):** the canonical columns (§3.2) are an explicit assumption — a configurable mapping UI is deferred. Don't build arbitrary column mapping until O-P2 resolves; the documented template + header-mapping is the v1 contract.
- **Reuse over re-implement (load-bearing):** the commit phase **must** go through PRP-31 `createStudent` / PRP-30 `inviteMember`, never a bespoke `prisma.student.create`. Re-implementing creation would fork uniqueness/audit/invite rules and is the top correctness risk — review for any direct Prisma writes in the importer.
- **Large-file resource use:** cap file size + row count (`IMPORT_MAX_ROWS`/`IMPORT_MAX_FILE_BYTES`); commit in chunked transactions so a 1,000-row import doesn't run as one giant transaction or exhaust the `pg.Pool`. Consider backgrounding very large imports later (note as follow-up).
- **Partial commits:** make commit idempotent (skip `committed` rows) so a retried commit after a chunk failure doesn't double-create. The `ImportRow.committed` flag + `@@index([importBatchId, committed])` support this.
- **Mass-invite email volume:** a staff import fires N setup-password invites (Brevo) — throttle/batch the sends and respect any provider rate limit; don't block the commit transaction on email (send after the row commits, like the manual flows).
- **Multipart upload surface:** enforce size/type limits at `@fastify/multipart`; only accept CSV/`.xlsx`; reject anything else before parsing.
- Rollback: additive module + tables + deps; revert the module, drop the two tables, remove the parser/multipart deps + config keys. Records created by a prior commit live in PRP-30/PRP-31 tables and remain valid.
