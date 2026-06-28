# PRP-65 — Library (book catalog, copies, issue / return, fines)

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟢 Low · **Size:** M
> **Depends on:** PRP-31 (`Student` + guardian linkage — a book is issued to a student/member; the parent can see their child's borrowings), PRP-30 (`StaffProfile`/`TeacherProfile` — staff/teachers are also library members; loose ref via `UserSchool`), PRP-28 (academic-year scoping for issue history/reporting), PRP-17 (RBAC — new `library.*` strings), PRP-12 (school context / tenant scoping), PRP-15 (`requireWritableSchool` on writes), PRP-18 (`writeAudit` on issue/return/fine — lightweight, D22) · **Feeds:** the FE library screens (this combined PRP, §3-FE/§4-FE) · **Gated on O-P8** (Extended-module priority — master §10)

## 1. Problem / current state
The platform has no **library** model: nothing catalogs the school's **books**, tracks **physical copies**, records **who has borrowed what**, or computes an **overdue fine**. Master §5.7 lists Library (`Book`/`BookIssue`) as a P8 entity; the implementation-plan row (PRP-65, scope "Catalog, issue/return, fines") depends only on PRP-31. This is a **self-contained, low-severity** Extended module — a classic circulation system: a `Book` (title metadata) with one or more `BookCopy` (the physical, barcoded items), a `BookIssue` (a copy lent to a member, due back), a **return** that may accrue a **fine** for late return, and a member/parent read of "books I/my child has out".

Library fines are intentionally **kept inside this module** — they are a small per-day-overdue charge tracked on the `BookIssue`, **not** routed through the PRP-44/45/46 fee ledger (a lost-book/overdue charge is operationally separate from tuition/transport dues). This keeps the module standalone and avoids coupling a Rs-2/day library fine to the term-fee machinery. (If a school later wants library fines on the main ledger, that is a future seam — noted in §8.)

> ⚠︎ **Open question (master §10 O-P8 — Extended-module priority/depth):** library depth (reservations/holds, multi-branch holdings, fine-on-main-ledger vs. standalone, barcode/ISBN scanning workflow) is **unresolved**. **Assumption (inline):** v1 is a **single-collection circulation** system — catalog + copies + issue/return + a standalone per-day overdue fine with a configurable rate/grace/cap. Reservations/holds, inter-branch holdings, and routing fines to the fee ledger are **out**; the model leaves seams (a `BookIssue.fineAmount` + a small `LibrarySettings`) so they are later config/rows, not migrations.

## 2. Goal & non-goals
- **Goal:** a `src/modules/library/` module (house split) with: `Book` (catalog metadata), `BookCopy` (physical items + availability), `BookIssue` (a copy lent to a member with a due date, returned date, and an overdue `fineAmount`), a per-school `LibrarySettings` (loan period, per-day fine rate, grace, cap, max books per member); admin/librarian CRUD for the catalog + copies; **issue** and **return** flows (return computes the overdue fine); a member/parent read of current + past borrowings; and a simple **overdue report**. Plus the matching **FE** screens (librarian circulation desk + a parent/student "my books" view).
- **Non-goals:** routing library fines through the fee ledger (PRP-44/45/46 — kept standalone here; seam noted), reservations/holds, acquisitions/purchase orders, multi-branch holdings, OPAC/public catalog search, RFID/barcode hardware integration (the `barcode`/`isbn` fields exist; no scanner protocol), e-books/digital lending. A "member" is resolved from an existing `UserSchool` (student/staff/teacher) — there is **no** separate membership-registration flow (the school's people already exist via PRP-30/31).

## 3. Target design

### Backend

#### 3.1 Schema (`prisma/schema.prisma`)
Denormalize `schoolId` on every row; `Decimal @db.Decimal(10,2)` for fine money (PRP-44/15 rule); enums from `src/generated/prisma/enums.js`.

```prisma
enum BookCopyStatus {
  AVAILABLE
  ISSUED
  LOST
  DAMAGED
  WITHDRAWN       // removed from circulation
}

enum BookIssueStatus {
  ISSUED          // currently out
  RETURNED        // returned (on time or late)
  LOST            // member reported the copy lost (fine = replacement, ⚠︎ policy)
}

model Book {
  bookId       String      @id @default(uuid())
  schoolId     String
  title        String
  author       String?
  isbn         String?                                   // optional; not unique (different editions)
  publisher    String?
  category     String?                                   // "Fiction", "Reference" — free-text/shelf
  edition      String?
  copies       BookCopy[]
  school       School      @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  @@index([schoolId])
  @@index([schoolId, title])
}

model BookCopy {
  bookCopyId   String         @id @default(uuid())
  schoolId     String
  bookId       String
  accessionNo  String                                    // accession/barcode — unique per school
  status       BookCopyStatus @default(AVAILABLE)
  shelf        String?                                    // shelf/rack location
  book         Book           @relation(fields: [bookId], references: [bookId], onDelete: Cascade)
  issues       BookIssue[]
  school       School         @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt

  @@unique([schoolId, accessionNo])
  @@index([schoolId])
  @@index([bookId])
  @@index([status])
}

// A copy lent to a member. The member is a UserSchool (student/staff/teacher) — we store
// userSchoolId (and denormalize studentId when the member is a student, for the parent view).
model BookIssue {
  bookIssueId    String          @id @default(uuid())
  schoolId       String
  academicYearId String                                  // year-scoped for history/reporting (PRP-28)
  bookCopyId     String
  userSchoolId   String                                  // the borrowing member (PRP-30/31 → UserSchool)
  studentId      String?                                 // denormalized when the member is a student (parent view §3.4)
  issuedAt       DateTime        @default(now())
  dueDate        DateTime                                // issuedAt + LibrarySettings.loanDays
  returnedAt     DateTime?
  status         BookIssueStatus @default(ISSUED)
  fineAmount     Decimal         @db.Decimal(10, 2) @default(0)  // accrued overdue/lost fine (standalone, §3.3)
  fineWaived     Boolean         @default(false)         // librarian may waive (audited) — not a refund
  finePaid       Boolean         @default(false)         // simple paid flag (standalone; not the fee ledger)
  issuedByUserId String?                                 // librarian/staff who issued
  bookCopy       BookCopy        @relation(fields: [bookCopyId], references: [bookCopyId])
  school         School          @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  @@index([schoolId])
  @@index([userSchoolId, status])
  @@index([studentId])
  @@index([status, dueDate])                             // overdue queries
}

// Per-school circulation policy (configurable; O-P8 ⚠︎ for exact numbers).
model LibrarySettings {
  librarySettingsId String  @id @default(uuid())
  schoolId          String  @unique
  loanDays          Int     @default(14)                 // default loan period
  finePerDay        Decimal @db.Decimal(10, 2) @default(0) // overdue fine/day (₹)
  graceDays         Int     @default(0)                  // days after dueDate before fine accrues
  maxFine           Decimal? @db.Decimal(10, 2)          // optional cap per issue
  maxBooksPerMember Int     @default(3)                  // borrowing limit
  school            School  @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```
Add back-relations to `School` (`books`, `bookCopies`, `bookIssues`, `librarySettings`). `BookIssue.userSchoolId`/`studentId` are **loose references** (no FK blocks) so the module stays decoupled from the shared `Student`/`UserSchool` edits other PRPs make (§8) — the parent view joins on the denormalized `studentId`.

> **Decision — copy-level circulation, standalone fines.** A `Book` is metadata; a `BookCopy` is the lendable unit (so a title with 5 copies lends 5 times). Issuing flips the copy to `ISSUED`; returning flips it back to `AVAILABLE` and stamps `returnedAt`. The **overdue fine** is computed at return from `LibrarySettings` (`max(0, returnedAt − dueDate − graceDays) × finePerDay`, capped at `maxFine`) and stored on the `BookIssue` — it is **not** a PRP-44/45 `Fine` and does **not** touch the fee ledger (operationally separate). `finePaid` is a simple flag the librarian sets at the desk. This keeps the module fully self-contained; routing library fines to the main ledger is a deliberate **non-goal** with a noted seam (§8).

#### 3.2 Module layout (`src/modules/library/`)
House split, registered under `src/plugins/school.plugin.ts`:
- `library.routes.ts` / `library.controller.ts` / `library.service.ts` / `library.schema.ts` / `library.types.ts`.
- Imports: `resolveCurrentAcademicYear` (PRP-28), `resolveParentChildren` (PRP-41) for the parent read. Member resolution reads `UserSchool` (PRP-30/31) by id.

#### 3.3 Services & routes
`library.service.ts` exports (all `fastify`-first, all tenant-scoped via `request.schoolContext.schoolId`):
- **Catalog:** `createBook`/`listBooks`(search by title/author/isbn/category)/`updateBook`; `addCopies(fastify, schoolId, bookId, [{ accessionNo, shelf? }])` (bulk-add copies), `updateCopy` (status: mark `LOST`/`DAMAGED`/`WITHDRAWN`), `listCopies(bookId)`.
- **Settings:** `getLibrarySettings`/`setLibrarySettings` (loan days, fine rate, grace, cap, max books).
- **Issue:** `issueBook(fastify, schoolId, { bookCopyId, userSchoolId, academicYearId? })` — one transaction: assert the copy is `AVAILABLE`, the member is under `maxBooksPerMember` active issues, compute `dueDate = now + loanDays`; insert `BookIssue` (denormalize `studentId` if the member's `UserSchool` is a student); flip the copy to `ISSUED`. Audited (`library.issue`).
- **Return:** `returnBook(fastify, schoolId, bookIssueId)` — one transaction: stamp `returnedAt`, compute the overdue `fineAmount` from `LibrarySettings`, set `status: RETURNED`, flip the copy back to `AVAILABLE`. Returns the issue with the computed fine so the desk can collect it. Audited (`library.return`, fine in metadata if > 0).
- **Lost / waive / pay:** `markIssueLost(bookIssueId)` (copy → `LOST`, fine = replacement policy ⚠︎), `waiveFine(bookIssueId)` (`fineWaived: true`, audited — not a refund), `markFinePaid(bookIssueId)` (`finePaid: true`).
- **Member/parent read:** `getMemberIssues(fastify, ctx, { userSchoolId? | studentId? }, { active? })` — current + past borrowings. **Ownership:** a STUDENT reads only their own (`userSchoolId` from session); a PARENT reads only linked children (reuse **PRP-41 `resolveParentChildren`** on the denormalized `studentId`); staff/librarian read any. Never trusts a client `studentId`.
- **Overdue report:** `getOverdueIssues(fastify, schoolId, { asOf? })` — issues where `status = ISSUED` and `dueDate < asOf`, with member + accrued-fine estimate (`DataGrid` source).

Routes (school-scoped subtree; `requirePermission` PRP-17; mutations also `fastify.requireWritableSchool` PRP-15):
- `POST|GET /api/school/library/books`, `PATCH /api/school/library/books/:bookId` — (`library.manage` / `library.read`)
- `POST /api/school/library/books/:bookId/copies`, `GET /api/school/library/books/:bookId/copies`, `PATCH /api/school/library/copies/:bookCopyId` — (`library.manage` / `library.read`)
- `GET|PUT /api/school/library/settings` — (`library.read` / `library.manage`)
- `POST /api/school/library/issues` (`library.issue`) · `POST /api/school/library/issues/:bookIssueId/return` (`library.issue`) · `POST /api/school/library/issues/:bookIssueId/waive` (`library.manage`) · `POST /api/school/library/issues/:bookIssueId/mark-paid` (`library.issue`)
- `GET /api/school/library/issues` (`library.read`, supports `?userSchoolId=`/`?studentId=`/`?active=`, ownership-scoped for student/parent) · `GET /api/school/library/overdue` (`library.read`)

All responses use `successResponse`/`errorResponse`; `Decimal` fines serialized as strings.

#### 3.4 Permission strings (extends PRP-17 §3.4)
Introduce the **`library`** resource (PRP-17 owns the canonical list + seed matrix in `src/modules/authz/permissions.ts`; this PRP adds the rows). `library.issue` is the circulation-desk verb (issue/return/mark-paid); `library.manage` is catalog/copy/settings/waive; `library.read` is browse + member/parent borrowings + overdue.

| Resource | Actions (P8) | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|--------------|:-----:|:-----:|:-------:|:-------:|:------:|
| `library` | `read`, `manage`, `issue` | read+manage+issue | read+manage+issue | `read` (browse + own issues) | `read` (own issues §3.3) | `read` (children's issues §3.3) |

(A librarian is modeled as STAFF with `library.*` — no new role. Student/parent read-scope is enforced **in the service** via `resolveParentChildren`/session, not the matrix — PRP-30/49 pattern.)

### Frontend

#### 3.5 FE design (`src/modules/library/` + `src/store/library/`)
Mirror the FE feature/state convention (CLAUDE.md): UI in `src/modules/library/`, client state/API in `src/store/library/` (`library.store.ts` / `library.services.ts` / `library.type.ts`), TanStack Query for server state, `helper.successResponse`/`helper.errorResponse` normalization, routes from `APP_ROUTES`, `cn()` for classes, `DataGrid` for tables, `src/components/ui/` primitives.
- **Librarian (`library.manage`/`issue`):** a **catalog** screen (books + copies, search), a **circulation desk** (issue: pick copy/accession + member → due date shown; return: enter accession → fine computed + collect), a **settings** form, and an **overdue** report (`DataGrid`).
- **Member/Parent/Student:** a "My Books" / "My Child's Books" panel (current loans + due dates + any fine) slotted into the PRP-43 parent/student dashboard.
- Combined PRP per the implementation-plan "Library" `BE/FE` row; no separate FE PRP number — FE work specified here.

## 4. Implementation steps

### Backend
1. **Schema:** add `BookCopyStatus`/`BookIssueStatus`, `Book`/`BookCopy`/`BookIssue`/`LibrarySettings` + `School` back-relations. `pnpm exec prisma migrate dev --name library` then `pnpm prisma:generate`. (No `Student` relation block needed — `studentId` is a loose denormalized column, §8.)
2. **Module scaffold:** add `src/modules/library/{routes,controller,service,schema,types}.ts` (controllers thin; service `fastify`-first). Enums from `src/generated/prisma/enums.js`; `successResponse`/`errorResponse` from `src/utils/api-response.js`.
3. **Services:** implement catalog/copy/settings CRUD; `issueBook` (availability + `maxBooksPerMember` guard + due-date calc, in a transaction); `returnBook` (fine computation from `LibrarySettings`, copy back to `AVAILABLE`); lost/waive/mark-paid; the ownership-scoped member/parent read; the overdue report.
4. **Fine math:** `fineAmount = min(maxFine ?? ∞, max(0, daysOverdue − graceDays) × finePerDay)` with `Decimal` arithmetic (never float); serialize as string.
5. **Routing + guards:** register under `src/plugins/school.plugin.ts`; `requirePermission` (PRP-17) + `requireWritableSchool` (PRP-15) on mutations; ownership scoping in the read (PRP-41 `resolveParentChildren`).
6. **Permissions:** add `library.read`/`manage`/`issue` rows + matrix to `src/modules/authz/permissions.ts` (PRP-17); re-run `pnpm seed:permissions`.
7. **Audit:** `writeAudit()` (PRP-18) on `library.issue`, `library.return` (fine if any), `library.waive` (lightweight — D22).
8. **Schemas/types:** Fastify JSON schemas (`successEnvelope` style) + `CreateBookBody`, `AddCopiesBody`, `IssueBookBody`, `LibrarySettingsDto`, `BookIssueDto`.

### Frontend
1. **Store layer:** add `src/store/library/{library.store.ts,library.services.ts,library.type.ts}` — services call `apiClient` against §3.3, normalized via `helper.*`; TanStack Query hooks.
2. **Routes/menu:** add library route strings to `APP_ROUTES` (`src/constants/routes.ts`) and the menu entry to `getMenuList` (`src/constants/project.menu.ts`) gated on `library.*` (PRP-11).
3. **Librarian UI:** `src/modules/library/` — catalog (+copies), circulation desk (issue/return), settings, overdue (`DataGrid`).
4. **Member card:** a "My Books" panel slotted into the PRP-43 parent/student dashboard.
5. **Validation:** forms via the PRP-13 stack; `cn()` for classes; no axios in components.

## 5. Files added / changed

### Backend
- **Add:** `src/modules/library/library.routes.ts`, `library.controller.ts`, `library.service.ts`, `library.schema.ts`, `library.types.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts` (register routes), `src/modules/authz/permissions.ts` (PRP-17 — add `library.*`)

### Frontend
- **Add:** `src/modules/library/*` (librarian screens + member card), `src/store/library/library.store.ts`, `library.services.ts`, `library.type.ts`
- **Edit:** `src/constants/routes.ts` (`APP_ROUTES`), `src/constants/project.menu.ts` (menu), the PRP-43 parent/student dashboard (slot the "My Books" panel)

## 6. Acceptance criteria
- [ ] `Book`/`BookCopy`/`BookIssue`/`LibrarySettings` tables exist with the documented uniques + indexes; all carry `schoolId`; fines are `Decimal`.
- [ ] A librarian can catalog a book, add accession-numbered copies, issue an `AVAILABLE` copy to a member (blocked past `maxBooksPerMember`), and return it.
- [ ] Returning late computes the overdue fine from `LibrarySettings` (rate × days past grace, capped) and stores it on the `BookIssue`; on-time returns have a zero fine; the copy flips back to `AVAILABLE`.
- [ ] `waiveFine` clears a fine's effect (not a delete) and is audited; library fines do **not** appear in the PRP-44/45/46 fee ledger (standalone, by design).
- [ ] A STUDENT/PARENT reads **only** their own/children's borrowings (via session / PRP-41 `resolveParentChildren`); an unlinked `studentId` is `403/404`.
- [ ] All routes are tenant-scoped (client `schoolId` ignored) + permission-guarded; mutations `403/402` on a non-writable school (PRP-15); issue/return/waive audited (PRP-18).
- [ ] ⚠︎ O-P8 assumption recorded inline: v1 is single-collection circulation with standalone fines; reservations/holds, multi-branch, and fee-ledger fines are out (seams left).
- [ ] **FE:** librarian catalog/circulation/settings/overdue screens + a member "My Books" panel exist; routes via `APP_ROUTES`, menu gated on `library.*`.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; `pnpm exec prisma migrate dev --name library` applies cleanly; `pnpm seed:permissions` adds `library.*`.
- **Frontend:** `yarn type-check && yarn lint && yarn build` (and `yarn check`).
- Manual (against PRP-30/31 members): set library settings (14d loan, ₹2/day, 0 grace, ₹100 cap) → catalog a book + 2 copies → issue copy 1 to a student → backdate `dueDate` and return → fine computes & caps correctly, copy back to `AVAILABLE`; waive a fine; fetch "my books" as that student (visible) and as their parent (visible), and as an unrelated parent (denied); pull the overdue report.

## 8. Risks & rollback
- **Fine determinism:** overdue fine is `Decimal` math (rate × days past grace, capped) — never float, round at 2dp deterministically (D1, PRP-44/45). Cover with on-time / late / capped cases.
- **Standalone-fine decision (deliberate):** library fines live on `BookIssue`, **not** the fee ledger — this is an intentional non-goal to keep the module self-contained. If a school later wants library fines on the main ledger, the seam is to mint a PRP-45 `OPTIONAL_HEAD`/`Fine` from a returned-late issue (a future PRP) — **build nothing** toward it here.
- **Copy availability races:** `issueBook` must assert `AVAILABLE` inside the transaction and flip status atomically so two desks can't lend the same copy; the same for return. Cover with a concurrent-issue test if the desk is multi-user.
- **Member-scope safety:** the member/parent read must scope to own/children — students/parents must never see another member's borrowings; reuse PRP-41's `resolveParentChildren` (single guardian-edge gate), don't re-implement the `ParentStudent` join.
- **Loose member ref (§8):** `BookIssue.userSchoolId`/`studentId` are loose columns (no FK) to avoid touching the shared `Student`/`UserSchool` relation blocks other PRPs edit — the denormalized `studentId` is what the parent view joins on; keep it populated on issue when the member is a student.
- **Rollback:** additive module + tables (BE) and additive feature dir + store (FE); revert and drop the four tables. Inert until routes are registered.
