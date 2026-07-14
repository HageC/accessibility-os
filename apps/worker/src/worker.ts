import { config } from "dotenv";
config({ path: "../../.env" });
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { db } from "@aos/database";
import { scanSite } from "@aos/scanner";
import { validateScanTarget } from "@aos/shared";
import { executeJourney } from "@aos/journey-engine";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decryptSession, encryptSession } from "./session-store.js";

const env = z
  .object({
    REDIS_URL: z.string().url(),
    SCAN_ALLOWED_ORIGIN: z.string().url(),
    ARTIFACT_DIR: z.string().default("./artifacts"),
  })
  .parse(process.env);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker<{
  scanId: string;
  maxPages?: number;
  maxDepth?: number;
}>(
  "scans",
  async (job) => {
    const claimed = await db.scan.updateMany({
      where: { id: job.data.scanId, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    if (claimed.count === 0) return;
    const scan = await db.scan.findUnique({
      where: { id: job.data.scanId },
      include: { project: { include: { session: true } } },
    });
    if (!scan) return;
    try {
      const target = await validateScanTarget(
        scan.targetUrl,
        env.SCAN_ALLOWED_ORIGIN,
      );
      const result = await scanSite(target.url, target.origin, target.address, {
        maxPages: job.data.maxPages ?? 8,
        maxDepth: job.data.maxDepth ?? 2,
        storageState: scan.project.session
          ? await decryptSession(
              scan.project.session.ciphertext,
              env.ARTIFACT_DIR,
            )
          : undefined,
      });
      const screenshotKeys = result.pages.map((_, index) =>
        index === 0 ? `${scan.id}.png` : `${scan.id}-page-${index}.png`,
      );
      const focusKey = `${scan.id}-focus.png`;
      const dir = resolve("../../", env.ARTIFACT_DIR);
      await mkdir(dir, { recursive: true });
      for (const [index, page] of result.pages.entries())
        await writeFile(resolve(dir, screenshotKeys[index]!), page.screenshot);
      await writeFile(resolve(dir, focusKey), result.focusScreenshot);
      for (const observation of result.focusObservations)
        await writeFile(
          resolve(dir, `${scan.id}-focus-step-${observation.sequence}.png`),
          observation.screenshot,
        );
      await db.$transaction(
        async (tx) => {
          for (const [index, scannedPage] of result.pages.entries()) {
            const page = await tx.scanPage.create({
              data: {
                scanId: scan.id,
                url: scannedPage.url,
                title: scannedPage.title,
              },
            });
            for (const finding of scannedPage.findings)
              await tx.finding.create({
                data: { pageId: page.id, ...finding },
              });
            await tx.artifact.create({
              data: {
                scanId: scan.id,
                pageId: page.id,
                kind: index === 0 ? "SCREENSHOT" : "PAGE_SCREENSHOT",
                mimeType: "image/png",
                storageKey: screenshotKeys[index]!,
              },
            });
          }
          await tx.artifact.create({
            data: {
              scanId: scan.id,
              kind: "FOCUS_SCREENSHOT",
              mimeType: "image/png",
              storageKey: focusKey,
            },
          });
          for (const observation of result.focusObservations)
            await tx.artifact.create({
              data: {
                scanId: scan.id,
                kind: `FOCUS_STEP_${observation.sequence}`,
                mimeType: "image/png",
                storageKey: `${scan.id}-focus-step-${observation.sequence}.png`,
              },
            });
          for (const observation of result.focusObservations) {
            const { screenshot: _screenshot, ...data } = observation;
            void _screenshot;
            await tx.focusObservation.create({
              data: { scanId: scan.id, ...data },
            });
          }
          await tx.scan.update({
            where: { id: scan.id },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        },
        { timeout: 120000 },
      );
    } catch (error) {
      const timedOut =
        error instanceof Error && error.message === "SCAN_TIMEOUT";
      await db.scan.update({
        where: { id: scan.id },
        data: {
          status: timedOut ? "TIMED_OUT" : "FAILED",
          completedAt: new Date(),
          failureCode: timedOut ? "SCAN_TIMEOUT" : "SCAN_FAILED",
          failureText:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown scan failure",
        },
      });
      throw error;
    }
  },
  { connection: redis, concurrency: 1, lockDuration: 60000 },
);
worker.on("failed", (job, error) =>
  console.error(
    JSON.stringify({
      event: "scan_failed",
      scanId: job?.data.scanId,
      message: error.message,
    }),
  ),
);
worker.on("stalled", (scanId) => {
  void db.scan
    .updateMany({
      where: { id: scanId, status: "RUNNING" },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        failureCode: "WORKER_STALLED",
        failureText: "Scan worker stopped before completion",
      },
    })
    .catch((error) => console.error(error));
});
const journeyWorker = new Worker<{ runId: string }>(
  "journeys",
  async (job) => {
    const claimed = await db.journeyRun.updateMany({
      where: { id: job.data.runId, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    if (claimed.count === 0) return;
    const run = await db.journeyRun.findUnique({
      where: { id: job.data.runId },
      include: {
        journey: { include: { project: { include: { session: true } } } },
      },
    });
    if (!run) return;
    try {
      const target = await validateScanTarget(
        run.journey.project.url,
        env.SCAN_ALLOWED_ORIGIN,
      );
      const result = await executeJourney(
        run.journey.spec,
        target.origin,
        target.address,
        run.journey.project.session
          ? await decryptSession(
              run.journey.project.session.ciphertext,
              env.ARTIFACT_DIR,
            )
          : null,
      );
      const sessionCiphertext = result.session
        ? await encryptSession(result.session, env.ARTIFACT_DIR)
        : null;
      const key = `${run.id}-journey.png`;
      const dir = resolve("../../", env.ARTIFACT_DIR);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, key), result.screenshot);
      for (const step of result.steps)
        await writeFile(
          resolve(dir, `${run.id}-step-${step.sequence}.png`),
          step.screenshot,
        );
      await db.$transaction(async (tx) => {
        for (const step of result.steps)
          await tx.journeyStepResult.create({
            data: {
              runId: run.id,
              sequence: step.sequence,
              action: step.action,
              startedAt: new Date(step.startedAt),
              completedAt: new Date(step.completedAt),
              outcome: step.outcome,
              expected: step.expected,
              observed: step.observed,
              failure: step.failure,
              auditFindings: step.auditFindings?.map((finding) => ({
                ruleId: finding.ruleId,
                impact: finding.impact,
                help: finding.help,
                target: finding.target,
                helpUrl: finding.helpUrl,
                wcag: finding.wcag,
              })),
              screenshotKey: `${run.id}-step-${step.sequence}.png`,
            },
          });
        await tx.journeyRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            outcome: result.outcome,
            completedAt: new Date(),
            screenshotKey: key,
          },
        });
        if (sessionCiphertext)
          await tx.projectSession.upsert({
            where: { projectId: run.journey.projectId },
            create: {
              projectId: run.journey.projectId,
              ciphertext: sessionCiphertext,
            },
            update: { ciphertext: sessionCiphertext },
          });
      });
    } catch (error) {
      await db.journeyRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          failureCode: "EXECUTION_FAILED",
          failureText:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown journey failure",
        },
      });
      throw error;
    }
  },
  { connection: redis, concurrency: 1, lockDuration: 90000 },
);
journeyWorker.on("failed", (job, error) =>
  console.error(
    JSON.stringify({
      event: "journey_failed",
      runId: job?.data.runId,
      message: error.message,
    }),
  ),
);
journeyWorker.on("stalled", (runId) => {
  void db.journeyRun
    .updateMany({
      where: { id: runId, status: "RUNNING" },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        failureCode: "WORKER_STALLED",
        failureText: "Journey worker stopped before completion",
      },
    })
    .catch((error) => console.error(error));
});
const shutdown = async () => {
  await worker.close();
  await journeyWorker.close();
  await redis.quit();
  await db.$disconnect();
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
