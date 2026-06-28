# PRP-40 — Absence alerts & attendance reports

> **Status:** Proposed · **Phase:** 3 · **Severity:** 🟠 Med · **Size:** M
> **Addresses:** P3-BE-3 (master-prp §5.4/§6, decision D20) · **Depends on:** PRP-38 (`AttendanceRecord` — the source data + the marked event), PRP-18 (`writeAudit()` + the audit read pattern), PRP-31 (Student/`ParentStudent` — to resolve who to alert), PRP-12 (school context), PRP-28 (year-scoped reporting) · **Pairs with:** PRP-39 (staff-attendance reports — same report engine, extended) · **Feeds:** PRP-41 (parent surface may re-expose alerts), PRP-43 (web attendance reports + report exports) · **Superseded later by:** PRP-54 (notification engine — this PRP uses a *minimal sender* now and migrates to it)

## 1. Problem / current state
PRP-38 records attendance but **nothing reacts to an absence and nothing aggregates** the marks. Decision D20 + the roadmap (master-prp §6 P3: "absence alerts (push/SMS)") require: when a student is marked **ABSENT** (or LEAVE/HALF_DAY per policy), notify the linked parent(s); and admins/teachers need **per-student and per-class attendance reports** (daily register, ranged summary, defaulter/low-attendance lists).

The catch: the **notification engine (PRP-54) is later** (master-prp §5.4 — built incrementally; SMS/push wired "by P3"). So this PRP must trigger alerts through a **minimal sender** that we can later swap for PRP-54 without rewriting callers. The existing email path (`src/modules/email/email.service.ts`, Brevo) is the only delivery channel that exists today — the minimal sender wraps it (and a no-op/log stub for SMS/push) behind a tiny interface that PRP-54 will implement for real. Absence-alert **timing & channel are open (master-prp §10 O-P3)** — flagged.

## 2. Goal & non-goals
- **Goal:** (a) an **absence-alert trigger** — when attendance marking/sync (PRP-38) records a qualifying absence, enqueue/send an alert to the student's linked parent(s) (PRP-31) via a **minimal `AttendanceNotifier` interface** (email-now + stubbed SMS/push), idempotent per `(student, date)` so a re-sync doesn't re-alert; (b) **attendance reports** — per-student history, per-class daily register + ranged summary, and a low-attendance/defaulter list, all year-scoped (PRP-28) and tenant-scoped (PRP-12); (c) `writeAudit()` on alert dispatch.
- **Non-goals:** the full multi-channel notification engine, templates, per-user channel preferences, delivery logs (all PRP-54 — this PRP defines the seam it will fill); the parent-facing read surface (PRP-41); the web report UI / charts / CSV download UI (PRP-43 — this PRP returns the report data + a server-side CSV export endpoint it consumes); marking itself (PRP-38). WhatsApp (PRP-54/P6).

## 3. Target design

### 3.1 Absence-alert trigger
**Where it fires:** PRP-38's `markRegister` and `syncBatch` already write `AttendanceRecord`s and know which transitioned to ABSENT. Rather than coupling PRP-38 to alerting, PRP-38 emits the marked records and this PRP provides `dispatchAbsenceAlerts(fastify, { schoolId, sectionId, date, records })`, which PRP-38 calls **after** a successful commit (a thin call, fire-and-forget like `writeAudit`). This keeps PRP-38's transaction clean and the alerting logic here.

**Qualifying statuses ⚠︎ (O-P3):** v1 alerts on `ABSENT` only; whether `LEAVE`/`HALF_DAY`/`LATE` also alert is policy and **open**. A pure helper `shouldAlert(status, policy) → boolean` (policy from config/§3.4) gates it so the set is tunable without touching the dispatcher.

**Idempotency / de-dupe:** an `AttendanceAlert` ledger row per `(studentId, attendanceDate)` records that an alert was sent, so:
1. A **re-sync** of the same absence (PRP-38 idempotency) does not re-alert (look up the ledger; skip if present).
2. A **status flip** (ABSENT → later marked PRESENT within the edit window) does **not** retroactively unsend, but a flip the other way (PRESENT → ABSENT) that has no ledger row **does** alert. (Document this asymmetry; it's the pragmatic v1.)
```
model AttendanceAlert {
  attendanceAlertId String   @id @default(uuid())
  schoolId          String
  studentId         String
  attendanceDate    DateTime @db.Date
  status            AttendanceStatus            // the status that triggered it (PRP-38 enum)
  channelsSent      String[]                    // ["EMAIL"] in v1; SMS/PUSH stubbed
  recipientCount    Int      @default(0)        // # of parent contacts notified
  sentAt            DateTime @default(now())
  createdAt         DateTime @default(now())
  @@unique([studentId, attendanceDate], name: "uniq_alert_student_day")  // de-dupe key
  @@index([schoolId, attendanceDate])
}
```

### 3.2 Minimal sender (`AttendanceNotifier`) — the PRP-54 seam
A tiny interface in `src/modules/notification-min/notifier.ts` (a deliberately small, throwaway-able module — **not** the PRP-54 engine):
```
interface AttendanceNotifier {
  sendAbsenceAlert(fastify, {
    schoolId, student, recipients,   // recipients resolved from ParentStudent (PRP-31)
    attendanceDate, status
  }): Promise<{ channelsSent: string[]; recipientCount: number }>;
}
```
v1 implementation `MinimalAttendanceNotifier`:
- **Email:** reuse `src/modules/email/email.service.ts` (Brevo) with a small inline absence template (added to `src/modules/email/templates/`, mirroring `set-password.template.ts`) → real delivery to parent emails.
- **SMS / push:** **no-op + log** (`fastify.log.info` "would SMS/push …") — a stub returning the channel name only if a real provider is configured (none in v1). This satisfies "alerts fire" without blocking on PRP-54.
- **Recipient resolution:** `ParentStudent` (PRP-31) → the parent `UserSchool` → contact (email/phone). Respect `isPrimary` if present; alert all linked guardians by default ⚠︎ (O-P3 — exact recipient policy open).
> **Migration note (PRP-54):** when PRP-54 lands, `MinimalAttendanceNotifier` is replaced by an adapter that emits a domain event into the engine (channel-agnostic fan-out + `ChannelPreference` + `DeliveryLog`). Callers (`dispatchAbsenceAlerts`) keep the same signature — only the notifier binding changes. This module is the explicit, isolated seam (master-prp §5.4 "built incrementally").

### 3.3 Reports
Read-only aggregations in `src/modules/attendance-report/` (kept separate from PRP-38's marking module so report queries don't bloat the write path), all scoped to `request.schoolContext.schoolId` (PRP-12) + the active `academicYearId` (PRP-28):

| Method & path | Guard | Returns |
|---|---|---|
| `GET /school/attendance/reports/student/:studentId?from=&to=` | `attendance.read` (PRP-38 key) | per-student day-by-day history + tallies (present/absent/late/leave/half-day, % present) |
| `GET /school/attendance/reports/class/:sectionId?from=&to=` | `attendance.read` | per-student summary rows for a section over a range (the class register rollup) |
| `GET /school/attendance/reports/low-attendance?sectionId?=&threshold=` | `attendance.read` | students below an attendance % threshold (defaulter list) for a class/whole school |
| `GET /school/attendance/reports/class/:sectionId/export?from=&to=&format=csv` | `attendance.read` | **server-side CSV** of the class summary (PRP-43's "download" calls this; reuse a CSV util or `@fast-csv`/manual) |
| `GET /school/staff-attendance/reports/summary?from=&to=&departmentId=` | `staff_attendance.read` (PRP-39 key) | staff summary (PRP-39 data) — same engine extended |

Services compute tallies with grouped Prisma `count`/`groupBy` over `AttendanceRecord` (and `StaffAttendance` for the staff report), never per-row in app code where a `groupBy` suffices. `% present` math documented (e.g. `(present + 0.5*halfDay) / markedDays`) ⚠︎ — the half-day weighting is policy (O-P3-adjacent); keep it in one helper.

### 3.4 Config (`src/config/shared-env.ts`)
Add `ABSENCE_ALERT_STATUSES` (default `"ABSENT"` — comma-list, parsed into the `shouldAlert` policy), `ABSENCE_ALERT_ENABLED` (default `true`), `ATTENDANCE_LOW_THRESHOLD_DEFAULT` (default 75 — the defaulter % default). Add to `sharedEnvProperties`/`AppConfig`/`readSharedEnv()` (mirror PRP-15).

### 3.5 Audit (PRP-18)
`writeAudit()` on `attendance.alert_sent` (per dispatch batch — student/date/channels/recipientCount in metadata). Reports are reads → no audit. Keep metadata to identifiers (PRP-18 PII note — no message bodies).

## 4. Implementation steps
1. **Schema:** add `AttendanceAlert` (using PRP-38's `AttendanceStatus`) to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name attendance_alerts` then `pnpm prisma:generate`.
2. **Minimal notifier:** add `src/modules/notification-min/notifier.ts` (interface + `MinimalAttendanceNotifier`) + an absence email template in `src/modules/email/templates/`; wire email via the existing `email.service.ts`, stub SMS/push as logged no-ops.
3. **Dispatcher:** add `dispatchAbsenceAlerts(fastify, …)` (in the notifier module or `attendance-report` service) — resolve recipients (PRP-31 `ParentStudent`), check the `AttendanceAlert` ledger (de-dupe), call the notifier, write the ledger row + `writeAudit`. Make it non-throwing into PRP-38's path (fire-and-forget, like `writeAudit`).
4. **PRP-38 hook-up:** PRP-38's `markRegister`/`syncBatch` call `dispatchAbsenceAlerts` after commit with the marked records. (Coordinate the exact call site with PRP-38 — it passes the records; this PRP filters via `shouldAlert`.)
5. **Reports module:** add `src/modules/attendance-report/{routes,controller,service,schema,types}.ts`; implement the grouped-aggregation queries + the `%-present` helper; register under PRP-12's school-scoped plugin (reads — no `requireWritableSchool`). Add the CSV export route (server-side CSV).
6. **Config:** add the three `ABSENCE_*`/`ATTENDANCE_LOW_*` keys to `shared-env.ts`.
7. **Schemas/Swagger:** Fastify JSON schemas for the report routes (`successResponse` envelope); document the CSV route's content type.

## 5. Files added / changed
- **Add:** `src/modules/notification-min/notifier.ts`, `src/modules/email/templates/absence-alert.template.ts`, `src/modules/attendance-report/{routes,controller,service,schema,types}.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/config/shared-env.ts`, PRP-38's marking service (the post-commit `dispatchAbsenceAlerts` call), the school-scoped plugin registration, `src/modules/email/email-template.registry.ts` (register the new template)

## 6. Acceptance criteria
- [ ] Marking a student ABSENT (online or via sync) sends an alert to the linked parent(s) (PRP-31) by email, and logs intended SMS/push (stub); a re-sync of the same `(student, date)` does **not** re-alert (de-dupe via `AttendanceAlert`).
- [ ] `shouldAlert` gates which statuses alert (v1: ABSENT only), configurable via `ABSENCE_ALERT_STATUSES`; `ABSENCE_ALERT_ENABLED=false` disables dispatch entirely.
- [ ] Alert dispatch never throws into PRP-38's marking transaction (fire-and-forget); a notifier failure is logged, not fatal.
- [ ] Per-student, per-class, and low-attendance reports return correct year-scoped, tenant-scoped tallies; the class CSV export streams a valid file.
- [ ] The staff-attendance summary report (PRP-39 data) works through the same engine.
- [ ] Alert dispatches are audited (`attendance.alert_sent`, PRP-18) with no message bodies in metadata.
- [ ] The notifier sits behind the `AttendanceNotifier` interface so PRP-54 can replace it without touching `dispatchAbsenceAlerts`.

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name attendance_alerts` applies.
- Manual (against PRP-38/31 seed data): mark a student ABSENT → confirm a parent email is sent (Brevo sandbox) + an `AttendanceAlert` row + an audit entry; re-run the same sync → no second alert; flip `ABSENCE_ALERT_ENABLED=false` → no dispatch; hit the class report + CSV export → correct tallies/file; hit the low-attendance list with a threshold → expected students.

## 8. Risks & rollback
- ⚠︎ **Alert timing & channel are open (O-P3):** v1 sends immediately on marking, email-only (+ stubbed SMS/push). Real-time-on-mark vs an end-of-day digest, and which channels, are open — `dispatchAbsenceAlerts` + `shouldAlert` are isolated so the policy/timing changes (e.g. move to a scheduled digest job, reuse PRP-05's job pattern) without touching PRP-38. ⚠︎ **Recipient policy (O-P3):** v1 alerts all linked guardians; `isPrimary`-only or per-guardian preference is open.
- **PRP-54 coupling (the seam):** the `MinimalAttendanceNotifier` is deliberately throwaway — keep it tiny and behind the interface so swapping in PRP-54's engine is a binding change, not a rewrite. Do **not** build templates/preferences/delivery-logs here (that's PRP-54's job) — resist scope creep.
- **De-dupe correctness:** the `(student, date)` ledger prevents re-alert storms on re-sync, but the documented asymmetry (a late PRESENT→ABSENT flip with no prior row alerts; an ABSENT→PRESENT flip doesn't unsend) is a deliberate v1 simplification — note it for support.
- **Report query cost:** ranged class/low-attendance reports over big rosters must use Prisma `groupBy`/indexed `(schoolId, attendanceDate)` / `(sectionId, attendanceDate)` scans (PRP-38 indexes), not per-student loops; paginate/limit the defaulter list. CSV export should stream for large ranges.
- **Email deliverability:** parents may lack emails (D17 — student/parent contact varies); the notifier must skip-with-log a missing contact, not error, and the stubbed SMS/push is the real channel once PRP-54 lands.
- Rollback: additive — revert the two modules + the PRP-38 call site + drop `AttendanceAlert`. PRP-38 marking still works without alerts; reports are inert reads.
