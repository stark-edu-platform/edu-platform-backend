# PRP-55 — Notices / circulars & events calendar

> **Status:** Proposed · **Phase:** 6 · **Severity:** 🟠 Med · **Size:** L
> **Addresses:** P6-BE-2 (master-prp §6 P6, §5.7 P6) · **Depends on:** PRP-54 (notification engine — notices/events fan out through `dispatchNotification`), PRP-46 (the **canonical** `src/lib/storage/` S3 abstraction + `STORAGE_*` env — notice attachments use it; **no** parallel storage util/env), PRP-12 (school context — tenant scoping), PRP-18 (`writeAudit()`), PRP-29 (`Grade`/`Section` — class-targeted notices), PRP-31 (Student/`ParentStudent` — resolving parent recipients for a class), PRP-17 (permission keys), PRP-28 (academic-year scoping for the calendar) · **Consumed by:** FE PRP-58 (web notices/events UI), MOB PRP-60 (mobile notices feed)

## 1. Problem / current state
After P1–P5 the platform manages people, attendance, fees, and exams, but has **no broadcast communication**: an admin/teacher cannot post a **notice/circular** to the school or a specific class, and there is **no events calendar** (holidays, exams, PTMs, functions). Master-prp §6 (P6) lists "Notices/circulars, events" as the first comms feature, and §5.7 names the `Notice` and `Event` entities for P6.

PRP-54 now provides the notification engine (`dispatchNotification`) and PRP-29/31 provide the class/section + student/guardian model needed to resolve **who** a class-targeted notice reaches. This PRP adds the two content features and wires their publish actions to fan out through PRP-54 (so a published notice also pushes/emails/SMSes the audience per their `ChannelPreference`), following the BE module split, `successResponse`/`errorResponse`, and Prisma-types-from-`src/generated/prisma/` conventions.

⚠︎ **O-P6 (master-prp §10):** the **template catalog** is open — the `notice.published` / `event.published` notification templates are seeded as part of PRP-54's catalog and refined as O-P6 resolves; attachment storage uses the cross-cutting S3 service (master-prp §5.6).

## 2. Goal & non-goals
- **Goal:** (a) a **`Notice`** model — a titled, bodied circular with an **audience** (whole-school, or scoped to grades/sections, or to a role set e.g. all parents/all teachers), optional **attachments** (S3), **publish/schedule/expire** lifecycle, and a **read receipt** ledger; (b) an **`Event`** model — a calendar entry (title, start/end, all-day flag, optional section/grade scope, category e.g. HOLIDAY/EXAM/PTM/FUNCTION), academic-year-scoped (PRP-28); (c) **publish → fan-out**: publishing a notice (or an event reminder) calls `dispatchNotification` (PRP-54) with the resolved recipient set + an `IN_APP` feed entry, respecting per-user channel prefs; (d) **read APIs** scoped per audience — an admin sees all; a teacher/parent/student sees notices/events targeted at them (their sections/role); (e) CRUD + lifecycle guarded by permission keys, tenant-scoped (PRP-12), write-gated (PRP-15's `requireWritableSchool`).
- **Non-goals:** the notification engine itself (PRP-54); messaging / PTM scheduling (PRP-56 — events may *reference* a PTM but the PTM slots/booking are PRP-56); homework/materials (PRP-57); the web/mobile UI (PRP-58/PRP-60); rich-text editor/WYSIWYG concerns (the API stores body as text/markdown; rendering is FE); a full CMS / versioned drafts (v1 = draft → published → expired, no revision history); comment threads on notices (out of scope — that's messaging).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`) — tenant + year scoped
```
enum NoticeStatus { DRAFT SCHEDULED PUBLISHED EXPIRED ARCHIVED }
enum NoticeAudienceType { SCHOOL ROLE CLASS }     // whole school | a role set | specific grades/sections
enum EventCategory { HOLIDAY EXAM PTM FUNCTION MEETING GENERAL }

model Notice {
  noticeId        String        @id @default(uuid())
  schoolId        String
  academicYearId  String                                   // PRP-28 scope
  title           String
  body            String                                    // text/markdown
  audienceType    NoticeAudienceType @default(SCHOOL)
  audienceRoles   SchoolRole[]                              // when ROLE: who (PARENT/TEACHER/...)
  status          NoticeStatus  @default(DRAFT)
  publishAt       DateTime?                                 // SCHEDULED → published at this time
  expiresAt       DateTime?
  isPinned        Boolean       @default(false)
  createdByUserId String                                    // author (loosely referenced)
  publishedAt     DateTime?
  attachments     NoticeAttachment[]
  targets         NoticeTarget[]                            // when CLASS: grade/section rows
  reads           NoticeRead[]
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  @@index([schoolId, academicYearId, status])
  @@index([schoolId, publishAt])
}

model NoticeTarget {                                        // class-scoped audience (grade and/or section)
  noticeTargetId String  @id @default(uuid())
  noticeId       String
  schoolId       String
  gradeId        String?
  sectionId      String?
  notice         Notice  @relation(fields: [noticeId], references: [noticeId], onDelete: Cascade)
  @@index([noticeId])
  @@index([sectionId])
}

model NoticeAttachment {
  noticeAttachmentId String @id @default(uuid())
  noticeId           String
  schoolId           String
  fileKey            String                                 // S3 object key (master-prp §5.6)
  fileName           String
  contentType        String?
  sizeBytes          Int?
  notice             Notice @relation(fields: [noticeId], references: [noticeId], onDelete: Cascade)
  @@index([noticeId])
}

model NoticeRead {                                          // read-receipt ledger
  noticeReadId String   @id @default(uuid())
  noticeId     String
  userId       String
  readAt       DateTime @default(now())
  notice       Notice   @relation(fields: [noticeId], references: [noticeId], onDelete: Cascade)
  @@unique([noticeId, userId])
  @@index([userId])
}

model Event {
  eventId         String        @id @default(uuid())
  schoolId        String
  academicYearId  String
  title           String
  description     String?
  category        EventCategory @default(GENERAL)
  startAt         DateTime
  endAt           DateTime?
  isAllDay        Boolean       @default(false)
  audienceType    NoticeAudienceType @default(SCHOOL)      // reuse the same audience shape
  audienceRoles   SchoolRole[]
  gradeId         String?                                   // simple class scope (most events are school/grade level)
  sectionId       String?
  createdByUserId String
  notifyOnPublish Boolean       @default(false)             // fan-out a reminder when created/published
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  @@index([schoolId, academicYearId, startAt])
  @@index([schoolId, category])
}
```
Audience model: `SCHOOL` (everyone in the school), `ROLE` (`audienceRoles`, e.g. all PARENTs), or `CLASS` (`NoticeTarget` grade/section rows; an Event uses its single `gradeId`/`sectionId`). Recipient resolution (§3.3) expands this to concrete `userId`s.

### 3.2 Lifecycle
- **Notice:** `DRAFT` → (`SCHEDULED` with `publishAt`) → `PUBLISHED` → `EXPIRED` (past `expiresAt`) / `ARCHIVED`. Publishing (now or when a scheduled `publishAt` fires) sets `publishedAt` and triggers fan-out (§3.3). Scheduling reuses the **job pattern from PRP-05** (a periodic sweep promotes `SCHEDULED` notices whose `publishAt ≤ now` to `PUBLISHED` and dispatches) — keep it a small cron-like hook, not a new infra. Expiry is computed at read time (a `PUBLISHED` notice past `expiresAt` reads as `EXPIRED`) and/or swept by the same job.
- **Event:** simple CRUD; `notifyOnPublish` triggers a one-shot reminder dispatch on create/publish. (Recurring events and per-event reminder lead-time are out of scope for v1 — note as a follow-up.)

### 3.3 Recipient resolution + fan-out (PRP-54)
On publish, a `resolveAudience(fastify, schoolId, audienceType, {roles?, targets?})` helper expands the audience to `userId`s + contacts:
- `SCHOOL` → all active `UserSchool` members of the school.
- `ROLE` → members whose primary or secondary role ∈ `audienceRoles` (union, mirrors `deriveAbilities` logic).
- `CLASS` → for each `NoticeTarget` section/grade: the enrolled students (PRP-32 enrollment) **and their linked guardians** (PRP-31 `ParentStudent`) **and** the section's assigned teachers (PRP-30 `TeacherAssignment`) — i.e. the people who care about that class. (Exact "who in a class gets a notice" — students only? + parents? + teachers? — is a small policy ⚠︎; default = students' guardians + section teachers, documented + tunable.)
Then call `dispatchNotification(fastify, { eventKey: 'notice.published', category: 'NOTICE', schoolId, recipients, variables: { title, snippet, link, entityType: 'notice', entityId: noticeId }, dedupeKey: \`notice.published:${noticeId}\` })` (PRP-54). The `dedupeKey` is **per logical event** (`notice.published:${noticeId}`) — **not** per recipient: PRP-54's `DeliveryLog` `@@unique([dedupeKey, userId, channel])` adds `userId`, so this one shared key fans out to **every** resolved recipient (one row apiece) while still de-duping a replay to the same recipient. (Do not append `userId` into the key here — that would defeat the engine's per-recipient model.) Pass `entityType`/`entityId` so the push/feed deep-link (PRP-54 §3.4b) opens the notice. The `IN_APP` channel write makes the notice appear in the recipient's in-app feed; EMAIL/PUSH/SMS go out per each recipient's `ChannelPreference`. Events with `notifyOnPublish` do the same with `eventKey: 'event.published'`, `category: 'EVENT'`, `entityType: 'event'`, `dedupeKey: \`event.published:${eventId}\``. **Fan-out is fire-and-forget** (PRP-54 never throws into the publish request) — the notice is published regardless of delivery outcome (which the `DeliveryLog` records).

### 3.4 APIs (`src/modules/notice/{routes,controller,service,schema,types}.ts` + `src/modules/event/…`)
All under PRP-12's school-scoped plugin, `schoolId` forced from `request.schoolContext`; writes wrapped by PRP-15's `requireWritableSchool`; `successResponse`/`errorResponse`.
| Method & path | Guard | Purpose |
|---|---|---|
| `GET /school/notices?status=&audience=&cursor=` | `notice.read` | **audience-filtered** list (admin: all; others: only notices targeting them — §3.5), newest/pinned-first |
| `GET /school/notices/:id` | `notice.read` | one notice (+ attachments); records a `NoticeRead` for the caller |
| `POST /school/notices` | `notice.manage` + writable | create (DRAFT/SCHEDULED/PUBLISHED) |
| `PUT /school/notices/:id` | `notice.manage` + writable | edit (only DRAFT/SCHEDULED freely; a PUBLISHED notice's body edits are allowed but re-dispatch is explicit) |
| `POST /school/notices/:id/publish` | `notice.manage` + writable | publish now → fan-out (§3.3) |
| `DELETE /school/notices/:id` (archive) | `notice.manage` + writable | soft-archive (`ARCHIVED`) |
| `POST /school/notices/:id/attachments` (presign) | `notice.manage` + writable | S3 presigned-upload init via PRP-46's `src/lib/storage/` (master-prp §5.6) |
| `GET /school/notices/:id/read-stats` | `notice.read_stats` | read-receipt rollup (count read / total audience) — admin/author |
| `GET /school/events?from=&to=&category=` | `event.read` | calendar range, audience-filtered |
| `POST /school/events` / `PUT /:id` / `DELETE /:id` | `event.manage` + writable | event CRUD (+ optional `notifyOnPublish` fan-out) |

New permission keys: `notice.read`, `notice.manage`, `notice.read_stats`, `event.read`, `event.manage` — added to PRP-17's seed map (FE PRP-58 mirrors them).

### 3.5 Audience-scoped reads
A non-admin's notice/event list is **filtered to what targets them**, server-side (never trust the client): a row is visible if `audienceType=SCHOOL`, or (`ROLE` and the caller holds one of `audienceRoles`), or (`CLASS`/section-scoped and the caller is enrolled-in / guardian-of-a-student-in / assigned-to that section). The same predicate composes into the Prisma `where`. Admins (`notice.read` with a broader scope, or a separate `notice.read_all` if finer control is wanted) see all — keep the visibility predicate in one helper reused by list + detail + read-stats.

### 3.6 Audit (PRP-18)
`writeAudit` on `notice.publish`, `notice.archive`, `event.create`/`event.delete` (identifiers + audience summary in metadata, no body). Reads + read-receipts are not audited (high volume).

## 4. Implementation steps
1. **Schema:** add `Notice`/`NoticeTarget`/`NoticeAttachment`/`NoticeRead`/`Event` + the three enums to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name notices_and_events` then `pnpm prisma:generate`.
2. **Notice module:** `src/modules/notice/{routes,controller,service,schema,types}.ts` — CRUD + publish + the `resolveAudience` helper + the audience-visibility predicate; wire publish to `dispatchNotification` (PRP-54, `eventKey: 'notice.published'`), fire-and-forget; record `NoticeRead` on detail.
3. **Event module:** `src/modules/event/{routes,controller,service,schema,types}.ts` — calendar CRUD + range query + optional `event.published` fan-out.
4. **Attachments:** S3 presigned-upload init for notice attachments via **PRP-46's canonical `src/lib/storage/`** (`putObject`/`getSignedUrl`) + its `STORAGE_*` env — **no** parallel storage util or env block (master-prp §5.6); store `fileKey`/metadata only.
5. **Scheduler:** a small periodic sweep (PRP-05 job pattern) that promotes `SCHEDULED` notices at `publishAt` (→ publish + dispatch) and expires past-`expiresAt` ones.
6. **Permissions:** add the five keys to PRP-17's seed map.
7. **Notification templates:** seed `notice.published` / `event.published` templates (EMAIL + IN_APP now; PUSH/SMS when configured) into PRP-54's catalog ⚠︎ (O-P6).
8. **Register + schemas:** register both modules under PRP-12's school plugin; Fastify JSON schemas (`successResponse` envelope) + Swagger.

## 5. Files added / changed
- **Add:** `src/modules/notice/{routes,controller,service,schema,types}.ts`, `src/modules/event/{routes,controller,service,schema,types}.ts`, the scheduled-publish sweep (in the notice module or alongside PRP-05's jobs)
- **Edit:** `prisma/schema.prisma` (+ migration), PRP-17's permission seed (five keys), PRP-12's school-scoped plugin registration, PRP-54's template catalog seed (`notice.published`/`event.published`); **consumes** PRP-46's `src/lib/storage/` for attachments (no new storage util/env)

## 6. Acceptance criteria
- [ ] `Notice`/`Event` (+ targets/attachments/reads) exist, tenant- and year-scoped (PRP-12/28) with the documented indexes.
- [ ] An admin/teacher can create a notice scoped to the whole school, a role set, or specific grades/sections, attach a file (S3), and publish (now or scheduled).
- [ ] Publishing fans out through `dispatchNotification` (PRP-54): an `IN_APP` feed entry for every resolved recipient + EMAIL/PUSH/SMS per their `ChannelPreference`; a scheduled notice publishes + dispatches when `publishAt` fires; fan-out never blocks/fails the publish.
- [ ] A teacher/parent/student lists/reads **only** notices & events that target them (school-wide, their role, or their section) — enforced server-side; a client cannot widen scope (PRP-12).
- [ ] Opening a notice records a `NoticeRead`; an author/admin sees a read-receipt rollup.
- [ ] The events calendar returns a date range, audience-filtered, with categories; `notifyOnPublish` events dispatch a reminder.
- [ ] CRUD/publish are write-gated (PRP-15 `requireWritableSchool` — blocked in READ_ONLY/LOCKED) and permission-gated (new keys, PRP-17); publish/archive/event-create are audited (PRP-18, no bodies).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name notices_and_events` applies.
- Manual (against P2/P3 + PRP-54 seed): create a CLASS-scoped notice for one section → publish → confirm an `IN_APP` `DeliveryLog` for that section's guardians + teachers (and an email if their pref allows), and that a parent of another section does **not** see it; schedule a notice for +1min → confirm the sweep publishes + dispatches; open a notice as a parent → a `NoticeRead` row; check read-stats; create a HOLIDAY event in a range → it appears in the calendar query; force the school READ_ONLY → publish is rejected.

## 8. Risks & rollback
- ⚠︎ **Class-audience policy (small open):** "who in a class gets a notice" (students' guardians + section teachers by default) is documented + tunable in `resolveAudience`; tighten/loosen without schema change. ⚠︎ **O-P6 template catalog:** the `notice.published`/`event.published` copy is seeded into PRP-54's catalog and refined as O-P6 resolves.
- **Fan-out volume:** a SCHOOL-wide notice resolves to every member × every enabled channel — potentially thousands of `DeliveryLog` rows + provider calls. PRP-54's inline-dispatch caveat applies most here; if a big school's broadcast is slow, this is the first place to move dispatch behind PRP-54's future queue. Resolve recipients with set queries (enrollment/guardian/assignment joins), not per-row loops; de-dupe a user who matches via multiple paths (guardian of two children in the class) before dispatch.
- **Scheduled publish reliability:** the sweep must be idempotent (a notice already `PUBLISHED` isn't re-dispatched — guard on `publishedAt`/`dedupeKey`); if the job misses a tick, publish-on-next-tick is acceptable (document the at-least-not-before semantics).
- **Attachment security:** notice attachments are S3 objects (via PRP-46's `src/lib/storage/`) scoped to a school — serve via short-lived presigned GET URLs gated by the same audience-visibility predicate (a parent of another class must not fetch the object); never expose raw bucket paths.
- **Read-receipt write volume:** `NoticeRead` writes on every open — the `@@unique([noticeId,userId])` upsert keeps it one row/user; don't audit reads.
- Rollback: additive — drop the five models + three enums, revert the two modules + the scheduler + the template seed. PRP-54 and the rest of the platform are unaffected; the catch-all FE route reclaims unused paths.
