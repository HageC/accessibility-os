-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Journey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyRun" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'QUEUED',
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureText" TEXT,
    "screenshotKey" TEXT,

    CONSTRAINT "JourneyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyStepResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "expected" TEXT,
    "observed" TEXT,
    "failure" TEXT,

    CONSTRAINT "JourneyStepResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Journey_projectId_createdAt_idx" ON "Journey"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "JourneyRun_journeyId_createdAt_idx" ON "JourneyRun"("journeyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyStepResult_runId_sequence_key" ON "JourneyStepResult"("runId", "sequence");

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyRun" ADD CONSTRAINT "JourneyRun_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyStepResult" ADD CONSTRAINT "JourneyStepResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JourneyRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
