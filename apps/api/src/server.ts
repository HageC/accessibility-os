import { config } from "dotenv";
config({ path: "../../.env" });
import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { db } from "@aos/database";
import { journeySchema } from "@aos/journey-engine";
import { createScanReport, renderScanHtml } from "@aos/report-engine";
import { buildProjectAnalytics } from "@aos/analytics";
import { allowedTarget, projectInput, validateScanTarget } from "@aos/shared";
import { readFile, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";

const env = z
  .object({
    DATABASE_URL: z.string(),
    REDIS_URL: z.string().url(),
    API_PORT: z.coerce.number().default(4000),
    API_HOST: z.string().default("127.0.0.1"),
    WEB_ORIGIN: z.string().url(),
    SCAN_ALLOWED_ORIGIN: z.string().url(),
    ARTIFACT_DIR: z.string().default("./artifacts"),
  })
  .parse(process.env);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("scans", { connection: redis });
const journeyQueue = new Queue("journeys", { connection: redis });
const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(cors, {
  origin: [
    ...new Set([
      env.WEB_ORIGIN,
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]),
  ],
  methods: ["GET", "HEAD", "POST", "DELETE"],
});
await app.register(swagger, {
  openapi: { info: { title: "AccessibilityOS API", version: "0.1.0" } },
  transform: jsonSchemaTransform,
});
await app.register(swaggerUi, { routePrefix: "/documentation" });

const idParams = z.object({ id: z.string().uuid() });
const scanInput = z.object({
  maxPages: z.number().int().min(1).max(100).default(8),
  maxDepth: z.number().int().min(0).max(6).default(2),
});
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
async function loadReport(scanId: string) {
  const scan = await db.scan.findUnique({
    where: { id: scanId },
    include: {
      project: true,
      pages: { include: { findings: { orderBy: { id: "asc" } } } },
      artifacts: true,
    },
  });
  if (!scan) return { kind: "not-found" } as const;
  if (scan.status !== "COMPLETED" || !scan.completedAt)
    return { kind: "not-ready" } as const;
  return {
    kind: "ready",
    report: createScanReport({
      scanId: scan.id,
      projectName: scan.project.name,
      targetUrl: scan.targetUrl,
      startedAt: scan.startedAt?.toISOString() ?? null,
      completedAt: scan.completedAt.toISOString(),
      pages: scan.pages.map((page) => ({
        url: page.url,
        title: page.title,
        findings: page.findings.map((finding) => ({
          id: finding.id,
          fingerprint: finding.fingerprint,
          ruleId: finding.ruleId,
          impact: finding.impact,
          description: finding.description,
          help: finding.help,
          helpUrl: finding.helpUrl,
          target: strings(finding.target),
          html: finding.html,
          failureSummary: finding.failureSummary,
          tags: strings(finding.tags),
          wcag: strings(finding.wcag),
        })),
      })),
      artifacts: scan.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
      })),
    }),
  } as const;
}
app.setErrorHandler((error, _request, reply) => {
  const err = error as Error & { statusCode?: number };
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  app.log.error(error);
  reply.status(status).send({
    error: {
      code: status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
      message: status === 500 ? "An internal error occurred" : err.message,
    },
  });
});
app.get("/api/v1/health", async () => {
  await db.$queryRaw`SELECT 1`;
  await redis.ping();
  return { status: "ok" };
});
app.get("/api/v1/config", async () => ({
  defaultTargetUrl: new URL(
    "/fixture.html",
    env.SCAN_ALLOWED_ORIGIN,
  ).toString(),
}));
app.get("/api/v1/projects", async () =>
  db.project.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      session: { select: { updatedAt: true } },
      scans: {
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { pages: true } } },
      },
    },
  }),
);
app.delete<{ Params: { id: string } }>(
  "/api/v1/projects/:id/session",
  { schema: { params: idParams } },
  async (request, reply) => {
    const project = await db.project.findUnique({
      where: { id: request.params.id },
      select: { id: true },
    });
    if (!project)
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Project not found" },
      });
    await db.projectSession.deleteMany({ where: { projectId: project.id } });
    return { deleted: true };
  },
);
app.post<{ Body: z.infer<typeof projectInput> }>(
  "/api/v1/projects",
  { schema: { body: projectInput } },
  async (request, reply) => {
    let url: string;
    try {
      url = (
        await validateScanTarget(request.body.url, env.SCAN_ALLOWED_ORIGIN)
      ).url;
    } catch {
      return reply.status(400).send({
        error: {
          code: "TARGET_NOT_ALLOWED",
          message: "Use a public HTTPS website or the configured local fixture",
        },
      });
    }
    return reply
      .status(201)
      .send(
        await db.project.create({ data: { name: request.body.name, url } }),
      );
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/projects/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const project = await db.project.findUnique({
      where: { id: request.params.id },
    });
    return (
      project ??
      reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found" } })
    );
  },
);
app.delete<{ Params: { id: string } }>(
  "/api/v1/projects/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const project = await db.project.findUnique({
      where: { id: request.params.id },
      select: {
        scans: {
          select: { status: true, artifacts: { select: { storageKey: true } } },
        },
        journeys: {
          select: {
            runs: {
              select: {
                status: true,
                screenshotKey: true,
                stepResults: { select: { screenshotKey: true } },
              },
            },
          },
        },
      },
    });
    if (!project)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (
      project.scans.some(
        (scan) => scan.status === "QUEUED" || scan.status === "RUNNING",
      ) ||
      project.journeys.some((journey) =>
        journey.runs.some(
          (run) => run.status === "QUEUED" || run.status === "RUNNING",
        ),
      )
    )
      return reply.status(409).send({
        error: {
          code: "PROJECT_BUSY",
          message:
            "Wait for active scans and journeys to finish before deleting this project",
        },
      });
    await db.project.delete({ where: { id: request.params.id } });
    const keys = [
      ...project.scans.flatMap((scan) =>
        scan.artifacts.map((artifact) => artifact.storageKey),
      ),
      ...project.journeys.flatMap((journey) =>
        journey.runs
          .flatMap((run) => [
            run.screenshotKey,
            ...run.stepResults.map((step) => step.screenshotKey),
          ])
          .filter((key): key is string => Boolean(key)),
      ),
    ];
    const base = resolve("../../", env.ARTIFACT_DIR);
    await Promise.all(
      keys.map(async (key) => {
        const file = resolve(base, key);
        if (!file.startsWith(base + sep)) return;
        try {
          await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            app.log.warn({ error, key }, "Could not remove project artifact");
        }
      }),
    );
    return { deleted: true };
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/projects/:id/analytics",
  { schema: { params: idParams } },
  async (request, reply) => {
    const project = await db.project.findUnique({
      where: { id: request.params.id },
      select: { id: true },
    });
    if (!project)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    const scans = await db.scan.findMany({
      where: { projectId: project.id, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      take: 30,
      select: {
        id: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        pages: {
          select: { findings: { select: { fingerprint: true, impact: true } } },
        },
      },
    });
    return buildProjectAnalytics(scans);
  },
);
app.post<{ Params: { id: string }; Body: z.infer<typeof scanInput> }>(
  "/api/v1/projects/:id/scans",
  { schema: { params: idParams, body: scanInput } },
  async (request, reply) => {
    const project = await db.project.findUnique({
      where: { id: request.params.id },
    });
    if (!project)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    const scan = await db.scan.create({
      data: { projectId: project.id, targetUrl: project.url },
    });
    try {
      await queue.add(
        "scan",
        {
          scanId: scan.id,
          maxPages: request.body.maxPages,
          maxDepth: request.body.maxDepth,
        },
        {
          jobId: scan.id,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      await db.scan.update({
        where: { id: scan.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          failureCode: "QUEUE_UNAVAILABLE",
          failureText: "Could not enqueue scan",
        },
      });
      throw error;
    }
    return reply.status(202).send({ id: scan.id, status: scan.status });
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/scans/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const scan = await db.scan.findUnique({
      where: { id: request.params.id },
      include: {
        project: true,
        pages: { include: { _count: { select: { findings: true } } } },
        artifacts: true,
      },
    });
    return (
      scan ??
      reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } })
    );
  },
);
app.get<{
  Params: { id: string };
  Querystring: { cursor?: string; limit: number };
}>(
  "/api/v1/scans/:id/findings",
  {
    schema: {
      params: idParams,
      querystring: z.object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
  },
  async (request) => {
    const items = await db.finding.findMany({
      where: { page: { scanId: request.params.id } },
      orderBy: { id: "asc" },
      take: request.query.limit + 1,
      ...(request.query.cursor
        ? { cursor: { id: request.query.cursor }, skip: 1 }
        : {}),
      include: { page: true },
    });
    const nextCursor =
      items.length > request.query.limit
        ? (items[request.query.limit - 1]?.id ?? null)
        : null;
    return { items: items.slice(0, request.query.limit), nextCursor };
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/findings/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const finding = await db.finding.findUnique({
      where: { id: request.params.id },
      include: {
        page: {
          include: { artifacts: true, scan: { include: { artifacts: true } } },
        },
      },
    });
    return (
      finding ??
      reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Finding not found" } })
    );
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/scans/:id/artifacts",
  { schema: { params: idParams } },
  async (request) =>
    db.artifact.findMany({ where: { scanId: request.params.id } }),
);
app.get<{ Params: { id: string } }>(
  "/api/v1/scans/:id/focus",
  { schema: { params: idParams } },
  async (request) =>
    db.focusObservation.findMany({
      where: { scanId: request.params.id },
      orderBy: { sequence: "asc" },
    }),
);
app.get<{ Params: { id: string } }>(
  "/api/v1/scans/:id/report.json",
  { schema: { params: idParams } },
  async (request, reply) => {
    const result = await loadReport(request.params.id);
    if (result.kind === "not-found")
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    if (result.kind === "not-ready")
      return reply.status(409).send({
        error: {
          code: "SCAN_NOT_COMPLETE",
          message: "Report is available after the scan completes",
        },
      });
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="scan-${request.params.id}.json"`,
      )
      .header("Cache-Control", "private, no-store")
      .send(result.report);
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/scans/:id/report.html",
  { schema: { params: idParams } },
  async (request, reply) => {
    const result = await loadReport(request.params.id);
    if (result.kind === "not-found")
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    if (result.kind === "not-ready")
      return reply.status(409).send({
        error: {
          code: "SCAN_NOT_COMPLETE",
          message: "Report is available after the scan completes",
        },
      });
    return reply
      .type("text/html; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="scan-${request.params.id}.html"`,
      )
      .header("Cache-Control", "private, no-store")
      .send(renderScanHtml(result.report));
  },
);
app.post<{ Params: { id: string }; Body: z.infer<typeof journeySchema> }>(
  "/api/v1/projects/:id/journeys",
  { schema: { params: idParams, body: journeySchema } },
  async (request, reply) => {
    const project = await db.project.findUnique({
      where: { id: request.params.id },
    });
    if (!project)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    try {
      await validateScanTarget(project.url, env.SCAN_ALLOWED_ORIGIN);
      for (const step of request.body.steps)
        if (step.action === "navigate")
          allowedTarget(step.url, new URL(project.url).origin);
    } catch {
      return reply.status(400).send({
        error: {
          code: "TARGET_NOT_ALLOWED",
          message: "Journey navigation must stay on the project's origin",
        },
      });
    }
    return reply.status(201).send(
      await db.journey.create({
        data: {
          projectId: project.id,
          name: request.body.name,
          spec: request.body,
        },
      }),
    );
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/projects/:id/journeys",
  { schema: { params: idParams } },
  async (request) =>
    db.journey.findMany({
      where: { projectId: request.params.id },
      orderBy: { createdAt: "desc" },
      include: { runs: { take: 3, orderBy: { createdAt: "desc" } } },
    }),
);
app.post<{ Params: { id: string } }>(
  "/api/v1/journeys/:id/runs",
  { schema: { params: idParams } },
  async (request, reply) => {
    const journey = await db.journey.findUnique({
      where: { id: request.params.id },
    });
    if (!journey)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Journey not found" } });
    const run = await db.journeyRun.create({ data: { journeyId: journey.id } });
    try {
      await journeyQueue.add(
        "journey",
        { runId: run.id },
        {
          jobId: run.id,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      await db.journeyRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          failureCode: "QUEUE_UNAVAILABLE",
          failureText: "Could not enqueue journey",
        },
      });
      throw error;
    }
    return reply.status(202).send({ id: run.id, status: run.status });
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/journey-runs/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const run = await db.journeyRun.findUnique({
      where: { id: request.params.id },
      include: {
        stepResults: { orderBy: { sequence: "asc" } },
        journey: { select: { id: true, name: true, projectId: true } },
      },
    });
    return (
      run ??
      reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Journey run not found" },
      })
    );
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/journey-runs/:id/screenshot",
  { schema: { params: idParams } },
  async (request, reply) => {
    const run = await db.journeyRun.findUnique({
      where: { id: request.params.id },
    });
    if (!run?.screenshotKey)
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Journey screenshot not found" },
      });
    const base = resolve("../../", env.ARTIFACT_DIR);
    const file = resolve(base, run.screenshotKey);
    if (!file.startsWith(base + sep))
      return reply.status(400).send({
        error: { code: "INVALID_ARTIFACT", message: "Invalid artifact path" },
      });
    try {
      return reply
        .type("image/png")
        .header("Cache-Control", "private, no-store")
        .send(await readFile(file));
    } catch {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Journey screenshot bytes not found",
        },
      });
    }
  },
);
app.get<{ Params: { id: string; sequence: string } }>(
  "/api/v1/journey-runs/:id/steps/:sequence/screenshot",
  {
    schema: {
      params: z.object({
        id: z.string().uuid(),
        sequence: z.coerce.number().int().min(0).max(19),
      }),
    },
  },
  async (request, reply) => {
    const step = await db.journeyStepResult.findUnique({
      where: {
        runId_sequence: {
          runId: request.params.id,
          sequence: Number(request.params.sequence),
        },
      },
    });
    if (!step?.screenshotKey)
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Journey step screenshot not found",
        },
      });
    const base = resolve("../../", env.ARTIFACT_DIR);
    const file = resolve(base, step.screenshotKey);
    if (!file.startsWith(base + sep))
      return reply.status(400).send({
        error: { code: "INVALID_ARTIFACT", message: "Invalid artifact path" },
      });
    try {
      return reply
        .type("image/png")
        .header("Cache-Control", "private, no-store")
        .send(await readFile(file));
    } catch {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Journey step screenshot bytes not found",
        },
      });
    }
  },
);
app.get<{ Params: { id: string } }>(
  "/api/v1/artifacts/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const artifact = await db.artifact.findUnique({
      where: { id: request.params.id },
    });
    if (!artifact)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Artifact not found" } });
    const base = resolve("../../", env.ARTIFACT_DIR);
    const file = resolve(base, artifact.storageKey);
    if (!file.startsWith(base + sep))
      return reply.status(400).send({
        error: { code: "INVALID_ARTIFACT", message: "Invalid artifact path" },
      });
    try {
      return reply
        .type(artifact.mimeType)
        .header("Cache-Control", "private, no-store")
        .send(await readFile(file));
    } catch {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Artifact bytes not found" },
      });
    }
  },
);

const shutdown = async () => {
  await app.close();
  await queue.close();
  await journeyQueue.close();
  await redis.quit();
  await db.$disconnect();
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
await app.listen({ port: env.API_PORT, host: env.API_HOST });
