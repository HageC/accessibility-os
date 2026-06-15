-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'QUEUED',
    "targetUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureText" TEXT,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanPage" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,

    CONSTRAINT "ScanPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "impact" TEXT,
    "description" TEXT NOT NULL,
    "help" TEXT NOT NULL,
    "helpUrl" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "html" TEXT NOT NULL,
    "failureSummary" TEXT,
    "tags" JSONB NOT NULL,
    "wcag" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Scan_projectId_createdAt_idx" ON "Scan"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanPage_scanId_idx" ON "ScanPage"("scanId");

-- CreateIndex
CREATE INDEX "Finding_pageId_impact_idx" ON "Finding"("pageId", "impact");

-- CreateIndex
CREATE INDEX "Finding_fingerprint_idx" ON "Finding"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_storageKey_key" ON "Artifact"("storageKey");

-- CreateIndex
CREATE INDEX "Artifact_scanId_idx" ON "Artifact"("scanId");

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanPage" ADD CONSTRAINT "ScanPage_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ScanPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
