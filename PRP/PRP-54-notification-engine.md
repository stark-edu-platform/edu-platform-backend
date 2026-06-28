# PRP-54 — Notification engine (channels / templates / preferences)

> **Status:** Proposed · **Phase:** 6 · **Severity:** 🔴 High · **Size:** XL
> **Addresses:** P6-BE-1 (master-prp §3 D9, §5.4, §5.7 P6) · **Depends on:** PRP-18 (`writeAudit()` + the decoupled-row pattern), PRP-12 (school context — tenant-scopes templates/preferences/logs), PRP-19 (mobile token auth — the same clients that register push tokens) · **Builds on:** the existing `src/modules/email/*` Brevo integration (the email adapter wraps `emailTemplateService`) · **Consumed by:** PRP-55 (notices/events), PRP-56 (messaging/PTM), PRP-57 (homework) — all emit domain events through `dispatchNotification`; **supersedes** PRP-40's `MinimalAttendanceNotifier` (the attendance absence stub swaps into this engine — see §3.7); FE PRP-58 (preference UI) and MOB PRP-60 (push registration) consume its APIs

## 1. Problem / current state
There is **no notification engine**. The only delivery channel that exists today is transactional email (`src/modules/email/email.service.ts` over Brevo, with a typed template registry in `email-template.registry.ts`), called directly from auth/invite flows. PRP-40 (absence alerts) deliberately shipped a throwaway `MinimalAttendanceNotifier` (`src/modules/notification-min/notifier.ts`) — email-now + stubbed SMS/push — behind a tiny interface, with an explicit note: *"when PRP-54 lands, `MinimalAttendanceNotifier` is replaced by an adapter that emits a domain event into the engine … callers keep the same signature."* This PRP is that engine.

Decision **D9** (master-prp §3) mandates **all four channels** — in-app/push (FCM/APNs), email (Brevo), SMS (DLT-registered), WhatsApp (BSP) — behind **one channel-agnostic engine** with **per-user channel preferences** + **templating**, built incrementally (email/in-app skeleton now; SMS/push wired through P3→P6; WhatsApp a fast-follow). §5.4/§5.7 name the new entities: `NotificationTemplate`, `ChannelPreference`, `DeliveryLog`. Nothing in the schema models any of this; the downstream P6 PRPs (55/56/57) all assume a `dispatchNotification(event)` fan-out API exists.

⚠︎ **O-P6 (master-prp §10):** the **WhatsApp BSP + SMS provider choice** and the **template catalog** are open. This PRP keeps every channel behind a **pluggable adapter interface** so the provider is a config + one adapter module, not a rewrite — and treats **WhatsApp as a registered-but-disabled fast-follow** (BSP onboarding + template-approval lead time, D9). SMS lands on a DLT-registered provider; the concrete vendor is config.

## 2. Goal & non-goals
- **Goal:** (a) three new models — `NotificationTemplate` (per-event, per-channel, school-overridable, variable-interpolated), `ChannelPreference` (per-user, per-category opt-in/out per channel), `DeliveryLog` (one row per channel attempt, with provider id + status) — plus a `PushToken` registry for FCM/APNs device tokens; (b) a **pluggable `ChannelAdapter` interface** with four implementations — **push** (FCM/APNs), **email** (wraps the existing `emailTemplateService`), **SMS** (DLT provider, behind config), **WhatsApp** (BSP, **registered but disabled** by default ⚠︎); (c) a single **`dispatchNotification(fastify, event)`** fan-out service that resolves recipients → renders the template per channel → checks each recipient's `ChannelPreference` → calls each enabled adapter → writes a `DeliveryLog` per attempt → `writeAudit` on dispatch; (d) thin **APIs**: push-token register/unregister (mobile + web), `ChannelPreference` read/update (self), template CRUD (SuperAdmin-global + school-admin-override), and a `DeliveryLog` read (admin, scoped); (e) PRP-40's absence stub re-pointed at the engine without changing its caller (§3.7).
- **Non-goals:** the **content features** that emit events (notices PRP-55, messaging PRP-56, homework PRP-57 — they call `dispatchNotification`, they don't live here); an **in-app notification inbox UI** (the engine writes an `IN_APP` channel `DeliveryLog`/feed row; the web/mobile inbox surfaces are PRP-58/PRP-60); committing to a **specific SMS/WhatsApp vendor SDK** (kept behind the adapter + config — O-P6); a full **retry/queue infrastructure** (BullMQ/Redis) — v1 dispatches inline with a simple bounded retry per adapter and a `DeliveryLog` status the operator can re-drive later (note as future hardening); **message moderation** (O-P6 — PRP-56 owns messaging policy); **broadcast scheduling** beyond "send now" (notices may schedule — that scheduling lives in PRP-55, which calls dispatch at fire time).

## 3. Target design

### 3.1 Channel + category vocabulary (the shared contract)
A `NotificationChannel` enum and a `NotificationCategory` string keyspace are the **single vocabulary** shared by templates, preferences, and logs (mirrors the permission-string contract discipline, master-prp §7.6 — define once, FE PRP-58 / MOB PRP-60 mirror verbatim):
```
enum NotificationChannel {
  IN_APP        // always-on feed/inbox row (cannot be disabled)
  PUSH          // FCM (Android) / APNs (iOS) via PushToken
  EMAIL         // Brevo (existing email module)
  SMS           // DLT-registered provider ⚠︎ O-P6
  WHATSAPP      // BSP — registered but disabled by default ⚠︎ O-P6
}
```
`NotificationCategory` (a documented string set, **not** a DB enum so new event types don't need a migration): e.g. `ATTENDANCE_ABSENCE`, `NOTICE`, `EVENT`, `MESSAGE`, `PTM`, `HOMEWORK`, `RESULT`, `FEE`, `SYSTEM`. Each emitted event names its category; preferences are keyed per category × channel.

### 3.2 Schema (`prisma/schema.prisma`)
Decoupled, tenant-aware rows (denormalized `schoolId` for scoping/indexing per the house model; loosely-referenced `userId`/`schoolId` strings on the log so a deleted user/school never blocks the delivery record — same rationale as PRP-18's `AuditLog`).
```
model NotificationTemplate {
  notificationTemplateId String              @id @default(uuid())
  schoolId               String?                              // null = platform-global default; non-null = school override
  eventKey               String                               // e.g. "attendance.absence", "notice.published" (matches the dispatch event)
  channel                NotificationChannel
  locale                 String              @default("en")   // i18n-ready (English-first, master-prp §8)
  subject                String?                              // email subject / push title; null for SMS
  body                   String                               // template with {{variable}} placeholders
  providerTemplateRef    String?                              // WhatsApp BSP-approved template name / SMS DLT template id ⚠︎ O-P6
  isActive               Boolean             @default(true)
  createdAt              DateTime            @default(now())
  updatedAt              DateTime            @updatedAt
  @@unique([schoolId, eventKey, channel, locale])             // one template per (scope, event, channel, locale)
  @@index([eventKey, channel])
  @@index([schoolId])
}

model ChannelPreference {
  channelPreferenceId String              @id @default(uuid())
  userId              String                                  // the recipient (web or mobile user)
  schoolId            String                                  // preferences are per-membership (a user across schools can differ)
  category            String                                  // NotificationCategory key
  channel             NotificationChannel
  enabled             Boolean             @default(true)
  createdAt           DateTime            @default(now())
  updatedAt           DateTime            @updatedAt
  @@unique([userId, schoolId, category, channel])
  @@index([userId, schoolId])
}

model PushToken {
  pushTokenId String   @id @default(uuid())
  userId      String
  token       String                                          // FCM registration token / APNs device token
  platform    String                                          // "android" | "ios" | "web"
  deviceId    String?                                         // stable per-install id (mobile, mirrors PRP-42 deviceId)
  lastSeenAt  DateTime @default(now())
  revokedAt   DateTime?
  createdAt   DateTime @default(now())
  @@unique([token])
  @@index([userId])
}

model DeliveryLog {
  deliveryLogId String              @id @default(uuid())
  schoolId      String?                                       // tenant scope; null for platform-level
  userId        String?                                       // recipient (loosely referenced)
  eventKey      String
  category      String
  channel       NotificationChannel
  status        DeliveryStatus      @default(PENDING)
  providerMsgId String?                                       // Brevo messageId / FCM id / SMS/WA provider id
  error         String?                                       // failure reason (no message body — PRP-18 PII rule)
  attempts      Int                 @default(0)
  dedupeKey     String?                                       // optional idempotency key (see §3.6)
  readAt        DateTime?                                     // IN_APP read-state: the in-app feed row is read when set (§3.4a); null for non-IN_APP / unread
  sentAt        DateTime?
  createdAt     DateTime            @default(now())
  @@index([schoolId, createdAt])
  @@index([userId, createdAt])
  @@index([eventKey])
  @@index([status])
  // Idempotency is PER RECIPIENT PER CHANNEL — the unique MUST include userId (and channel), not dedupeKey alone.
  // A fan-out shares one dedupeKey across all recipients; a bare @@unique([dedupeKey]) would let the first
  // recipient's row win and SKIP every other recipient (one notice → only one person notified). Including userId
  // dedupes a replay to the SAME recipient while still allowing one row per recipient. (null-friendly.)
  @@unique([dedupeKey, userId, channel])
}

enum DeliveryStatus { PENDING SENT DELIVERED FAILED SKIPPED }
```
`SKIPPED` = the recipient opted that channel out (`ChannelPreference.enabled=false`) or had no address for it (no email/phone/push token) — recorded, not an error. No FK relations on `DeliveryLog`/`PushToken` to `User`/`School` (decoupled, survives deletes — PRP-18 rationale).

### 3.3 The `ChannelAdapter` interface (pluggable — the O-P6 seam)
One small interface in `src/modules/notification/adapters/channel-adapter.ts`; each channel is one module implementing it. **This is the seam that keeps the SMS/WhatsApp vendor choice (O-P6) a config + one file**:
```
interface ChannelAdapter {
  readonly channel: NotificationChannel;
  isConfigured(fastify): boolean;                 // env present? (e.g. BREVO key, FCM creds, SMS/WA provider keys)
  send(fastify, {
    recipient,                                    // { userId, email?, phone?, pushTokens?[] }
    rendered,                                     // { subject?, body, providerTemplateRef? } from the template
    eventKey, category, schoolId
  }): Promise<{ status: DeliveryStatus; providerMsgId?: string; error?: string }>;
}
```
Implementations (`src/modules/notification/adapters/`):
- **`email.adapter.ts`** — wraps the **existing** `emailService` (Brevo). The engine has **already rendered** the template to a runtime `{subject, body}` (§3.4 step 2), so the adapter calls **`emailService.send({ to, subject, htmlContent: body, textContent })`** — the ad-hoc-content path. It must **NOT** call `emailTemplateService.sendTemplate({ to, template, data })`: that path only accepts a **registered `EmailTemplateKey`** + its typed `data` and re-renders from the code registry — it cannot send an engine-rendered, runtime `{subject, body}` string (confirmed in `email-template.service.ts`: `sendTemplate` is generic over `EmailTemplateKey` and renders via `emailTemplateRegistry[template]`). Engine templates live in `NotificationTemplate` (DB), not the code registry, so `emailService.send(...)` is the correct seam. This is the only channel that works end-to-end today — reuse it, don't reinvent (CLAUDE.md "reuse shared helpers").
- **`push.adapter.ts`** — FCM (Android/web) + APNs (iOS) via `firebase-admin` (FCM supports both through one SDK; or `node-apn` if direct APNs is preferred). Resolves the recipient's active `PushToken`s; prunes tokens the provider reports as unregistered (mark `revokedAt`). **Puts the `{ eventKey, entityType, entityId }` deep-link triple (§3.4b) in the FCM/APNs `data` block** (not just `notification`), since only `data` reliably survives into the app's background tap handler — this is what MOB-60 routes on. Config: `FCM_*` service-account creds.
- **`sms.adapter.ts`** ⚠︎ **O-P6** — a **DLT-registered** Indian SMS provider (e.g. MSG91/Kaleyra/Gupshup — vendor open). Uses `providerTemplateRef` as the DLT-approved template id (DLT requires pre-approved templates). Config: `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID`. **No-op + log + `SKIPPED`** when unconfigured (mirrors PRP-40's stub) so the engine ships before a vendor is signed.
- **`whatsapp.adapter.ts`** ⚠︎ **O-P6** — a BSP (Gupshup/Interakt/Meta Cloud — open). Uses `providerTemplateRef` as the BSP-**approved** template name (WhatsApp requires template approval — the lead time is why D9 calls it a fast-follow). **Registered in the adapter map but `WHATSAPP_ENABLED=false` by default** → the dispatcher treats it as not-configured and `SKIPPED`s it. Flip on once a BSP + templates are approved; **no code change**, just config + approved-template refs.

An `adapterRegistry: Record<NotificationChannel, ChannelAdapter>` wires them; the dispatcher iterates it. Adding a channel = add one module + one map entry.

### 3.4 `dispatchNotification` — the fan-out API (what 55/56/57/40 call)
`src/modules/notification/notification.service.ts` exports the one entry point everything else uses:
```
dispatchNotification(fastify, {
  eventKey,                       // "attendance.absence" | "notice.published" | "message.created" | "ptm.scheduled" | "homework.assigned" | ...
  category,                       // NotificationCategory
  schoolId,                       // tenant scope (null for platform/system events)
  recipients,                     // [{ userId, email?, phone? }] OR a resolver hint the service expands
  variables,                      // template interpolation data (names, dates, links) — identifiers, not secrets
  channels?,                      // optional override; default = all configured channels for the event
  dedupeKey?,                     // optional idempotency key, PER LOGICAL EVENT (e.g. `${eventKey}:${entityId}`, like `notice.published:${noticeId}`) — NOT per-user; userId is added by the @@unique so a fan-out's recipients share one key (§3.2 DeliveryLog)
}): Promise<{ dispatched: number; perChannel: Record<NotificationChannel, number> }>
```
Pipeline:
1. **Resolve template per (schoolId→fallback global) × channel × locale** from `NotificationTemplate` — school override wins over the platform default (`schoolId IS NULL`); skip a channel with no active template.
2. **Render** `subject`/`body` by interpolating `variables` into the `{{placeholder}}` template (a tiny, dependency-free renderer — no eval; missing vars render empty + log). Carry `providerTemplateRef` through for SMS/WhatsApp.
3. **For each recipient × channel:** check `ChannelPreference` (default-on if no row; `IN_APP` is always-on and cannot be disabled) → if disabled or no address/token → write a `SKIPPED` `DeliveryLog`; else call the channel's adapter (if `isConfigured`, else `SKIPPED`), write the `DeliveryLog` with the returned status + `providerMsgId`.
4. **`IN_APP`** is special: "send" = write the feed/inbox row. **The `IN_APP` `DeliveryLog` row *is* the in-app feed item** (no separate `Notification` model); read/unread state is its `readAt` column. The self-serve feed + mark-read contract is defined in **§3.4a** (consumed by FE PRP-58 / MOB PRP-60). Push (§3.4b) carries the deep-link payload that points the mobile app at the entity behind the feed item.
5. **Idempotency (per recipient × channel):** if `dedupeKey` is supplied, the engine skips a re-send only when a `DeliveryLog` already exists **for that `(dedupeKey, userId, channel)`** — matching the `@@unique([dedupeKey, userId, channel])` constraint. The `dedupeKey` is shared across a fan-out's recipients, so it must **never** be checked as `dedupeKey` alone (that would suppress all-but-one recipient); it dedupes a replay to the **same** recipient on the **same** channel while still delivering to every other recipient. This is how PRP-40's per-`(student,date)` de-dupe migrates onto the engine (§3.7): the per-recipient key prevents double-sending to a given parent without blocking other parents.
6. **`writeAudit`** (PRP-18) one `notification.dispatch` entry per call (eventKey, category, recipientCount, perChannel counts in metadata — **no message bodies**, PRP-18 PII rule). Non-blocking: a dispatch failure on one channel/recipient is logged in its `DeliveryLog`, never throws into the caller's request path (mirrors `writeAudit`/PRP-40 fire-and-forget). The function is safe to `await` or fire-and-forget.

> **Built incrementally (D9 / master-prp §5.4):** email works today; push lights up once FCM creds + PRP-60's token registration land; SMS once a DLT vendor is signed; WhatsApp last. Unconfigured channels `SKIP` cleanly — the engine ships and grows.

### 3.4a In-app feed contract (the self-serve inbox — FE-58 / MOB-60 consume this)
The in-app notification feed is **not** a separate model: each dispatched `IN_APP` `DeliveryLog` row is a feed item, and `readAt` is its read-state. The engine exposes a **self-serve feed** the web/mobile inboxes render directly (no admin/`notification.log.read` gate — this is the recipient reading their **own** notifications):
| Method & path | Guard | Purpose |
|---|---|---|
| `GET /notifications/feed?status=unread&cursor=` | `fastify.authenticate` | the caller's own `IN_APP` `DeliveryLog` rows for the active school, newest-first, cursor-paginated; `status=unread` filters `readAt IS NULL`; each item returns `{ deliveryLogId, eventKey, category, title (subject), body, entityType, entityId, readAt, createdAt }` so the client can render + deep-link |
| `GET /notifications/feed/unread-count` | `fastify.authenticate` | a cheap unread badge count (`readAt IS NULL`, `channel = IN_APP`, forced to the caller's `userId`) |
| `POST /notifications/feed/:deliveryLogId/read` | `fastify.authenticate` | mark one feed item read (stamps `readAt`; only the owner's row — `userId` from the session, never the client) |
| `POST /notifications/feed/read-all` | `fastify.authenticate` | mark all the caller's unread IN_APP items read |

All four are **forced to `request` session's `userId`** (a caller can only read/mark **their own** feed — never another user's, the PRP-12 own-scope discipline). The feed is **always-on** (IN_APP can't be disabled in preferences, §3.1), so it is the reliable surface even when a user mutes push/email. `entityType`/`entityId` come from the push/feed payload (§3.4b) so a feed tap deep-links to the same place a push does.

### 3.4b Push data payload (the deep-link contract — MOB-60 deep-links on it)
Every `PUSH` send (and the `IN_APP` feed item) carries a **structured data payload** so the mobile app can route a tap to the right screen, independent of the human-readable title/body:
```
data: { eventKey: string, entityType: string, entityId: string }
```
- `eventKey` — the dispatch event (e.g. `"notice.published"`, `"homework.assigned"`, `"result.published"`).
- `entityType` — the domain object kind the notification is about (e.g. `"notice"`, `"homework"`, `"submission"`, `"reportCard"`, `"ptm"`, `"message"`, `"fee"`).
- `entityId` — that object's id, so the app opens it directly.

`dispatchNotification` derives this from `variables` (callers pass `entityType`/`entityId` alongside the interpolation vars) and the **`push.adapter.ts` puts it in the FCM/APNs `data` block** (not just `notification`), since only `data` survives into the app's tap handler when the app is backgrounded. **MOB PRP-60 deep-links on `{ entityType, entityId }`**; the same triple is stored/returned on the IN_APP feed item (§3.4a) so a feed tap and a push tap route identically. Document this triple as the fixed push/feed contract MOB-60 mirrors (the §7.6 contract discipline).

### 3.5 APIs (module split — `src/modules/notification/{routes,controller,service,schema,types}.ts`)
All `successResponse`/`errorResponse`; school-scoped reads forced to `request.schoolContext.schoolId` (PRP-12, never trust client `schoolId`):
| Method & path | Guard | Purpose |
|---|---|---|
| `GET /notifications/feed?status=&cursor=` · `GET /notifications/feed/unread-count` · `POST /notifications/feed/:deliveryLogId/read` · `POST /notifications/feed/read-all` | `fastify.authenticate` | the caller's own in-app feed + unread count + mark-read (§3.4a) — forced to the session `userId`; FE-58/MOB-60 consume it |
| `POST /notifications/push-tokens` | `fastify.authenticate` | register an FCM/APNs token (`{token, platform, deviceId?}`) for the current user (mobile PRP-60 + web) — upsert on `token` |
| `DELETE /notifications/push-tokens/:token` | `fastify.authenticate` | unregister on logout/uninstall |
| `GET /notifications/preferences` | `fastify.authenticate` | the current user's `ChannelPreference` matrix for the active school (defaults filled in) |
| `PUT /notifications/preferences` | `fastify.authenticate` | upsert category×channel toggles for self (cannot disable `IN_APP`) |
| `GET /developer/notification-templates` / `POST` / `PUT /:id` / `DELETE /:id` | `fastify.authorizeDeveloper` | SuperAdmin CRUD of **global** templates (the catalog ⚠︎ O-P6) — registered under the developer plugin |
| `GET /school/notification-templates` / `PUT /:eventKey/:channel` | `requirePermission('notification.template.manage')` | school-admin **override** of a global template for their school only |
| `GET /school/notifications/delivery-log?eventKey=&channel=&status=&from=&to=&cursor=` | `requirePermission('notification.log.read')` | admin delivery audit, **forced** to their `schoolId`, cursor-paginated newest-first |

`notification.template.manage` / `notification.log.read` are new permission keys — added to PRP-17's seed map (the permission-string contract; FE PRP-58 mirrors them).

### 3.6 Config (`src/config/shared-env.ts`)
Add (mirror PRP-15's env pattern — `sharedEnvProperties`/`AppConfig`/`readSharedEnv()`): `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY` (push); `SMS_PROVIDER`/`SMS_API_KEY`/`SMS_SENDER_ID` (⚠︎ O-P6, optional — absent ⇒ SMS skips); `WHATSAPP_PROVIDER`/`WHATSAPP_API_KEY`/`WHATSAPP_ENABLED` (default `false`, ⚠︎ O-P6); `NOTIFICATION_DEFAULT_LOCALE` (default `"en"`). Email reuses the existing `BREVO_API_KEY`/`SENDER_EMAIL`/`SENDER_NAME`. Every channel's adapter is **off-by-skip** when its keys are absent — the engine never hard-fails on a missing provider.

### 3.7 PRP-40 migration (the documented swap)
PRP-40 shipped `src/modules/notification-min/notifier.ts` (`MinimalAttendanceNotifier`) behind an `AttendanceNotifier` interface, with `dispatchAbsenceAlerts(...)` as the only caller. This PRP:
1. Adds an adapter binding so `dispatchAbsenceAlerts` calls `dispatchNotification(fastify, { eventKey: 'attendance.absence', category: 'ATTENDANCE_ABSENCE', schoolId, recipients, variables, dedupeKey: \`attendance.absence:${studentId}:${date}\` })` instead of the minimal notifier.
2. Maps PRP-40's `(student, date)` ledger de-dupe onto the engine's `dedupeKey` idempotency. The key `attendance.absence:${studentId}:${date}` is shared across the student's guardians; the **per-`(dedupeKey, userId, channel)`** unique (§3.2) means **each guardian** still gets their own alert (one row apiece) while a re-sync de-dupes per guardian — correct fan-out, no double-send. (The `AttendanceAlert` ledger can stay as the attendance-domain record.) 
3. Seeds the `attendance.absence` templates (EMAIL now; SMS/PUSH when configured) — replacing PRP-40's inline email template path with a `NotificationTemplate` row (or keep the Brevo template and have the email adapter reference it).
4. **`dispatchAbsenceAlerts`'s signature is unchanged** — only its body re-points at the engine, exactly as PRP-40 §3.2's migration note promised. `src/modules/notification-min/` can then be deleted (or left as a thin shim) — note it as cleanup.

### 3.8 Audit (PRP-18)
`writeAudit('notification.dispatch', …)` per dispatch (counts only); `notification.template.update` on template CRUD/override; `push_token.register`/`push_token.revoke` optional. Metadata = identifiers + counts, **never** message bodies or contact values (PRP-18 PII note).

## 4. Implementation steps
1. **Schema:** add the four models + `NotificationChannel`/`DeliveryStatus` enums to `prisma/schema.prisma`; `pnpm exec prisma migrate dev --name notification_engine` then `pnpm prisma:generate` (types import from `src/generated/prisma/enums.js`).
2. **Adapter interface + registry:** add `src/modules/notification/adapters/channel-adapter.ts` (interface) + `adapter-registry.ts`.
3. **Email adapter (real):** `email.adapter.ts` wrapping the existing `emailTemplateService`/`emailService` — the one working channel.
4. **Push adapter:** `push.adapter.ts` (FCM/APNs via `firebase-admin`); resolve + prune `PushToken`s. Add `firebase-admin` to deps.
5. **SMS + WhatsApp adapters (stubbed/config-gated):** `sms.adapter.ts` + `whatsapp.adapter.ts` — `isConfigured()` gates real send; unconfigured ⇒ `SKIPPED`+log (⚠︎ O-P6, no vendor commit).
6. **Template renderer:** a tiny `render(template, variables)` (dependency-free `{{var}}` interpolation, no eval) in `notification.render.ts`.
7. **Dispatcher:** `notification.service.ts` with `dispatchNotification` (template resolve→render→preference check→adapter send→`DeliveryLog`→`writeAudit`), template/preference resolvers, the **per-`(dedupeKey, userId, channel)`** idempotency check (§3.4 step 5), and the `{ eventKey, entityType, entityId }` payload derivation (§3.4b) carried into push + the IN_APP feed row.
8. **APIs:** `notification.routes.ts`/`controller.ts`/`schema.ts`/`types.ts` — the **self-serve in-app feed + unread-count + mark-read/read-all** (§3.4a, forced to session `userId`), push-token register/unregister, preference get/put, delivery-log read (school-scoped, PRP-12); register school-scoped routes under PRP-12's plugin; template CRUD under the developer plugin (SuperAdmin) + the school-override route.
9. **Permissions:** add `notification.template.manage` + `notification.log.read` to PRP-17's seed map.
10. **Config:** add the `FCM_*`/`SMS_*`/`WHATSAPP_*`/`NOTIFICATION_DEFAULT_LOCALE` keys to `shared-env.ts`.
11. **PRP-40 swap (§3.7):** re-point `dispatchAbsenceAlerts` at `dispatchNotification`; seed `attendance.absence` templates; retire/shim `notification-min`.
12. **Schemas/Swagger:** Fastify JSON schemas for every route (`successResponse` envelope); document the delivery-log content shape.

## 5. Files added / changed
- **Add:** `src/modules/notification/notification.service.ts`, `notification.render.ts`, `notification.routes.ts`, `notification.controller.ts`, `notification.schema.ts`, `notification.types.ts`, `src/modules/notification/adapters/{channel-adapter,adapter-registry,email.adapter,push.adapter,sms.adapter,whatsapp.adapter}.ts`
- **Edit:** `prisma/schema.prisma` (+ migration), `src/config/shared-env.ts` (channel provider keys), PRP-17's permission seed (two new keys), PRP-12's school-scoped plugin registration (scoped routes), the developer plugin (template-CRUD route), PRP-40's `dispatchAbsenceAlerts` (re-point to the engine) + `src/modules/notification-min/` (retire/shim), `package.json` (`firebase-admin`, optional SMS/WA SDK), optionally `src/modules/email/email-template.registry.ts` (if a Brevo template backs the email adapter)

## 6. Acceptance criteria
- [ ] The four models + `NotificationChannel`/`DeliveryStatus` enums exist with the documented uniques/indexes; `DeliveryLog`/`PushToken` have **no FK** to User/School (survive deletes — PRP-18 rule).
- [ ] `dispatchNotification` resolves a school override over a global template, renders `{{variables}}`, checks each recipient's `ChannelPreference` (default-on; `IN_APP` non-disable-able), calls each **configured** adapter, and writes one `DeliveryLog` per channel attempt (`SENT`/`SKIPPED`/`FAILED`).
- [ ] **Per-recipient dedupe:** the `DeliveryLog` unique is `@@unique([dedupeKey, userId, channel])` — a fan-out with one shared `dedupeKey` writes one row per recipient (not just one total); a replay to the **same** recipient/channel is the no-op. (Proven by a multi-recipient fan-out test: every recipient gets a row; a re-dispatch adds none.)
- [ ] **In-app feed:** a recipient can `GET /notifications/feed` (their own IN_APP `DeliveryLog` rows, forced to session `userId`), see an unread count, and mark items read (`readAt`); `IN_APP` is always-on so the feed never misses a message even when push/email are muted.
- [ ] **Push deep-link payload:** every PUSH send (and the IN_APP feed item) carries `{ eventKey, entityType, entityId }` in the FCM/APNs `data` block, so MOB-60 can route a tap to the entity.
- [ ] **Email adapter** calls `emailService.send({ to, subject, htmlContent, textContent })` with the engine-rendered `{subject, body}` — **not** `emailTemplateService.sendTemplate` (which only takes registered template keys).
- [ ] An **unconfigured** channel (no SMS/WhatsApp/FCM keys) is `SKIPPED` cleanly — the engine never throws on a missing provider; email works end-to-end via the existing Brevo module.
- [ ] WhatsApp is **registered but disabled** (`WHATSAPP_ENABLED=false` default) and `SKIPPED` until a BSP + approved templates are configured — flippable by config alone (⚠︎ O-P6).
- [ ] A user can register/unregister a push token; `GET/PUT /notifications/preferences` reads/updates the category×channel matrix for the active school; `IN_APP` cannot be turned off.
- [ ] SuperAdmin CRUDs global templates; a school admin overrides one for their school only; a school admin reads **only their school's** `DeliveryLog` (a client `schoolId` can't widen it — PRP-12).
- [ ] PRP-40's `dispatchAbsenceAlerts` dispatches **through the engine** with no signature change to its callers; the `attendance.absence` email still sends; a re-sync does not re-send (engine `dedupeKey`).
- [ ] `dispatchNotification` never throws into a caller's path; each dispatch writes a `notification.dispatch` audit entry (counts only, no bodies — PRP-18).

## 7. Validation
- `pnpm typecheck && pnpm lint:check && pnpm build`
- `pnpm exec prisma migrate dev --name notification_engine` applies.
- Manual: seed a global `notice.published` EMAIL template; call `dispatchNotification` (script or via PRP-55) → confirm a Brevo email + a `SENT` `DeliveryLog`; toggle the recipient's EMAIL preference off → re-dispatch → a `SKIPPED` row, no email; with `FCM_*` set + a registered token, confirm a PUSH `DeliveryLog`; with SMS/WhatsApp unconfigured, confirm `SKIPPED` (no throw). Re-run PRP-40's absence flow → email still sends via the engine, a re-sync de-dupes; confirm a second school's admin can't read the first school's delivery log.

## 8. Risks & rollback
- ⚠︎ **O-P6 — SMS/WhatsApp vendor + template catalog are open.** Mitigated by the `ChannelAdapter` seam: the vendor is `SMS_PROVIDER`/`WHATSAPP_PROVIDER` + one adapter module + (for SMS/WA) provider-side **pre-approved templates** referenced via `providerTemplateRef`. WhatsApp ships **registered-but-disabled** (D9 fast-follow); SMS ships skip-until-configured. Resolving O-P6 = signing a vendor + filling config/templates, not a rewrite. The template **catalog** (which events × channels × copy) is seeded incrementally as 55/56/57 land.
- **DLT / WhatsApp template constraints:** Indian SMS (DLT) and WhatsApp **require pre-registered/approved templates** — free-form sends are rejected. The engine models this with `providerTemplateRef`; document that adding an SMS/WA channel for a new event needs a provider-approved template first (lead time).
- **No queue in v1:** dispatch is inline with bounded per-adapter retry; a provider outage marks `DeliveryLog=FAILED` for the operator to re-drive. If volume/latency grows (hot paths like attendance fan-out across a class), move dispatch behind a job/queue (reuse PRP-05's job pattern, or BullMQ) — keep `dispatchNotification` as the single seam so the async move doesn't touch callers. Flagged as the most likely scale follow-up.
- **PII / privacy:** `DeliveryLog.error` and audit metadata must carry **identifiers + status only**, never message bodies or raw contacts (PRP-18 rule); push tokens are sensitive — store as-is but never log them; clear a user's `PushToken`s on logout (mobile PRP-60 / web).
- **Push-token hygiene:** stale FCM/APNs tokens must be pruned (provider "unregistered" → set `revokedAt`) or push silently rots; the push adapter handles the provider's not-registered response.
- **Preference default direction:** v1 defaults **opt-in** (no row ⇒ enabled) so absence/result alerts reach parents who never touched settings; transactional/critical categories (e.g. `SYSTEM`, security) should be **non-disable-able** like `IN_APP` — document which categories are mandatory so a user can't silence a legally/operationally required message.
- Rollback: additive — drop the four models + enums, revert the adapters/service/routes, and restore PRP-40's `MinimalAttendanceNotifier` binding (it's a one-line re-point back). Until 55/56/57 emit events, the engine is inert apart from the migrated absence alert.
