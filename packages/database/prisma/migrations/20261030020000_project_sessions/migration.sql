CREATE TABLE "ProjectSession" (
    "projectId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectSession_pkey" PRIMARY KEY ("projectId")
);

ALTER TABLE "ProjectSession" ADD CONSTRAINT "ProjectSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
