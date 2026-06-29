import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { allowedTarget, fetchPublicAsset, type PublicAsset } from "@aos/shared";
import { normalizeFindings, type NormalizedFinding } from "@aos/scanner";

const targetSchema = z.object({
  role: z.enum([
    "textbox",
    "button",
    "link",
    "checkbox",
    "radio",
    "combobox",
    "heading",
  ]),
  name: z.string().trim().min(1).max(120),
});

export const journeySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    steps: z
      .array(
        z.discriminatedUnion("action", [
          z.object({ action: z.literal("navigate"), url: z.url() }),
          z.object({ action: z.literal("focus"), target: targetSchema }),
          z.object({ action: z.literal("click"), target: targetSchema }),
          z.object({
            action: z.literal("fill"),
            target: targetSchema,
            value: z.string().max(200),
          }),
          z.object({
            action: z.literal("fillSecret"),
            target: targetSchema,
            secret: z.enum(["USERNAME", "PASSWORD"]),
          }),
          z.object({
            action: z.literal("select"),
            target: targetSchema,
            value: z.string().max(200),
          }),
          z.object({ action: z.literal("check"), target: targetSchema }),
          z.object({
            action: z.literal("assertVisible"),
            target: targetSchema,
          }),
          z.object({
            action: z.literal("audit"),
            label: z.string().trim().max(120).optional(),
          }),
          z.object({ action: z.literal("saveSession") }),
          z.object({ action: z.literal("type"), value: z.string().max(200) }),
          z.object({
            action: z.literal("press"),
            key: z.enum(["Tab", "Shift+Tab", "Escape"]),
          }),
          z.object({ action: z.literal("assertFocus"), target: targetSchema }),
        ]),
      )
      .min(1)
      .max(20),
  })
  .refine(
    (journey) => journey.steps[0]?.action === "navigate",
    "The first step must navigate to a controlled page",
  );

export type Journey = z.infer<typeof journeySchema>;
export type JourneyStep = Journey["steps"][number];
export interface JourneyStepResult {
  sequence: number;
  action: JourneyStep["action"];
  startedAt: string;
  completedAt: string;
  outcome: "PASSED" | "FAILED";
  expected: string | null;
  observed: string | null;
  failure: string | null;
  auditFindings: NormalizedFinding[] | null;
  screenshot: Buffer;
}
export interface JourneyRunResult {
  name: string;
  outcome: "PASSED" | "FAILED";
  steps: JourneyStepResult[];
  screenshot: Buffer;
  session: Awaited<ReturnType<BrowserContext["storageState"]>> | null;
}

async function activeElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return "none";
    const label =
      element.getAttribute("aria-label") ||
      element.id ||
      element.textContent?.trim().slice(0, 80) ||
      "unnamed";
    return `${element.tagName.toLowerCase()}: ${label}`;
  });
}

export async function executeJourney(
  input: unknown,
  allowedOrigin: string,
  pinnedAddress: string | null = null,
  storageState: Awaited<
    ReturnType<BrowserContext["storageState"]>
  > | null = null,
): Promise<JourneyRunResult> {
  const journey = journeySchema.parse(input);
  const browser = await chromium.launch({
    headless: true,
    args: pinnedAddress
      ? [
          `--host-resolver-rules=MAP ${new URL(allowedOrigin).hostname} ${pinnedAddress}`,
        ]
      : [],
  });
  const deadline = setTimeout(() => {
    void browser.close();
  }, 60000);
  let externalRequests = 0;
  let externalBytes = 0;
  const assetCache = new Map<string, Promise<PublicAsset>>();
  const results: JourneyStepResult[] = [];
  const masked: Locator[] = [];
  let savedSession: Awaited<ReturnType<BrowserContext["storageState"]>> | null =
    null;
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: storageState ?? undefined,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    try {
      await context.route("**/*", async (route) => {
        try {
          allowedTarget(route.request().url(), allowedOrigin);
          await route.continue();
        } catch {
          const request = route.request();
          if (
            !["stylesheet", "font", "image", "script"].includes(
              request.resourceType(),
            ) ||
            request.method() !== "GET"
          ) {
            await route.abort();
            return;
          }
          try {
            let pending = assetCache.get(request.url());
            if (!pending) {
              if (++externalRequests > 150)
                throw new Error("Asset count exceeded");
              pending = fetchPublicAsset(request.url()).then((asset) => {
                externalBytes += asset.body.length;
                if (externalBytes > 30 * 1024 * 1024)
                  throw new Error("Asset budget exceeded");
                return asset;
              });
              assetCache.set(request.url(), pending);
            }
            const asset = await pending;
            await route.fulfill({
              status: 200,
              headers: {
                "content-type": asset.contentType,
                ...(asset.cors
                  ? { "access-control-allow-origin": asset.cors }
                  : {}),
              },
              body: asset.body,
            });
          } catch {
            await route.abort();
          }
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      for (const [sequence, step] of journey.steps.entries()) {
        const startedAt = new Date().toISOString();
        let expected: string | null = null;
        let observed: string | null = null;
        let failure: string | null = null;
        let auditFindings: NormalizedFinding[] | null = null;
        try {
          switch (step.action) {
            case "navigate":
              expected = allowedTarget(step.url, allowedOrigin);
              await page.goto(expected, {
                waitUntil: "domcontentloaded",
                timeout: 10000,
              });
              await page
                .waitForLoadState("load", { timeout: 5000 })
                .catch(() => {});
              await page
                .evaluate(() =>
                  Promise.race([
                    document.fonts.ready,
                    new Promise((resolve) => setTimeout(resolve, 2000)),
                  ]),
                )
                .catch(() => {});
              observed = page.url();
              break;
            case "focus":
              expected = `${step.target.role}: ${step.target.name}`;
              await page
                .getByRole(step.target.role, {
                  name: step.target.name,
                  exact: true,
                })
                .focus();
              observed = await activeElement(page);
              break;
            case "click":
              expected = `${step.target.role}: ${step.target.name}`;
              await page
                .getByRole(step.target.role, {
                  name: step.target.name,
                  exact: true,
                })
                .click();
              observed = page.url();
              break;
            case "fill":
              if (step.target.role !== "textbox")
                throw new Error("Fill requires a textbox target");
              expected = `textbox: ${step.target.name}`;
              await page
                .getByRole("textbox", {
                  name: step.target.name,
                  exact: true,
                })
                .fill(step.value);
              observed = "Text entered";
              break;
            case "fillSecret": {
              if (step.target.role !== "textbox")
                throw new Error("Secret fill requires a textbox target");
              const value = process.env[`AOS_JOURNEY_${step.secret}`];
              if (!value)
                throw new Error(
                  `Set AOS_JOURNEY_${step.secret} in the worker environment`,
                );
              expected = `textbox: ${step.target.name}`;
              const locator = page.getByRole("textbox", {
                name: step.target.name,
                exact: true,
              });
              await locator.fill(value);
              masked.push(locator);
              observed = "Secret entered";
              break;
            }
            case "select":
              if (step.target.role !== "combobox")
                throw new Error("Select requires a combobox target");
              expected = `combobox: ${step.target.name}`;
              await page
                .getByRole("combobox", {
                  name: step.target.name,
                  exact: true,
                })
                .selectOption(step.value);
              observed = "Option selected";
              break;
            case "check":
              if (!["checkbox", "radio"].includes(step.target.role))
                throw new Error("Check requires a checkbox or radio target");
              expected = `${step.target.role}: ${step.target.name}`;
              await page
                .getByRole(step.target.role, {
                  name: step.target.name,
                  exact: true,
                })
                .check();
              observed = "Checked";
              break;
            case "assertVisible":
              expected = `${step.target.role}: ${step.target.name}`;
              await page
                .getByRole(step.target.role, {
                  name: step.target.name,
                  exact: true,
                })
                .waitFor({ state: "visible" });
              observed = "Visible";
              break;
            case "audit": {
              expected = step.label ?? "Current page";
              const result = await new AxeBuilder({ page }).analyze();
              auditFindings = normalizeFindings(
                result.violations,
                page.url(),
              ).slice(0, 100);
              observed = `${auditFindings.length} automated findings on ${page.url()}`;
              break;
            }
            case "saveSession": {
              expected = "Reusable session for this project";
              const raw = await context.storageState({ indexedDB: true });
              const host = new URL(allowedOrigin).hostname;
              savedSession = {
                cookies: raw.cookies.filter((cookie) => {
                  const domain = cookie.domain.replace(/^\./, "");
                  return host === domain || host.endsWith(`.${domain}`);
                }),
                origins: raw.origins.filter(
                  (entry) => entry.origin === allowedOrigin,
                ),
              };
              if (
                savedSession.cookies.length === 0 &&
                savedSession.origins.every(
                  (entry) =>
                    entry.localStorage.length === 0 &&
                    ((entry as typeof entry & { indexedDB?: unknown[] })
                      .indexedDB?.length ?? 0) === 0,
                )
              )
                throw new Error(
                  "No reusable cookies or origin storage found after sign-in",
                );
              observed = `${savedSession.cookies.length} cookies and ${savedSession.origins.length} origin stores saved`;
              break;
            }
            case "type":
              expected = "Focused editable control accepts synthetic text";
              if (
                !(await page.evaluate(() => {
                  const active = document.activeElement;
                  return (
                    active instanceof HTMLInputElement ||
                    active instanceof HTMLTextAreaElement ||
                    (active instanceof HTMLElement && active.isContentEditable)
                  );
                }))
              )
                throw new Error("No editable control has focus");
              await page.keyboard.type(step.value);
              observed = "Synthetic text entered";
              break;
            case "press":
              expected = step.key;
              await page.keyboard.press(step.key);
              observed = await activeElement(page);
              break;
            case "assertFocus": {
              expected = `${step.target.role}: ${step.target.name}`;
              const locator = page.getByRole(step.target.role, {
                name: step.target.name,
                exact: true,
              });
              if ((await locator.count()) !== 1)
                throw new Error(
                  "Expected focus target was missing or ambiguous",
                );
              const focused = await locator.evaluate(
                (element) => element === document.activeElement,
              );
              observed = await activeElement(page);
              if (!focused)
                throw new Error(
                  `Expected focus on ${expected}; observed ${observed}`,
                );
              break;
            }
          }
        } catch (error) {
          failure =
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown step failure";
          if (step.action === "type") observed = "Editable target unavailable";
          else
            observed ??= await activeElement(page).catch(() => "unavailable");
        }
        results.push({
          sequence,
          action: step.action,
          startedAt,
          completedAt: new Date().toISOString(),
          outcome: failure ? "FAILED" : "PASSED",
          expected,
          observed,
          failure,
          auditFindings,
          screenshot: await page.screenshot({
            fullPage: false,
            timeout: 5000,
            mask: masked,
          }),
        });
        if (failure) break;
      }
      return {
        name: journey.name,
        outcome: results.some((step) => step.outcome === "FAILED")
          ? "FAILED"
          : "PASSED",
        steps: results,
        screenshot: results.at(-1)!.screenshot,
        session: results.some((step) => step.outcome === "FAILED")
          ? null
          : savedSession,
      };
    } finally {
      await context.close();
    }
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}
