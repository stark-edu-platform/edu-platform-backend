# PRP-71 — Per-school branding / white-label (logo · theme · domain) ⚠︎

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟡 Low · **Size:** M (white-label-domain depth ⚠︎ can push to L)
> **Depends on:** PRP-16 (branding is **per-school**, keyed off the activated `School` + its `subdomain`/`ownerUserId`; the lifecycle/onboarding flow is where a school first gets an identity) **— this PRP extends PRP-16's per-school surface**, PRP-12 (school context — branding resolves per tenant), PRP-17 (`branding.manage` permission — Admin-only), PRP-15 (`requireWritableSchool` on writes — but a **locked** school's public branding/login page must still render, §3.1.4), PRP-18 (`writeAudit` — branding + domain changes are audited), PRP-46 (the `src/lib/storage` S3-compatible abstraction already stood up for receipts — **reuse it** for logo uploads; do not add a second uploader); FE PRP-10/11 (abilities/guards), PRP-24 (`<WriteGate>` + the existing theme tokens), the existing FE theme system (`tailwind.config.ts` tokens `bg-base`/`text-text`/`bg-surface` + `src/styles/tokens.scss`) · **Feeds:** PRP-72 (branding supplies the logo/colors a school's exported report PDFs + dashboards are skinned with), PRP-46/51/66 (generated PDFs — receipts/report-cards/certificates — stamp the school logo + name from here)

## 1. Problem / current state
The platform has no per-school branding. `School` (`prisma/schema.prisma:70-89`, extended by **PRP-16**) carries `name`/`subdomain`/`board` but **no logo, no theme, no custom-domain mapping**. Every school sees the same default FE theme (`tailwind.config.ts` tokens + `tokens.scss`), the SuperAdmin/login surfaces are unbranded, and generated PDFs (receipts PRP-46, later report-cards PRP-51, certificates PRP-66) have nowhere to read a school logo from. master §10 **O-P8 explicitly flags white-label depth (domain, logo, theme)** as the open question for this module, and master §6/§10 (O-P8) lists "per-school branding" as a P8 deliverable.

This PRP adds a small `Branding` record per school + a public branding-resolution endpoint + FE theme application, and **scopes the hard part (custom domain) behind the O-P8 flag** with a clear seam rather than building DNS/TLS automation now.

> ⚠︎ **O-P8 (white-label depth — the named open question):** master §10 leaves logo/theme/**domain** depth open. **Assumptions (inline, flagged ⚠︎), tiered so the cheap tier ships and the expensive tier is gated:**
> - **Tier 1 — logo + theme + name (in scope, low risk):** a school sets a logo, a small set of brand colors (primary/accent + light/dark surface), and display name/tagline. Applied to the FE shell and stamped on generated PDFs. This is the v1 white-label.
> - **Tier 2 — subdomain branding (in scope):** the existing `School.subdomain` (already unique, PRP-16) is the school's address (`<sub>.platform.tld`); branding resolves by subdomain. No new infra — it's already the deployment model (memory: FE+BE share one registrable domain).
> - **Tier 3 — custom domain (DEFERRED, seam only ⚠︎):** mapping `school.example.edu` to a tenant needs DNS verification + TLS cert issuance + host→school resolution + the refresh-cookie domain story (memory: cookie is `SameSite=Lax` on **one** registrable domain — a true custom domain breaks that and needs per-domain cookie/CORS handling). This PRP **models** a `customDomain` field + a `domainStatus` (PENDING/VERIFIED/ACTIVE) and documents the verification/cert/cookie work, but **builds no DNS/ACME automation** and leaves `domainStatus` operationally SuperAdmin-driven until O-P8 resolves. Flagged ⚠︎ at every touch-point.

## 2. Goal & non-goals
- **Goal — Backend:** a `src/modules/branding/` module owning a `SchoolBranding` (1:1 per `School`: `logoFileKey`, `faviconFileKey`, brand colors, display name/tagline, `customDomain?`, `domainStatus`) — Admin CRUD (Tier 1+2), a **public** `GET /api/public/branding?subdomain=` (or `?host=`) that resolves a tenant's branding **without auth** so the login/landing page can skin itself before sign-in, logo upload via the **existing PRP-46 `src/lib/storage`** abstraction, and a `customDomain` field + `domainStatus` enum modeled (Tier 3) **without** DNS/TLS automation. Generated-PDF helpers (PRP-46/51/66) read the logo + name from here.
- **Goal — Frontend:** a **Branding settings** screen for the school Admin (upload logo/favicon, pick brand colors with a live preview, set display name/tagline; a Tier-3 custom-domain panel that is **informational/SuperAdmin-gated**), and a **theme-application layer** that fetches the active school's branding and maps it onto the existing CSS-variable/Tailwind-token system (`bg-base`/`bg-surface`/brand color) + the logo in the shell header and the (public) login page. All via a new `src/store/branding/` slice.
- **Non-goals:** DNS verification / TLS certificate issuance / per-custom-domain cookie+CORS handling (Tier 3 ⚠︎ — modeled + documented, not built); a full theme **builder** (font uploads, arbitrary CSS, component-level theming) — v1 is a constrained color set + logo so it can't break the UI; per-role or per-page theming; email-template branding beyond the logo (the Brevo templates already exist — wiring the logo there is a follow-up note); the group/Trust-level brand inheritance (D12 — `School.groupId` reserved; group branding is a future seam). The analytics skinning (PRP-72) **reads** this; it does not own it.

## 3. Target design

### 3.1 Backend

#### 3.1.1 Schema (`prisma/schema.prisma`) — additive, 1:1 with School
```prisma
enum DomainStatus { NONE PENDING VERIFIED ACTIVE }                   // Tier 3 — operationally SuperAdmin-driven in v1 (⚠︎)

model SchoolBranding {
  schoolBrandingId String   @id @default(uuid())
  schoolId         String   @unique                                  // 1:1 per school
  displayName      String?                                           // overrides School.name on branded surfaces
  tagline          String?
  logoFileKey      String?                                           // S3 key via PRP-46 src/lib/storage
  faviconFileKey   String?
  // Tier 1 theme — a constrained color set (hex strings), NOT arbitrary CSS (can't break the UI)
  primaryColor     String?                                           // "#1d4ed8" — maps to the brand/accent token
  accentColor      String?
  surfaceColor     String?                                           // maps to bg-surface token
  baseColor        String?                                           // maps to bg-base token
  // Tier 3 custom domain — MODELED ONLY (⚠︎ no DNS/TLS automation in v1)
  customDomain     String?  @unique                                  // "portal.myschool.edu" (resolution seam)
  domainStatus     DomainStatus @default(NONE)
  domainVerifyToken String?                                          // TXT-record token a future verifier would check
  school           School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@index([schoolId])
}
```
Add `branding SchoolBranding?` back-relation to `School`. No `Student` edit (school-level, not per-student) — touches only the `School` back-relation (§8). Colors are stored as plain hex strings and **validated** (regex `^#[0-9a-fA-F]{6}$`) at the schema layer so a bad value can never reach the FE token mapping.

> **Decision — constrained theme, not a CSS builder (⚠︎ O-P8 Tier discipline):** branding is a **small fixed set of color tokens + a logo**, applied by overriding the **existing** CSS variables the FE theme already uses (`tailwind.config.ts` tokens + `tokens.scss`) — not arbitrary CSS, not font uploads, not per-component theming. This keeps white-label cheap, safe (a school can't break its own layout), and consistent with the existing design-token system. Custom domain (Tier 3) is the genuinely hard, infra-heavy part and is **modeled but deferred** (the field + status + verify-token reserve the surface) — the operational steps (DNS TXT verification → ACME/managed cert → host→school resolution → per-domain cookie `Domain`/CORS) are documented in §8 as the work O-P8 unlocks.

#### 3.1.2 Module layout (`src/modules/branding/`)
`branding.routes.ts` / `branding.controller.ts` / `branding.service.ts` / `branding.schema.ts` / `branding.types.ts`. Service `fastify`-first; reuses `src/lib/storage` (PRP-46) for logo/favicon `putObject`/`getSignedUrl`. Enums from `src/generated/prisma/enums.js`.

#### 3.1.3 Services & routes
`branding.service.ts` exports:
- **`getBranding(fastify, schoolId)`** — the school-scoped read (Admin settings).
- **`upsertBranding(fastify, schoolId, data)`** — 1:1 upsert of display name/tagline/colors (validated hex). Audited.
- **`getLogoUploadTarget(fastify, schoolId, kind)`** + **`setLogoKey(fastify, schoolId, kind, fileKey)`** — logo/favicon flow via `src/lib/storage` (PRP-46): either a signed-PUT target the FE uploads to, or a direct multipart endpoint that calls `putObject` — pick the same approach PRP-46 used for receipts and reuse it; store the returned key.
- **Public resolution — `resolvePublicBranding(fastify, { subdomain?, host? })`** — returns the **safe public subset** (display name, tagline, logo URL, colors) for a tenant, resolved by `subdomain` (Tier 2) or, when Tier 3 lands, by `host`→`customDomain`. **No auth, no PII, read-only**, cache-friendly (short TTL / ETag) — this is what the unauthenticated login page calls to skin itself.
- **Tier 3 (modeled) — `setCustomDomain(fastify, schoolId, domain)`** (Admin requests it → `domainStatus: PENDING`, generates `domainVerifyToken`) and `setDomainStatus(fastify, schoolId, status)` (**SuperAdmin/developer-only**, operationally flips PENDING→VERIFIED→ACTIVE in v1 since there is no automated verifier). Both audited; **documented as inert beyond status bookkeeping until O-P8** (no DNS/TLS side effects).
- **PDF/email branding accessor — `getBrandingForArtifacts(fastify, schoolId)`** — a tiny read the PRP-46/51/66 PDF templates call to stamp the logo + display name (so generated documents are branded).

Routes:
- **Public (no auth, top-level `/api/public/*` alongside PRP-16's `/schools/request`):** `GET /api/public/branding?subdomain=` (and `&host=` when Tier 3 lands). Rate-limited (reuse PRP-01).
- **School-scoped (Admin):** `GET|PUT /api/school/branding` (`branding.manage` for write, `branding.read` for read) + logo upload route; `requireWritableSchool` on writes **except** that branding must remain editable enough for an Admin to fix a broken theme (it is part of the "Admin can always reach settings/billing" fail-safe spirit — but a fully LOCKED school may legitimately be write-blocked; default to `requireWritableSchool` and note the choice).
- **Developer (SuperAdmin):** `POST /api/developer/schools/:id/domain-status` (Tier 3 manual flip) under the existing developer plugin guard.

All responses use `successResponse`/`errorResponse`.

#### 3.1.4 Public-render fail-safe
The **public branding endpoint and the login/landing page must render for a school in any status** (PENDING/READ_ONLY/LOCKED/SUSPENDED) — branding is the *front door*, so resolution must not be gated by subscription/lifecycle state (mirrors PRP-16's fail-safe that auth/billing stay reachable). Only the **editing** of branding is write-gated; **reading/serving** it is always allowed.

#### 3.1.5 Permission strings (extends PRP-17)
| Resource | Actions | ADMIN | STAFF | TEACHER | STUDENT | PARENT |
|----------|---------|:-----:|:-----:|:-------:|:-------:|:------:|
| `branding` | `read`, `manage` | read, manage | – | – | – | – |

Branding is **Admin-only** (it is school-identity/legal-presentation, like billing). The Tier-3 `domain-status` flip is **SuperAdmin-only** (developer plugin), not in the school matrix. The public resolution endpoint needs **no** permission (it's unauthenticated by design).

#### 3.1.6 Audit (PRP-18)
`writeAudit()` on `upsertBranding`, logo change, `setCustomDomain`, and `setDomainStatus`. Metadata: the changed fields' identifiers (e.g. `{ field: 'primaryColor' }`, `{ customDomain }`) — colors/keys are not sensitive PII, but keep it concise.

### 3.2 Frontend
House conventions (PRP-43/47): UI in `src/modules/branding/`, state/API in `src/store/branding/` (`*.store.ts`/`*.services.ts`/`*.type.ts`), TanStack Query (PRP-09), routes from **`APP_ROUTES`**, `helper.*`, `cn()`, writes gated by `<WriteGate>` (PRP-24) + `<Can>` (PRP-11).

- **Routes (`src/constants/routes.ts`):** add `APP_ROUTES.school.branding` → `/school/branding` (an Admin settings page; fits the existing `(school)/school` settings area).
- **State & services (`src/store/branding/`):** `branding.type.ts` mirrors `SchoolBranding` + `DomainStatus` verbatim (reuse `SchoolRole`/`PermissionKey` from PRP-10). `branding.services.ts` via `apiClient` + `helper.*`: `fetchBranding()`, `saveBranding(data)`, `uploadLogo(file, kind)` (via the PRP-46 storage flow), `requestCustomDomain(domain)`; plus a **public** `fetchPublicBranding(subdomain|host)` that does **not** require the auth interceptor (it must work pre-login — call the public endpoint directly).
- **Theme-application layer (the load-bearing FE piece):**
  - A `BrandingProvider` (in `src/lib/providers.tsx` alongside the existing TanStack Query provider, or a dedicated provider) that, on app load / active-school resolution, fetches branding and writes the brand colors onto the **existing CSS variables** the theme already reads (the `tokens.scss` / `tailwind.config.ts` token vars — set them on `:root`/a wrapper via inline `style` custom properties). This **reuses** the existing token system (CLAUDE.md: "styling uses Tailwind theme tokens + SCSS tokens") rather than introducing a parallel theme mechanism — the key design constraint.
  - The **login/landing page** (public, `(auth)/`) reads `fetchPublicBranding()` by subdomain so an unauthenticated visitor sees the school's logo + colors before signing in (the fail-safe in §3.1.4). Falls back to the default theme if resolution fails.
  - The shell header logo (the `DefaultLayout`/`MainWrapper`) reads the active school's `logoFileKey` URL.
- **UI module (`src/modules/branding/`):**
  - `BrandingSettings.tsx` (page `(school)/school/branding/page.tsx`, thin) — logo + favicon upload (preview), brand-color pickers with a **live preview** of a sample card/button using the token mapping, display name/tagline fields, `<WriteGate>`-gated Save.
  - A **Custom-domain panel** inside it (Tier 3) — lets an Admin enter a domain and shows the `domainStatus` + the DNS TXT instructions (the `domainVerifyToken`), clearly labelled "**verification handled by the platform team**" (since v1 has no automated verifier — the SuperAdmin flips status). Informational, ⚠︎-flagged in the UI copy.
- **Menu + guards (`src/constants/project.menu.ts`, PRP-11/25):** add a **Branding** entry under the Admin settings group (`branding.manage`); visibility from `deriveAbilities` (PRP-10).

## 4. Implementation steps
1. **Backend — schema:** add `DomainStatus` + `SchoolBranding` (+ `School` back-relation); hex-color validation in the Fastify schema. `pnpm exec prisma migrate dev --name school_branding` then `pnpm prisma:generate`.
2. **Backend — module:** add `src/modules/branding/{routes,controller,service,schema,types}.ts`; implement `getBranding`/`upsertBranding`, the logo flow via `src/lib/storage` (PRP-46), `resolvePublicBranding`, the Tier-3 `setCustomDomain`/`setDomainStatus` (status bookkeeping only), and `getBrandingForArtifacts`.
3. **Backend — routing + guards:** register the **public** `/api/public/branding` (no auth, rate-limited, status-agnostic per §3.1.4) alongside PRP-16's public routes in `src/plugins/index.ts`; the Admin `/api/school/branding` subtree under `school.plugin.ts` (`branding.read`/`branding.manage` + `requireWritableSchool` on write); the developer `domain-status` route under the developer plugin.
4. **Backend — permissions + audit:** add `branding.*` to PRP-17 + default role map (Admin-only); `writeAudit()` on branding + domain changes.
5. **Backend — PDF accessor:** add `getBrandingForArtifacts` and note the call site in PRP-46's receipt template (and reserve it for PRP-51/66) so generated PDFs stamp the logo + name.
6. **Backend — schemas/types:** Fastify JSON schemas + types; enums from `src/generated/prisma/enums.js`.
7. **Frontend — routes/types/services:** add `branding` to `APP_ROUTES.school`; add `src/store/branding/{branding.type,branding.services}.ts` (including the auth-free `fetchPublicBranding`).
8. **Frontend — theme layer:** add the `BrandingProvider` that maps brand colors onto the **existing** token CSS variables; wire the public login page + shell header logo to branding; default-theme fallback.
9. **Frontend — UI:** add `BrandingSettings.tsx` (+ thin page) with logo upload, color pickers + live preview, and the Tier-3 informational custom-domain panel; `<WriteGate>`/`<Can>` on Save.
10. **Frontend — menu/guards:** add the permission-tagged Branding entry to `project.menu.ts` (via `APP_ROUTES`, PRP-11).

## 5. Files added / changed
- **Backend — add:** `src/modules/branding/branding.routes.ts`, `branding.controller.ts`, `branding.service.ts`, `branding.schema.ts`, `branding.types.ts`
- **Backend — edit:** `prisma/schema.prisma` (+ migration), `src/plugins/index.ts` (public branding route), `src/plugins/school.plugin.ts` (Admin branding subtree), the developer plugin/module (Tier-3 domain-status route, full surface in PRP-20's spirit), `src/modules/authz/permissions.ts` (PRP-17 — add `branding.*`), and a `getBrandingForArtifacts` call site note in the PRP-46 PDF template
- **Frontend — add:** `src/store/branding/branding.type.ts`, `src/store/branding/branding.services.ts`, `src/modules/branding/BrandingSettings.tsx`, `src/app/(school)/school/branding/page.tsx`, a `BrandingProvider` (in/near `src/lib/providers.tsx`), optional `src/store/branding/branding.queries.ts`
- **Frontend — edit:** `src/constants/routes.ts` (branding route), `src/constants/project.menu.ts` (Branding entry), `src/lib/providers.tsx` (mount `BrandingProvider`), the login page (`(auth)/`) + shell layout (logo + token application)

## 6. Acceptance criteria
- [ ] `SchoolBranding` (1:1 per school) + `DomainStatus` exist; colors validated as hex; `customDomain` unique; `School` back-relation added; no `Student` edit.
- [ ] An Admin can set display name/tagline/colors and upload a logo + favicon (stored via the **existing PRP-46 `src/lib/storage`**, not a second uploader); changes are audited.
- [ ] `GET /api/public/branding?subdomain=` returns the safe public subset (name/tagline/logo URL/colors) **without auth** and renders for a school in **any** lifecycle status (PENDING/READ_ONLY/LOCKED), so the login page is branded pre-sign-in.
- [ ] The FE applies brand colors by overriding the **existing** theme token CSS variables (no parallel theme system) and shows the school logo in the shell + login page; a resolution failure falls back to the default theme.
- [ ] Generated PDFs (PRP-46 receipt at minimum) can stamp the school logo + display name via `getBrandingForArtifacts`.
- [ ] Tier 3 (custom domain) is **modeled** (`customDomain`/`domainStatus`/`domainVerifyToken`) with an Admin request + SuperAdmin status flip, and is clearly documented/labelled as **no automated DNS/TLS in v1** (⚠︎ O-P8) — no DNS/cert side effects are built.
- [ ] `branding.manage` is Admin-only; the public endpoint needs no permission; tenant-scoped throughout.
- [ ] The ⚠︎ O-P8 white-label tiering (Tier 1+2 in scope, Tier 3 deferred-with-seam) is recorded with the custom-domain cookie/CORS/cert work documented.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; `pnpm exec prisma migrate dev --name school_branding` applies cleanly.
- **Frontend:** `yarn type-check && yarn lint && yarn build`.
- **Manual:** as an Admin, set a primary color + upload a logo → the shell reskins; open the login page for that subdomain unauthenticated → it shows the logo + colors; lock the school (PRP-15) → the public branding/login still renders; request a custom domain → status shows PENDING with the TXT token; as SuperAdmin flip it to VERIFIED; confirm a bad hex color is rejected by the schema.

## 8. Risks & rollback
- **Custom domain is the iceberg (⚠︎ O-P8 — the named open question):** Tier 3 is **modeled but not built**. The real work O-P8 unlocks, documented here so it isn't underestimated: (1) **DNS verification** (issue a TXT token, verify ownership); (2) **TLS** (ACME/Let's Encrypt or a managed cert per domain, plus renewal); (3) **host→school resolution** (a middleware that maps the incoming `Host` to a `schoolId`, replacing/augmenting subdomain resolution); (4) **the auth-cookie story** — the refresh cookie is `SameSite=Lax` on **one** registrable domain (memory: deployment-topology); a true custom domain is a *different* registrable domain, so the cookie + CORS `ALLOWED_ORIGINS` + `credentials:true` must be handled per-domain (this is the subtle, security-sensitive part — get it wrong and you either break login or leak cookies cross-domain). Build none of this now; the field/status/token reserve the surface and the SuperAdmin flip is the manual stand-in.
- **Theme must reuse the existing token system (load-bearing):** apply colors by overriding the **existing** `tailwind.config.ts`/`tokens.scss` CSS variables — do **not** introduce a parallel theming mechanism (CLAUDE.md convention). A constrained, validated color set (no arbitrary CSS) means a school can't break its own UI; this constraint is the safety boundary and the central review checkpoint.
- **Public-render fail-safe:** branding resolution + the login page must render in every school status (it's the front door) — never gate the public endpoint behind subscription/lifecycle state (mirrors PRP-16's auth/billing fail-safe). Only *editing* is write-gated.
- **Reuse PRP-46 storage:** logos go through the existing `src/lib/storage` abstraction — adding a second uploader/storage path is the anti-pattern to reject in review.
- **`School` back-relation only (§8):** like PRP-70, this touches only `School` (no `Student`), so it's outside the shared-`Student`-edit coordination — but rebase the `School` block cleanly against concurrent P8 migrations.
- **Group branding deferred (D12):** `School.groupId` is reserved; group/Trust-level brand inheritance is a future seam — note it, build nothing.
- **Far-future / low severity:** Tier 1+2 is a small, safe add; Tier 3 stays gated behind O-P8.
- **Rollback:** additive module + one table on both repos; revert the modules, drop `SchoolBranding`, drop the `School` back-relation. The `BrandingProvider` falls back to the default theme if the store/endpoint is reverted; the catch-all reclaims `/school/branding`.
