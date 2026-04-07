-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('DEVELOPER', 'USER');

-- CreateEnum
CREATE TYPE "SchoolStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SchoolRole" AS ENUM ('ADMIN', 'STAFF', 'TEACHER', 'STUDENT', 'PARENT');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "systemRole" "SystemRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "School" (
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "board" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" "SchoolStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "School_pkey" PRIMARY KEY ("schoolId")
);

-- CreateTable
CREATE TABLE "UserSchool" (
    "userSchoolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "primaryRole" "SchoolRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSchool_pkey" PRIMARY KEY ("userSchoolId")
);

-- CreateTable
CREATE TABLE "UserSchoolSecondaryRole" (
    "id" TEXT NOT NULL,
    "userSchoolId" TEXT NOT NULL,
    "role" "SchoolRole" NOT NULL,

    CONSTRAINT "UserSchoolSecondaryRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminProfile" (
    "adminProfileId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userSchoolId" TEXT NOT NULL,
    "designation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminProfile_pkey" PRIMARY KEY ("adminProfileId")
);

-- CreateTable
CREATE TABLE "TeacherProfile" (
    "teacherProfileId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userSchoolId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "department" TEXT,
    "qualification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherProfile_pkey" PRIMARY KEY ("teacherProfileId")
);

-- CreateTable
CREATE TABLE "StaffProfile" (
    "staffProfileId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userSchoolId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "department" TEXT,
    "designation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("staffProfileId")
);

-- CreateTable
CREATE TABLE "ParentProfile" (
    "parentProfileId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userSchoolId" TEXT NOT NULL,
    "occupation" TEXT,
    "relationshipNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParentProfile_pkey" PRIMARY KEY ("parentProfileId")
);

-- CreateTable
CREATE TABLE "Student" (
    "studentId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userSchoolId" TEXT,
    "admissionNo" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "admissionDate" TIMESTAMP(3),
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("studentId")
);

-- CreateTable
CREATE TABLE "ParentStudent" (
    "parentStudentId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "parentProfileId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "relation" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParentStudent_pkey" PRIMARY KEY ("parentStudentId")
);

-- CreateIndex
CREATE INDEX "User_systemRole_idx" ON "User"("systemRole");

-- CreateIndex
CREATE UNIQUE INDEX "School_subdomain_key" ON "School"("subdomain");

-- CreateIndex
CREATE INDEX "School_subdomain_idx" ON "School"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "UserSchool_userId_schoolId_key" ON "UserSchool"("userId", "schoolId");

-- CreateIndex
CREATE INDEX "UserSchool_schoolId_idx" ON "UserSchool"("schoolId");

-- CreateIndex
CREATE INDEX "UserSchool_primaryRole_idx" ON "UserSchool"("primaryRole");

-- CreateIndex
CREATE UNIQUE INDEX "one_admin_per_school"
ON "UserSchool" ("schoolId")
WHERE "primaryRole" = 'ADMIN';

-- CreateIndex
CREATE UNIQUE INDEX "UserSchoolSecondaryRole_userSchoolId_role_key"
ON "UserSchoolSecondaryRole"("userSchoolId", "role");

-- CreateIndex
CREATE INDEX "UserSchoolSecondaryRole_role_idx"
ON "UserSchoolSecondaryRole"("role");

-- CreateIndex
CREATE UNIQUE INDEX "AdminProfile_userSchoolId_key" ON "AdminProfile"("userSchoolId");

-- CreateIndex
CREATE INDEX "AdminProfile_schoolId_idx" ON "AdminProfile"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_userSchoolId_key" ON "TeacherProfile"("userSchoolId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_employeeCode_key" ON "TeacherProfile"("employeeCode");

-- CreateIndex
CREATE INDEX "TeacherProfile_schoolId_idx" ON "TeacherProfile"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_userSchoolId_key" ON "StaffProfile"("userSchoolId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_employeeCode_key" ON "StaffProfile"("employeeCode");

-- CreateIndex
CREATE INDEX "StaffProfile_schoolId_idx" ON "StaffProfile"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ParentProfile_userSchoolId_key" ON "ParentProfile"("userSchoolId");

-- CreateIndex
CREATE INDEX "ParentProfile_schoolId_idx" ON "ParentProfile"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userSchoolId_key" ON "Student"("userSchoolId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_schoolId_admissionNo_key" ON "Student"("schoolId", "admissionNo");

-- CreateIndex
CREATE INDEX "Student_schoolId_idx" ON "Student"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ParentStudent_parentProfileId_studentId_key"
ON "ParentStudent"("parentProfileId", "studentId");

-- CreateIndex
CREATE INDEX "ParentStudent_schoolId_idx" ON "ParentStudent"("schoolId");

-- CreateIndex
CREATE INDEX "ParentStudent_studentId_idx" ON "ParentStudent"("studentId");

-- AddForeignKey
ALTER TABLE "UserSchool"
ADD CONSTRAINT "UserSchool_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("userId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSchool"
ADD CONSTRAINT "UserSchool_schoolId_fkey"
FOREIGN KEY ("schoolId") REFERENCES "School"("schoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSchoolSecondaryRole"
ADD CONSTRAINT "UserSchoolSecondaryRole_userSchoolId_fkey"
FOREIGN KEY ("userSchoolId") REFERENCES "UserSchool"("userSchoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminProfile"
ADD CONSTRAINT "AdminProfile_schoolId_fkey"
FOREIGN KEY ("schoolId") REFERENCES "School"("schoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminProfile"
ADD CONSTRAINT "AdminProfile_userSchoolId_fkey"
FOREIGN KEY ("userSchoolId") REFERENCES "UserSchool"("userSchoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfile"
ADD CONSTRAINT "TeacherProfile_schoolId_fkey"
FOREIGN KEY ("schoolId") REFERENCES "School"("schoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfile"
ADD CONSTRAINT "TeacherProfile_userSchoolId_fkey"
FOREIGN KEY ("userSchoolId") REFERENCES "UserSchool"("userSchoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile"
ADD CONSTRAINT "StaffProfile_schoolId_fkey"
FOREIGN KEY ("schoolId") REFERENCES "School"("schoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile"
ADD CONSTRAINT "StaffProfile_userSchoolId_fkey"
FOREIGN KEY ("userSchoolId") REFERENCES "UserSchool"("userSchoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentProfile"
ADD CONSTRAINT "ParentProfile_schoolId_fkey"
FOREIGN KEY ("schoolId") REFERENCES "School"("schoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentProfile"
ADD CONSTRAINT "ParentProfile_userSchoolId_fkey"
FOREIGN KEY ("userSchoolId") REFERENCES "UserSchool"("userSchoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student"
ADD CONSTRAINT "Student_schoolId_fkey"
FOREIGN KEY ("schoolId") REFERENCES "School"("schoolId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student"
ADD CONSTRAINT "Student_userSchoolId_fkey"
FOREIGN KEY ("userSchoolId") REFERENCES "UserSchool"("userSchoolId")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentStudent"
ADD CONSTRAINT "ParentStudent_parentProfileId_fkey"
FOREIGN KEY ("parentProfileId") REFERENCES "ParentProfile"("parentProfileId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentStudent"
ADD CONSTRAINT "ParentStudent_studentId_fkey"
FOREIGN KEY ("studentId") REFERENCES "Student"("studentId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Secondary role cannot be ADMIN
ALTER TABLE "UserSchoolSecondaryRole"
ADD CONSTRAINT "secondary_role_not_admin"
CHECK ("role" <> 'ADMIN');

-- Secondary roles are limited to STAFF and TEACHER only
ALTER TABLE "UserSchoolSecondaryRole"
ADD CONSTRAINT "secondary_role_allowed_values"
CHECK ("role" IN ('STAFF', 'TEACHER'));
