-- AlterTable: add session-lineage columns.
-- familyId is added nullable first so existing rows can be backfilled before
-- the NOT NULL constraint is enforced (works whether or not the table is empty).
ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT,
ADD COLUMN "replacedById" TEXT;

-- Backfill: each pre-existing token becomes its own single-token family.
UPDATE "RefreshToken" SET "familyId" = "id" WHERE "familyId" IS NULL;

-- Enforce NOT NULL now that every row has a familyId.
ALTER TABLE "RefreshToken" ALTER COLUMN "familyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
