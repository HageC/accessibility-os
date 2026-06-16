CREATE TABLE "FocusObservation" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "selector" TEXT,
    "tagName" TEXT,
    "role" TEXT,
    "name" TEXT,
    "elementId" TEXT,
    "elementText" TEXT,
    "isBody" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FocusObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FocusObservation_scanId_sequence_key" ON "FocusObservation"("scanId", "sequence");
CREATE INDEX "FocusObservation_scanId_sequence_idx" ON "FocusObservation"("scanId", "sequence");
ALTER TABLE "FocusObservation" ADD CONSTRAINT "FocusObservation_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
