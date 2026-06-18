ALTER TABLE "Artifact" ADD COLUMN "pageId" TEXT;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ScanPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Artifact_pageId_idx" ON "Artifact"("pageId");
