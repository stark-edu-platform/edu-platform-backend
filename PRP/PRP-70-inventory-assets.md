# PRP-70 — Inventory / assets (register · issue · track) ⚠︎

> **Status:** Proposed · **Phase:** 8 · **Repo:** BE+FE · **Severity:** 🟡 Low · **Size:** M
> **Depends on:** PRP-16 (assets belong to an activated `School` — inventory is per-school, like branding; D12 group-ready), PRP-12 (school context / tenant scoping), PRP-17 (`asset.*` permissions), PRP-15 (`requireWritableSchool` on writes), PRP-18 (`writeAudit` — asset issue/return/disposal are audited stock movements), PRP-30 (assets are issued to staff/teachers — `UserSchool`/staff profiles are the holder; departments help categorize custody); FE PRP-10 (abilities/`activeSchoolId`), PRP-11 (permission menu/guards), PRP-24 (`<WriteGate>` + subscription banner) · **Feeds:** PRP-72 (an inventory block in analytics — stock-on-hand / asset-value / low-stock counts)

## 1. Problem / current state
The platform has no inventory or fixed-asset management. Schools track **consumables** (stationery, lab/cleaning supplies — quantities that go up on purchase and down on issue) and **fixed assets** (computers, projectors, furniture, lab equipment — discrete items issued to a person/room/department and tracked to disposal). Today nothing models a stock item, a stock movement, or an asset's custody chain: there is no `Item`/`Asset`/`StockMovement`/`AssetAssignment`. `School` (`prisma/schema.prisma:70-89`, extended by **PRP-16** with lifecycle/owner/group) is the tenant anchor; `UserSchool` + staff profiles (**PRP-30**) are the people an asset can be issued to. This PRP adds a small, **far-future** stores/asset register on top of those.

> ⚠︎ **O-P8 (module priority + depth):** master §10 leaves Extended-module priority and the depth of each open. **Assumptions (inline, flagged ⚠︎):**
> - **Two item kinds in one model, not two systems:** an `Item` has a `kind` (`CONSUMABLE` | `FIXED_ASSET`). Consumables track a **quantity** via `StockMovement` rows (IN/OUT/ADJUST); fixed assets are **discrete `Asset` rows** (one per physical unit) issued via `AssetAssignment`. This is the lightest model that covers both Indian-K-12 store-room realities without two parallel modules.
> - **No procurement/PO/GRN, no vendor payments, no depreciation schedule in v1** — stock-in is a manual movement with an optional cost; asset value is a single recorded `purchaseCost` (no accounting depreciation math). Procurement and depreciation are explicit future seams.
> - **No barcode/RFID hardware integration** in v1 — an `assetTag`/`barcode` string field exists so a school can print/scan its own labels later, but no scanner integration.
> - **Custody = a `UserSchool`/staff member or a free-text location** (room/department) — no separate "location master" table in v1 (a `location` string suffices); a location master is a future seam.
> Resolving O-P8 may add tables (PO, depreciation, location master) — none restructure the core register below.

## 2. Goal & non-goals
- **Goal — Backend:** a `src/modules/inventory/` module owning: `ItemCategory` (per-school taxonomy), `Item` (catalog row, `kind` CONSUMABLE/FIXED_ASSET, unit, reorder level, current quantity for consumables), `StockMovement` (IN/OUT/ADJUST against a consumable `Item`, with quantity + optional unit cost + reason + actor), `Asset` (a discrete fixed-asset unit: `assetTag`, serial, `purchaseCost`, `condition`, `status` IN_STORE/ISSUED/UNDER_REPAIR/DISPOSED), and `AssetAssignment` (issue→return custody history: asset, holder `UserSchool` or location, issuedAt/returnedAt). Services for catalog CRUD, stock receive/issue/adjust (atomic quantity update), low-stock report, asset register CRUD, asset issue/return, and the per-asset history. All tenant-scoped + role-gated + audited.
- **Goal — Frontend:** an **Inventory** area for storekeepers/admins — an **items list** (consumables with stock level + low-stock badge, assets with status), an **item detail** with the stock-movement ledger (consumables) or the assignment history (assets), a **receive/issue/adjust** stock action, and an **asset register** view with issue/return. All via a new `src/store/inventory/` slice.
- **Non-goals:** procurement (PO/GRN/quotations), vendor/supplier payments, accounting depreciation, barcode/RFID scanner integration, a location-master table, transport-vehicle assets (PRP-64 owns `Vehicle`), library books (PRP-65 owns `Book`/`BookIssue` — a **parallel** issue/return model; do **not** route books through inventory) (all ⚠︎ O-P8 or owned elsewhere); the analytics rollup (PRP-72 reads these tables); any PDF artifact (none here — reuse PRP-46's `pdf`/`storage` libs later if a stock report PDF is wanted).

## 3. Target design

### 3.1 Backend

#### 3.1.1 Schema (`prisma/schema.prisma`) — additive, all tenant-scoped
```prisma
enum ItemKind        { CONSUMABLE FIXED_ASSET }
enum StockMovementType { IN OUT ADJUST }                              // receive / issue / correction
enum AssetStatus     { IN_STORE ISSUED UNDER_REPAIR DISPOSED LOST }
enum AssetCondition  { NEW GOOD FAIR POOR }

model ItemCategory {                                                 // per-school taxonomy (Stationery, Lab, IT, Furniture…)
  itemCategoryId String   @id @default(uuid())
  schoolId       String
  name           String
  items          Item[]
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())
  @@unique([schoolId, name])
  @@index([schoolId])
}

model Item {                                                         // catalog row (both kinds)
  itemId         String   @id @default(uuid())
  schoolId       String
  itemCategoryId String?
  name           String
  kind           ItemKind @default(CONSUMABLE)
  unit           String?                                             // "pcs", "box", "ream" (consumables)
  reorderLevel   Int?                                                // low-stock threshold (consumables)
  quantityOnHand Int      @default(0)                                // CONSUMABLE running stock; FIXED_ASSET ignores (assets are discrete rows)
  isActive       Boolean  @default(true)
  category       ItemCategory? @relation(fields: [itemCategoryId], references: [itemCategoryId], onDelete: SetNull)
  movements      StockMovement[]
  assets         Asset[]                                            // FIXED_ASSET units belonging to this catalog row
  school         School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([schoolId, name])
  @@index([schoolId])
  @@index([schoolId, kind])
}

model StockMovement {                                                // consumable quantity change (audit-grade ledger)
  stockMovementId String   @id @default(uuid())
  schoolId        String
  itemId          String
  type            StockMovementType
  quantity        Int                                                // always positive; `type` gives direction
  unitCost        Decimal? @db.Decimal(12, 2)                        // optional cost at receipt — Decimal, never float
  reason          String?                                           // "issued to Science dept", "stock-take correction"
  issuedToUserId  String?                                           // OUT: who received it (UserSchool/User)
  issuedToLocation String?                                          // OUT: or a room/department (no location master, ⚠︎)
  movedByUserId   String?                                           // storekeeper who recorded it
  item            Item     @relation(fields: [itemId], references: [itemId], onDelete: Cascade)
  school          School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt       DateTime @default(now())
  @@index([schoolId])
  @@index([itemId, createdAt])                                       // per-item ledger
}

model Asset {                                                        // a discrete fixed-asset unit
  assetId       String        @id @default(uuid())
  schoolId      String
  itemId        String?                                             // optional catalog link (model/type)
  assetTag      String?                                             // school-printed tag/barcode (⚠︎ no scanner integ.)
  name          String
  serialNo      String?
  purchaseCost  Decimal?      @db.Decimal(12, 2)                     // single recorded cost (no depreciation, ⚠︎)
  purchasedOn   DateTime?
  condition     AssetCondition @default(GOOD)
  status        AssetStatus   @default(IN_STORE)
  location      String?                                             // current room/dept when not issued to a person
  item          Item?         @relation(fields: [itemId], references: [itemId], onDelete: SetNull)
  assignments   AssetAssignment[]
  school        School        @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  @@unique([schoolId, assetTag])                                     // tag unique per school when present
  @@index([schoolId])
  @@index([schoolId, status])
}

model AssetAssignment {                                              // issue → return custody history
  assetAssignmentId String   @id @default(uuid())
  schoolId          String
  assetId           String
  holderUserId      String?                                         // issued to a person (UserSchool/User)…
  holderLocation    String?                                         // …or a room/department
  issuedAt          DateTime @default(now())
  returnedAt        DateTime?                                       // null = currently held
  conditionOut      AssetCondition?
  conditionIn       AssetCondition?
  note              String?
  issuedByUserId    String?
  asset             Asset    @relation(fields: [assetId], references: [assetId], onDelete: Cascade)
  school            School   @relation(fields: [schoolId], references: [schoolId], onDelete: Cascade)
  createdAt         DateTime @default(now())
  @@index([schoolId])
  @@index([assetId])
  @@index([assetId, returnedAt])                                     // "who holds it now"
}
```
Add back-relations to `School` (`itemCategories`, `items`, `stockMovements`, `assets`, `assetAssignments`). No `Student` edit needed (assets/stock are staff/operational, not per-student) — so this PRP is **not** part of the shared-`Student`-edit coordination (§8 below notes only the `School` back-relations).

> **Decision — quantity ledger + discrete assets (⚠︎ O-P8):** consumables keep a materialized `Item.quantityOnHand` that every `StockMovement` updates **inside one transaction** (the movement row is the immutable audit trail; the column is the cheap read). Fixed assets are **one `Asset` row per unit** with an `AssetAssignment` history — so "where is projector #PRJ-014" is one indexed read on the open assignment. Money fields (`unitCost`, `purchaseCost`) are `Decimal` (the PRP-44/46 discipline), serialized as strings; there is no depreciation math. This split mirrors the fees ledger pattern (PRP-46: compute → materialize → movement) so it is familiar to reviewers.

#### 3.1.2 Module layout (`src/modules/inventory/`)
`inventory.routes.ts` / `inventory.controller.ts` / `inventory.service.ts` / `inventory.schema.ts` / `inventory.types.ts`. If the file gets large, split assets into `assets.{routes,controller,service}.ts` co-located in the same module dir (the PRP-46 `fees/payments.*` co-location precedent). Service `fastify`-first, tenant-scoped; enums from `src/generated/prisma/enums.js`.

#### 3.1.3 Services & routes
`inventory.service.ts` exports (tenant-scoped):
- **Catalog:** `listCategories`/`createCategory`/`updateCategory`; `listItems(fastify, schoolId, { kind?, categoryId?, lowStockOnly?, search? })`, `getItem` (with recent movements / assets), `createItem`, `updateItem`.
- **Stock (consumables):** `receiveStock(fastify, schoolId, { itemId, quantity, unitCost?, reason? })`, `issueStock(fastify, schoolId, { itemId, quantity, issuedToUserId? | issuedToLocation, reason? })`, `adjustStock(fastify, schoolId, { itemId, quantity, reason })` — each in **one transaction**: insert the `StockMovement` and update `Item.quantityOnHand` (guard against negative on issue → `fastify.httpErrors.conflict('insufficient stock')`). `getItemLedger(itemId)` returns the movement history.
- **Low-stock report:** `getLowStock(fastify, schoolId)` — consumable `Item`s where `reorderLevel != null AND quantityOnHand <= reorderLevel`.
- **Assets (fixed):** `listAssets(fastify, schoolId, { status?, itemId?, search? })`, `getAsset` (with assignment history), `createAsset` (maps `P2002` on `assetTag` → `conflict`), `updateAsset`, `disposeAsset(assetId, reason)` (sets `status: DISPOSED`, audited).
- **Asset issue/return:** `issueAsset(fastify, schoolId, { assetId, holderUserId? | holderLocation, conditionOut? })` — opens an `AssetAssignment`, sets `Asset.status: ISSUED` (rejects if not `IN_STORE`); `returnAsset(fastify, schoolId, { assetId, conditionIn? })` — closes the open assignment (`returnedAt`), sets `status: IN_STORE`. Both in one transaction.

Routes (school-scoped subtree; mutations `requirePermission('asset.manage')` + `requireWritableSchool`; reads `asset.read`):
- `GET|POST|PATCH /api/school/inventory/categories`
- `GET|POST /api/school/inventory/items` · `GET|PATCH /api/school/inventory/items/:itemId` · `GET /api/school/inventory/items/:itemId/ledger`
- `POST /api/school/inventory/items/:itemId/receive` · `.../issue` · `.../adjust`
- `GET /api/school/inventory/low-stock`
- `GET|POST /api/school/inventory/assets` · `GET|PATCH /api/school/inventory/assets/:assetId` · `POST .../assets/:assetId/dispose`
- `POST /api/school/inventory/assets/:assetId/issue` · `.../return`

All responses use `successResponse`/`errorResponse`; `Decimal`s serialized as strings.

#### 3.1.4 Permission strings (extends PRP-17)
| Resource | Actions | ADMIN | STAFF (storekeeper) | TEACHER | STUDENT | PARENT |
|----------|---------|:-----:|:-------------------:|:-------:|:-------:|:------:|
| `asset` | `read`, `manage` | read, manage | read, manage | read | – | – |

One resource (`asset`) covers both consumables and fixed assets — the `kind`/route distinguishes them, not the permission (keeps the matrix small; D14 global-only). TEACHER read is so a teacher can see what's issued to them/their department; no parent/student access.

#### 3.1.5 Audit (PRP-18)
`writeAudit()` on stock receive/issue/adjust, asset create/update/dispose, and asset issue/return (these are stock-movement / custody-chain events — the audit reason for a low-severity module is **accountability of stock**). Metadata: identifiers + quantity/amount only.

### 3.2 Frontend
House conventions (PRP-43/47): UI in `src/modules/inventory/`, state/API in `src/store/inventory/` (`*.store.ts`/`*.services.ts`/`*.type.ts`), server state via **TanStack Query** (PRP-09), routes from **`APP_ROUTES`** only, `helper.*`-normalized responses, `cn()`, writes gated by `<WriteGate>` (PRP-24) + `<Can>` (PRP-11), permission keys mirrored from the backend.

- **Routes (`src/constants/routes.ts`):** add under `APP_ROUTES.school` an `inventory` group: `inventory` (items list) → `/inventory`, `inventoryItem(id)` → `/inventory/items/[itemId]`, `assets` → `/inventory/assets`, `assetDetail(id)` → `/inventory/assets/[assetId]`.
- **State & services (`src/store/inventory/`):** `inventory.type.ts` mirrors the backend `ItemKind`/`StockMovementType`/`AssetStatus`/`AssetCondition` unions + `Item`/`StockMovement`/`Asset`/`AssetAssignment` shapes verbatim (reuse `SchoolRole`/`PermissionKey` from PRP-10). `inventory.services.ts` via `apiClient` + `helper.*`: category CRUD, `fetchItems(params)`/`fetchItem(id)`/`createItem`/`updateItem`, `receiveStock`/`issueStock`/`adjustStock`/`fetchLedger(itemId)`, `fetchLowStock()`, asset CRUD + `issueAsset`/`returnAsset`/`disposeAsset`.
- **UI modules (`src/modules/inventory/`):**
  - `ItemsListScreen.tsx` (page `inventory/page.tsx`) — `DataGrid` of items; consumables show `quantityOnHand` + a **low-stock badge** when `<= reorderLevel`; a kind filter + category filter; "Add item" modal.
  - `ItemDetail.tsx` (page `inventory/items/[itemId]`) — for a CONSUMABLE: the stock-movement ledger + Receive/Issue/Adjust modals (`<WriteGate>`-gated); for a FIXED_ASSET catalog row: the list of its `Asset` units.
  - `AssetsListScreen.tsx` (page `inventory/assets`) — `DataGrid` of discrete assets with status; "Add asset" modal; a status filter.
  - `AssetDetail.tsx` (page `inventory/assets/[assetId]`) — the assignment history + Issue (staff picker or location) / Return / Dispose actions.
- **Menu + guards (`src/constants/project.menu.ts`, PRP-11/25):** add an **Inventory** section (STAFF/ADMIN, `asset.manage`/`asset.read`) with Items + Assets entries (`APP_ROUTES` only); visibility from `deriveAbilities` (PRP-10).

## 4. Implementation steps
1. **Backend — schema:** add the four enums + `ItemCategory`/`Item`/`StockMovement`/`Asset`/`AssetAssignment` (+ `School` back-relations only — no `Student` edit). `pnpm exec prisma migrate dev --name inventory_assets` then `pnpm prisma:generate`.
2. **Backend — module:** add `src/modules/inventory/{routes,controller,service,schema,types}.ts`; implement §3.1.3 (transactional stock + asset issue/return; negative-stock guard; `assetTag` uniqueness `P2002` → `409`).
3. **Backend — routing + guards:** register the school-scoped subtree under `src/plugins/school.plugin.ts`; `requirePermission('asset.read'|'asset.manage')` + `requireWritableSchool` on writes.
4. **Backend — permissions + audit:** add `asset.*` to PRP-17 + default role map; `writeAudit()` on stock movements + asset custody events (identifiers/quantity-only metadata).
5. **Backend — schemas/types:** Fastify JSON schemas + request/response types; enums from `src/generated/prisma/enums.js`; `Decimal`s as strings.
6. **Frontend — routes/types/services:** add the `inventory` route group to `APP_ROUTES`; add `src/store/inventory/{inventory.type,inventory.services}.ts` mirroring the backend; all via `apiClient` + `helper.*`.
7. **Frontend — UI:** add `ItemsListScreen`/`ItemDetail`/`AssetsListScreen`/`AssetDetail` (+ thin pages); `<WriteGate>`/`<Can>` on every mutating control; TanStack Query keys + invalidation on receive/issue/adjust/return.
8. **Frontend — menu/guards:** add the permission-tagged Inventory section to `project.menu.ts` (via `APP_ROUTES`, PRP-11).

## 5. Files added / changed
- **Backend — add:** `src/modules/inventory/inventory.routes.ts`, `inventory.controller.ts`, `inventory.service.ts`, `inventory.schema.ts`, `inventory.types.ts` (assets may be co-located as `assets.*` in the same dir)
- **Backend — edit:** `prisma/schema.prisma` (+ migration), `src/plugins/school.plugin.ts`, `src/modules/authz/permissions.ts` (PRP-17 — add `asset.*`)
- **Frontend — add:** `src/store/inventory/inventory.type.ts`, `src/store/inventory/inventory.services.ts`, `src/modules/inventory/{ItemsListScreen,ItemDetail,AssetsListScreen,AssetDetail}.tsx`, pages `src/app/(school)/inventory/page.tsx`, `src/app/(school)/inventory/items/[itemId]/page.tsx`, `src/app/(school)/inventory/assets/page.tsx`, `src/app/(school)/inventory/assets/[assetId]/page.tsx`, optional `src/store/inventory/inventory.queries.ts`
- **Frontend — edit:** `src/constants/routes.ts` (inventory route group), `src/constants/project.menu.ts` (Inventory section)

## 6. Acceptance criteria
- [ ] The four enums + `ItemCategory`/`Item`/`StockMovement`/`Asset`/`AssetAssignment` exist with the documented uniques + indexes; **all money columns are `Decimal`**; `School` back-relations added; no `Student` edit.
- [ ] Receiving stock raises `quantityOnHand` and records an IN movement; issuing lowers it (and rejects an issue that would go negative with `409`); an ADJUST corrects it — each as one transaction with an immutable movement row.
- [ ] The low-stock report returns consumables at/below `reorderLevel`.
- [ ] A fixed asset can be created (duplicate `assetTag` per school → `409`), issued to a staff member/location (status → ISSUED, assignment opened), returned (status → IN_STORE, assignment closed), and disposed (status → DISPOSED) — issue rejected when not IN_STORE.
- [ ] "Who holds asset X now" resolves from the open `AssetAssignment` (one indexed read).
- [ ] Stock movements + asset custody events are audited (PRP-18) with identifiers/quantity-only metadata.
- [ ] All writes are `asset.manage` + `requireWritableSchool`-gated; reads `asset.read`; tenant-scoped throughout.
- [ ] FE: items/assets screens flow through `store/inventory/*.services.ts` + TanStack Query (no direct axios); routes from `APP_ROUTES`; mutating controls in `<WriteGate>`; permission keys match the backend; low-stock badge renders.
- [ ] The ⚠︎ O-P8 assumptions (two-kinds-one-model, no procurement/depreciation, no scanner, no location master) are recorded.

## 7. Validation
- **Backend:** `pnpm typecheck && pnpm lint:check && pnpm build`; `pnpm exec prisma migrate dev --name inventory_assets` applies cleanly.
- **Frontend:** `yarn type-check && yarn lint && yarn build`.
- **Manual:** create a category + a consumable item with reorder level; receive 100, issue 90 → low-stock badge appears; attempt to issue 20 more → `409`; create a fixed asset with a tag, issue it to a teacher, return it, dispose it; confirm the per-item ledger and per-asset history read correctly; confirm a duplicate `assetTag` returns `409`.

## 8. Risks & rollback
- **Stock correctness (paramount):** `quantityOnHand` must never drift from the sum of its `StockMovement`s — the movement insert + quantity update is one transaction with a negative-stock guard. The movement row is the audit trail; the column is a cache. Cover receive/issue/adjust/over-issue in a test (mirrors PRP-46's money-correctness note).
- **Asset state machine:** issue/return/dispose transitions must be guarded (no issuing an already-ISSUED or DISPOSED asset; no returning an asset with no open assignment) — illegal transitions throw `409`.
- **Scope discipline (⚠︎ O-P8):** no procurement/PO/GRN, no depreciation, no scanner, no location master in v1 — these are explicit future seams (the `assetTag`/`location`/`unitCost`/`purchaseCost` fields reserve the surface). Resist pulling them in until O-P8 resolves.
- **Boundary with sibling modules:** library books (PRP-65) and transport vehicles (PRP-64) have their **own** issue/asset models — do **not** route them through inventory; this module is generic stores + fixed assets only. Note the boundary in the PR.
- **`School` back-relations only (§8):** unlike the student-centric P8 PRPs, this PRP touches only `School` back-relations, so it does **not** participate in the shared-`Student`-edit migration coordination — but still rebase the `School` block cleanly against any concurrent P8 migration.
- **Far-future / low severity:** gated behind O-P8 module-priority; ships later with no impact on earlier phases if deprioritized.
- **Rollback:** additive module + tables on both repos; revert the modules, drop the five tables + `School` back-relations. FE screens are inert if the routes are reverted (the catch-all reclaims `/inventory`).
