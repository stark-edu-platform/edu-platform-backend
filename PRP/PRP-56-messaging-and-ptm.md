# PRP-56 — Teacher↔parent messaging & PTM scheduling

> **Status:** Proposed · **Phase:** 6 · **Severity:** 🟠 Med · **Size:** L
> **Addresses:** P6-BE-3 (master-prp §6 P6, §5.7 P6) · **Depends on:** PRP-54 (notification engine — new-message / PTM notifications fan out via `dispatchNotification`), PRP-46 (the **canonical** `src/lib/storage/` S3 abstraction + `STORAGE_*` env — message attachments use it; **no** parallel storage util/env), PRP-31 (Student/`ParentStudent` — the teacher↔parent relationship is mediated by a shared student), PRP-30 (`TeacherAssignment` — which teacher may message which class's parents), PRP-12 (school context), PRP-18 (`writeAudit()`), PRP-17 (permission keys), PRP-28 (year scoping for PTM windows) · **Consumed by:** FE PRP-58 (web messaging + PTM UI), MOB PRP-60 (mobile messaging — optional in P6, notices/homework are MOB's primary scope)

## 1. Problem / current state
Parents and teachers have **no direct channel** in-platform. Master-prp §6 (P6) lists "teacher↔parent messaging + PTM" and §5.7 names the `Message` and `PTMSlot` entities. The relationship is specific: a parent and a teacher are connected **through a shared student** (the parent's child whom the teacher teaches) — messaging must be **scoped to that link**, not an open social inbox. Separately, schools run **Parent-Teacher Meetings**: a teacher (or admin) opens bookable time slots; parents book one per child.

PRP-54 (engine), PRP-31 (`ParentStudent`), and PRP-30 (`TeacherAssignment`) now provide the pieces. This PRP adds **threaded messaging** (scoped by the student link) and **PTM scheduling/booking**, wiring new-message and booking events to PRP-54 so the other party gets a push/email, all under the BE module split + tenant scoping (PRP-12) + write-gating (PRP-15).

⚠︎ **O-P6 (master-prp §10):** **messaging moderation/permissions** are open. v1 ships a **conservative, relationship-scoped** model (a teacher may only message parents of students they teach; parents may only message their child's teachers/class staff) with a per-school **messaging-enabled** flag and a **report/flag** hook — the deeper moderation policy (admin review queues, profanity filters, blocking) is deferred behind that hook, flagged ⚠︎.

## 2. Goal & non-goals
- **Goal:** (a) a **`MessageThread`** + **`Message`** model — a thread is **scoped to a (teacher, parent, student) triple** (or a teacher↔admin/staff thread) so messaging is always relationship-bounded; messages carry text + optional attachment, with per-participant **read state**; (b) **send/list/read APIs** with strict server-side **authorization** that a participant may only see/post in threads they belong to and may only **start** a thread the relationship permits (PRP-30 assignment ↔ PRP-31 guardianship); (c) a **`PTMSlot`** + **`PTMBooking`** model — a teacher/admin publishes bookable slots (per section/subject, within a PTM window/event), a parent books one slot **per child**, with capacity + double-book prevention; (d) **fan-out** via PRP-54 on new message (`message.created`) and on PTM booking/slot-publish (`ptm.scheduled`/`ptm.booked`); (e) a per-school **messaging on/off** flag + a **report-message** hook (the moderation seam ⚠︎ O-P6).
- **Non-goals:** the notification engine (PRP-54); group chats / school-wide chat (v1 is 1:1 relationship-scoped — broadcasts are notices, PRP-55); real-time/websocket delivery (v1 is request/response + push notification; live typing/presence is a follow-up); video-call integration for PTM (slots are time bookings; a meeting link can be stored as a slot field but conferencing is out of scope); the deep moderation/review workflow (deferred behind the report hook ⚠︎ O-P6); the web/mobile UI (PRP-58/PRP-60); attachments beyond a single file per message (reuse PRP-55's S3 attachment pattern).

## 3. Target design

### 3.1 Schema (`prisma/schema.prisma`) — relationship-scoped, tenant-scoped
```
enum ThreadKind { TEACHER_PARENT TEACHER_STAFF ADMIN_PARENT }  // who the two parties are
enum PTMSlotStatus { OPEN BOOKED CANCELLED }

model MessageThread {
  messageThreadId String        @id @default(uuid())
  schoolId        String
  kind            ThreadKind    @default(TEACHER_PARENT)
  studentId       String?                                   // the shared student that scopes a teacher↔parent thread
  subject         String?                                   // optional thread title
  lastMessageAt   DateTime      @default(now())
  isClosed        Boolean       @default(false)
  participants    ThreadParticipant[]
  messages        Message[]
  createdAt       DateTime      @default(now())
  @@index([schoolId, lastMessageAt])
  @@index([studentId])
}

model ThreadParticipant {
  threadParticipantId String   @id @default(uuid())
  messageThreadId     String
  schoolId            String
  userId              String                                // a UserSchool member (teacher / parent / admin)
  role                SchoolRole                            // their role in this thread (for display/authorization)
  lastReadAt          DateTime?                             // read-state (unread = messages after this)
  thread              MessageThread @relation(fields: [messageThreadId], references: [messageThreadId], onDelete: Cascade)
  @@unique([messageThreadId, userId])
  @@index([userId, schoolId])
}

model Message {
  messageId       String        @id @default(uuid())
  messageThreadId String
  schoolId        String
  senderUserId    String
  body            String
  attachmentKey   String?                                   // S3 key (optional single attachment, PRP-55 pattern)
  attachmentName  String?
  flaggedAt       DateTime?                                 // report/moderation hook ⚠︎ O-P6
  flaggedByUserId String?
  thread          MessageThread @relation(fields: [messageThreadId], references: [messageThreadId], onDelete: Cascade)
  createdAt       DateTime      @default(now())
  @@index([messageThreadId, createdAt])
  @@index([schoolId, flaggedAt])
}

model PTMSlot {
  ptmSlotId       String        @id @default(uuid())
  schoolId        String
  academicYearId  String
  eventId         String?                                   // optional link to a PRP-55 PTM Event window
  teacherUserId   String                                    // the teacher offering the slot
  sectionId       String?                                   // scope (a teacher's class)
  subjectId       String?
  startAt         DateTime
  endAt           DateTime
  capacity        Int           @default(1)                 // usually 1 parent per slot
  status          PTMSlotStatus @default(OPEN)
  bookings        PTMBooking[]
  createdAt       DateTime      @default(now())
  @@index([schoolId, academicYearId, startAt])
  @@index([teacherUserId, startAt])
}

model PTMBooking {
  ptmBookingId  String   @id @default(uuid())
  ptmSlotId     String
  schoolId      String
  parentUserId  String
  studentId     String                                      // which child the meeting is about
  note          String?
  cancelledAt   DateTime?
  slot          PTMSlot  @relation(fields: [ptmSlotId], references: [ptmSlotId], onDelete: Cascade)
  createdAt     DateTime @default(now())
  @@unique([ptmSlotId, studentId])                          // one booking per slot per child (capacity guard in service for >1)
  @@index([parentUserId])
  @@index([studentId])
}
```

### 3.2 Messaging authorization (the relationship boundary — the security core)
Two distinct checks, both **server-side, never trust the client**:
- **May start a thread?** `canStartThread(fastify, schoolId, fromUserId, toUserId, studentId)`: for `TEACHER_PARENT`, the student must be one the **parent guardians** (PRP-31 `ParentStudent`) **and** the teacher must be **assigned** to that student's section/subject (PRP-30 `TeacherAssignment`). For `ADMIN_PARENT`, the admin may start with any guardian in the school. For `TEACHER_STAFF`, both are school members. A thread that fails the predicate is rejected (`fastify.httpErrors.forbidden`).
- **May see/post in a thread?** Membership check: the caller must be a `ThreadParticipant`. Listing returns only the caller's threads. Posting requires membership + the thread not `isClosed`. This is the same tenant-scoping discipline as PRP-12 — `schoolId` forced from `request.schoolContext`, participation enforced in the query.
The per-school **messaging-enabled** flag gates the whole feature; when off, send/start return a clear disabled error (reads of history may stay allowed — policy ⚠︎). **Home (pinned, not "model or config"):** add an **additive `messagingEnabled Boolean @default(false)` column on the existing `School` model** (the same place school-level toggles live) — *not* a free-floating config constant and *not* a new settings table (no `SchoolSetting` model is introduced just for this one flag; if a broader settings table later exists it can absorb the column, but v1 is the `School` column). Default `false` so messaging is opt-in per school. The migration is additive (one nullable-then-defaulted boolean).

### 3.3 PTM booking logic
- A teacher/admin **publishes slots** (`POST /school/ptm/slots`, possibly bulk for a window) scoped to their section/subject, optionally linked to a PRP-55 PTM `Event`.
- A parent **lists open slots** for a teacher/their child's section and **books one** (`POST /school/ptm/slots/:id/book` with `studentId`): the service checks the child is the parent's (PRP-31), the slot is `OPEN` and under `capacity`, and there's **no existing booking for that child in that slot** (`@@unique`) — and typically **no overlapping booking for the same child** (a small overlap check ⚠︎). On success the slot flips to `BOOKED` (when capacity filled). Cancellation frees the slot.
- Booking concurrency: the capacity/double-book guard runs in a **transaction** (`fastify.prisma.$transaction`) so two parents can't over-book a single-capacity slot (the `@@unique` is the backstop; the txn avoids the race for capacity > 1).

### 3.4 Fan-out (PRP-54)
- **New message:** after a `Message` is persisted, `dispatchNotification(fastify, { eventKey: 'message.created', category: 'MESSAGE', schoolId, recipients: [the other participant(s)], variables: { senderName, snippet, threadLink, entityType: 'thread', entityId: messageThreadId }, dedupeKey: \`message.created:${messageId}\` })` (PRP-54). The `dedupeKey` is **per logical event** (`message.created:${messageId}`), **not** per recipient — PRP-54's `DeliveryLog` `@@unique([dedupeKey, userId, channel])` adds `userId`, so the key fans out to each participant (one row apiece) and de-dupes only a replay to the same recipient (don't append `userId` here). `entityType`/`entityId` drive the push/feed deep-link (PRP-54 §3.4b). `IN_APP` always; PUSH/EMAIL per the recipient's `ChannelPreference` (a parent who muted message emails still gets the in-app + push). Fire-and-forget.
- **PTM:** `ptm.scheduled` when slots are published to a parent audience (optionally; or surfaced via a PRP-55 event), and `ptm.booked` to the teacher when a parent books (and to the parent as a confirmation/reminder). Reminders ahead of the slot reuse PRP-55/PRP-05's scheduled-sweep pattern (a small "PTM reminder" tick) ⚠︎ (timing open).

### 3.5 APIs (`src/modules/messaging/…` + `src/modules/ptm/…`)
Under PRP-12's school plugin, `schoolId` forced; writes via PRP-15 `requireWritableSchool`; `successResponse`/`errorResponse`.
| Method & path | Guard | Purpose |
|---|---|---|
| `GET /school/threads?cursor=` | `messaging.use` | the caller's threads (membership-filtered), newest-activity-first, with unread counts |
| `POST /school/threads` | `messaging.use` + writable | start a thread (`canStartThread` enforced) — `{ toUserId, studentId?, kind, subject?, firstMessage }` |
| `GET /school/threads/:id/messages?cursor=` | `messaging.use` | thread history (membership enforced); updates `lastReadAt` |
| `POST /school/threads/:id/messages` | `messaging.use` + writable | post a message → fan-out (§3.4); rejected if `isClosed`/messaging disabled |
| `POST /school/threads/:id/close` | `messaging.use` (participant) or `messaging.moderate` | close a thread |
| `POST /school/messages/:id/report` | `messaging.use` | flag a message (`flaggedAt`) — the moderation hook ⚠︎ O-P6 |
| `GET /school/messages/flagged` | `messaging.moderate` | admin review of flagged messages (the deferred moderation surface's read side) |
| `GET /school/ptm/slots?teacherUserId=&sectionId=&from=&to=` | `ptm.read` | list slots (open + own bookings) |
| `POST /school/ptm/slots` (single/bulk) | `ptm.manage` + writable | teacher/admin publish slots |
| `POST /school/ptm/slots/:id/book` | `ptm.book` + writable | parent books a slot for a child (txn-guarded) |
| `DELETE /school/ptm/bookings/:id` | `ptm.book`/`ptm.manage` + writable | cancel a booking (frees slot) |

New permission keys: `messaging.use`, `messaging.moderate`, `ptm.read`, `ptm.manage`, `ptm.book` — added to PRP-17's seed map (FE PRP-58 mirrors them). `messaging.use` is granted to TEACHER/PARENT/ADMIN/STAFF; `messaging.moderate` to ADMIN.

### 3.6 Audit (PRP-18)
`writeAudit` on `message.report`, `thread.close`, `ptm.slot.publish`, `ptm.book`, `ptm.cancel` (identifiers only — **no message bodies**, PRP-18 PII rule). Routine sends are **not** audited (volume); the `Message` row + the `DeliveryLog` (PRP-54) are the record.

## 4. Implementation steps
1. **Schema:** add `MessageThread`/`ThreadParticipant`/`Message`/`PTMSlot`/`PTMBooking` + `ThreadKind`/`PTMSlotStatus` to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name messaging_and_ptm` then `pnpm prisma:generate`.
2. **Messaging module:** `src/modules/messaging/{routes,controller,service,schema,types}.ts` — thread list/start/history/post/close/report; `canStartThread` (PRP-30 ↔ PRP-31) + participation checks; `lastReadAt` updates; the `School.messagingEnabled` flag gate (§3.2); wire `message.created` fan-out (PRP-54), fire-and-forget.
3. **PTM module:** `src/modules/ptm/{routes,controller,service,schema,types}.ts` — slot publish (single/bulk), open-slot listing, transactional booking + capacity/double-book guard, cancel; `ptm.booked`/`ptm.scheduled` fan-out; optional reminder sweep (PRP-05/PRP-55 pattern).
4. **Attachments:** single-attachment S3 presign on a message via **PRP-46's canonical `src/lib/storage/`** (`putObject`/`getSignedUrl`) + its `STORAGE_*` env — same pattern as PRP-55, **no** parallel storage util/env.
5. **Permissions:** add the five keys to PRP-17's seed map.
6. **Notification templates:** seed `message.created` / `ptm.scheduled` / `ptm.booked` templates into PRP-54's catalog ⚠︎ (O-P6).
7. **Register + schemas:** register both under PRP-12's school plugin; Fastify JSON schemas + Swagger.

## 5. Files added / changed
- **Add:** `src/modules/messaging/{routes,controller,service,schema,types}.ts`, `src/modules/ptm/{routes,controller,service,schema,types}.ts`, optional PTM-reminder sweep
- **Edit:** `prisma/schema.prisma` (+ migration — adds `messages`/`ptm` models **and** the additive `School.messagingEnabled Boolean @default(false)` column, §3.2), PRP-17's permission seed (five keys), PRP-12's school plugin registration, PRP-54's template catalog seed; **consumes** PRP-46's `src/lib/storage/` for message attachments (no new storage util/env)

## 6. Acceptance criteria
- [ ] The five models + two enums exist, tenant-scoped, with the documented uniques/indexes.
- [ ] A teacher can start a thread with a parent **only** when they teach the parent's child (PRP-30 ↔ PRP-31); an attempt outside the relationship is `403`; a parent can only message their child's teachers/class staff.
- [ ] A participant sees only their own threads and can post only in threads they belong to; a non-participant is denied (server-side, PRP-12 discipline).
- [ ] Posting a message fans out via PRP-54 (`message.created`): an `IN_APP` entry + PUSH/EMAIL per the recipient's `ChannelPreference`; fan-out never blocks the send.
- [ ] A teacher/admin publishes PTM slots; a parent books one per child; capacity + double-booking are enforced (transaction + `@@unique`), and a booking notifies the teacher + confirms to the parent.
- [ ] The per-school `School.messagingEnabled` flag (additive column, §3.2) disables send/start with a clear error; a message can be **reported** (`flaggedAt`) and an admin (`messaging.moderate`) can list flagged messages — the moderation hook exists (deeper workflow deferred ⚠︎ O-P6).
- [ ] Writes are write-gated (PRP-15) + permission-gated (new keys, PRP-17); report/close/PTM actions are audited (PRP-18, no bodies).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name messaging_and_ptm` applies.
- Manual (against P2 + PRP-31/30 + PRP-54 seed): as a teacher assigned to section A, start a thread with a guardian of a student in A → succeeds; try a guardian of section B (not taught) → `403`; post a message → confirm the parent gets an `IN_APP` `DeliveryLog` + a push (if a token/pref); as that parent, reply → teacher notified; publish 3 PTM slots → as two different parents try to book the same single-capacity slot → exactly one succeeds; flip `messaging.enabled=false` → send is rejected; report a message → it appears in the admin flagged list; force READ_ONLY → posting/booking rejected.

## 8. Risks & rollback
- ⚠︎ **O-P6 — moderation/permissions are open.** v1 is deliberately conservative (relationship-scoped + per-school enable flag + a report hook + an admin flagged-list read). The deeper policy (review queues, auto-filtering, blocking, retention) is deferred **behind the `flaggedAt` hook + `messaging.moderate`** so it slots in without a model change. Document that v1 has no automatic content filtering.
- **Authorization is the whole feature:** `canStartThread` + participation checks are the security boundary — they must be server-enforced and **re-checked on every post** (not just at thread creation; a teacher un-assigned from a class mid-year is an edge case ⚠︎ — decide whether existing threads persist). Tenant scope (`schoolId`) forced from context, never the client (PRP-12).
- **Booking races:** concurrent bookings of a limited slot must be transactional; the `@@unique([ptmSlotId, studentId])` backstops per-child double-book but capacity > 1 needs the txn count-check. Test the race explicitly.
- **Fan-out + privacy:** notifications carry a **snippet + sender name + link**, never the full body in logs/audit (PRP-18/PRP-54 PII rule); a parent muting message emails still gets in-app/push (don't let a preference fully silence a directed message — but respect the channel choice). Attachments are S3 objects gated to thread participants (presigned, short-lived) — a non-participant must not fetch them.
- **No real-time in v1:** delivery is request/response + push; the UI (PRP-58) polls or refetches on focus (TanStack Query) — set that expectation; websockets are a follow-up, keep the API shape compatible.
- Rollback: additive — drop the five models + two enums, drop the `School.messagingEnabled` column, revert the two modules + the template seed. PRP-54 and the rest are unaffected.
