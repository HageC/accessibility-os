import AxeBuilder from "@axe-core/playwright";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createHash } from "node:crypto";
import { allowedTarget, fetchPublicAsset, type PublicAsset } from "@aos/shared";

export interface NormalizedFinding {
  fingerprint: string;
  ruleId: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  target: string[];
  html: string;
  failureSummary: string | null;
  tags: string[];
  wcag: string[];
}

export interface FocusObservation {
  sequence: number;
  direction: "FORWARD" | "BACKWARD";
  pageUrl: string;
  selector: string | null;
  tagName: string | null;
  role: string | null;
  name: string | null;
  elementId: string | null;
  elementText: string | null;
  isBody: boolean;
  screenshot: Buffer;
}

export async function recordFocusSequence(
  page: Page,
  forwardSteps = 8,
  backwardSteps = 3,
): Promise<FocusObservation[]> {
  if (
    forwardSteps < 0 ||
    backwardSteps < 0 ||
    forwardSteps + backwardSteps > 20
  ) {
    throw new Error("Focus sequence must contain at most 20 keyboard steps");
  }
  const observations: FocusObservation[] = [];
  for (let index = 0; index < forwardSteps + backwardSteps; index += 1) {
    const direction = index < forwardSteps ? "FORWARD" : "BACKWARD";
    await page.keyboard.press(direction === "FORWARD" ? "Tab" : "Shift+Tab");
    const element = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const selector = (() => {
        if (active.id) return `#${CSS.escape(active.id)}`;
        const segments: string[] = [];
        let node: HTMLElement | null = active;
        while (node && node !== document.body && segments.length < 6) {
          const parent: HTMLElement | null = node.parentElement;
          const peers = parent
            ? Array.from(parent.children).filter(
                (child) => child.tagName === node!.tagName,
              )
            : [];
          const position = peers.indexOf(node) + 1;
          segments.unshift(
            `${node.tagName.toLowerCase()}:nth-of-type(${position})`,
          );
          node = parent;
        }
        return segments.length ? `body > ${segments.join(" > ")}` : "body";
      })();
      const labels =
        "labels" in active && active.labels instanceof NodeList
          ? Array.from(active.labels)
              .map((label) => label.textContent?.trim())
              .filter(Boolean)
              .join(" ")
          : "";
      const name =
        active.getAttribute("aria-label") ||
        (active
          .getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean)
          .join(" ") ??
          "") ||
        labels ||
        active.getAttribute("alt") ||
        active.getAttribute("title") ||
        active.textContent?.trim().slice(0, 120) ||
        null;
      return {
        selector,
        tagName: active.tagName.toLowerCase(),
        role:
          active.getAttribute("role") ||
          (
            {
              A: "link",
              BUTTON: "button",
              INPUT: "textbox",
              SELECT: "combobox",
              TEXTAREA: "textbox",
            } as Record<string, string>
          )[active.tagName] ||
          null,
        name: name?.slice(0, 200) ?? null,
        elementId: active.id || null,
        elementText: active.textContent?.trim().slice(0, 200) || null,
        isBody: active === document.body,
      };
    });
    observations.push({
      sequence: index,
      direction,
      pageUrl: page.url(),
      selector: element?.selector ?? null,
      tagName: element?.tagName ?? null,
      role: element?.role ?? null,
      name: element?.name ?? null,
      elementId: element?.elementId ?? null,
      elementText: element?.elementText ?? null,
      isBody: element?.isBody ?? false,
      screenshot: await page.screenshot({ fullPage: false, timeout: 10000 }),
    });
  }
  return observations;
}

type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

export function normalizeFindings(
  violations: AxeViolation[],
  pageUrl: string,
): NormalizedFinding[] {
  const path = new URL(pageUrl).pathname;
  return violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      fingerprint: createHash("sha256")
        .update(JSON.stringify([violation.id, path, node.target]))
        .digest("hex"),
      ruleId: violation.id,
      impact: node.impact ?? violation.impact ?? null,
      description: violation.description,
      help: violation.help,
      helpUrl: violation.helpUrl,
      target: node.target.map((part) =>
        typeof part === "string" ? part : JSON.stringify(part),
      ),
      html: node.html.slice(0, 10000),
      failureSummary: node.failureSummary?.slice(0, 10000) ?? null,
      tags: violation.tags,
      wcag: violation.tags.filter((tag) => /^wcag\d/.test(tag)),
    })),
  );
}

export interface ScannedPage {
  url: string;
  title: string;
  findings: NormalizedFinding[];
  screenshot: Buffer;
}

export interface SiteScanResult {
  pages: ScannedPage[];
  focusObservations: FocusObservation[];
  focusScreenshot: Buffer;
}

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
}

async function sitemapUrls(
  context: BrowserContext,
  origin: string,
  limit: number,
): Promise<string[]> {
  const page = await context.newPage();
  const sitemapFiles = [new URL("/sitemap.xml", origin).toString()];
  const discovered = new Set<string>();
  try {
    const robots = await page
      .goto(new URL("/robots.txt", origin).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      })
      .catch(() => null);
    if (robots?.ok()) {
      const text = (await robots.text()).slice(0, 100_000);
      for (const match of text.matchAll(/^sitemap:\s*(\S+)/gim)) {
        try {
          const url = allowedTarget(
            new URL(match[1]!, origin).toString(),
            origin,
          );
          if (!sitemapFiles.includes(url)) sitemapFiles.push(url);
        } catch {
          /* Sitemap is outside the selected origin. */
        }
      }
    }
    const visited = new Set<string>();
    while (sitemapFiles.length && visited.size < 5 && discovered.size < limit) {
      const url = sitemapFiles.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const response = await page
        .goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 7000,
        })
        .catch(() => null);
      if (!response?.ok()) continue;
      const xml = (await response.text()).slice(0, 1_000_000);
      for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        try {
          const candidate = allowedTarget(
            new URL(match[1]!.replaceAll("&amp;", "&"), origin).toString(),
            origin,
          );
          if (/\.xml(?:\?|$)/i.test(candidate)) {
            if (!visited.has(candidate)) sitemapFiles.push(candidate);
          } else if (
            !/\.(?:pdf|zip|png|jpe?g|gif|svg|webp|mp4|webm|css|js)(?:\?|$)/i.test(
              candidate,
            )
          ) {
            discovered.add(candidate);
          }
          if (discovered.size >= limit) break;
        } catch {
          /* Sitemap entry is outside the selected origin. */
        }
      }
    }
    return [...discovered];
  } finally {
    await page.close();
  }
}

export async function scanSite(
  url: string,
  allowedOrigin: string,
  pinnedAddress: string | null = null,
  options: CrawlOptions = { maxPages: 8, maxDepth: 2 },
): Promise<SiteScanResult> {
  if (
    !Number.isInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > 100 ||
    !Number.isInteger(options.maxDepth) ||
    options.maxDepth < 0 ||
    options.maxDepth > 6
  )
    throw new Error("Scan scope must be 1–100 pages and 0–6 link levels");
  const target = allowedTarget(url, allowedOrigin);
  const browser = await chromium.launch({
    headless: true,
    args: pinnedAddress
      ? [
          `--host-resolver-rules=MAP ${new URL(target).hostname} ${pinnedAddress}`,
        ]
      : [],
  });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void browser.close();
  }, 300000);
  let externalRequests = 0;
  let externalBytes = 0;
  const assetCache = new Map<string, Promise<PublicAsset>>();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: options.storageState,
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
      page.setDefaultTimeout(10000);
      const queue: { url: string; depth: number }[] = [
        { url: target, depth: 0 },
      ];
      const seen = new Set([target]);
      const pages: ScannedPage[] = [];
      let sitemapQueued = false;
      let focusObservations: FocusObservation[] = [];
      let focusScreenshot: Buffer = Buffer.alloc(0);
      while (queue.length && pages.length < options.maxPages) {
        const next = queue.shift()!;
        try {
          const response = await page.goto(next.url, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          const contentType = response?.headers()["content-type"] ?? "";
          if (
            !contentType.includes("text/html") &&
            !contentType.includes("application/xhtml+xml")
          )
            throw new Error("Page did not return HTML");
          const currentUrl = allowedTarget(page.url(), allowedOrigin);
          seen.add(currentUrl);
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
          const result = await new AxeBuilder({ page }).analyze();
          const screenshot = await page.screenshot({
            fullPage: false,
            timeout: 10000,
          });
          const links =
            next.depth < options.maxDepth
              ? await page
                  .locator("a[href]")
                  .evaluateAll((anchors) =>
                    anchors
                      .slice(0, 200)
                      .map((anchor) => (anchor as HTMLAnchorElement).href),
                  )
              : [];
          pages.push({
            url: currentUrl,
            title: await page.title(),
            findings: normalizeFindings(result.violations, currentUrl),
            screenshot,
          });
          if (pages.length === 1) {
            focusObservations = await recordFocusSequence(page);
            focusScreenshot =
              focusObservations.at(-1)?.screenshot ?? Buffer.alloc(0);
          }
          for (const href of links) {
            try {
              const candidate = allowedTarget(href, allowedOrigin);
              if (
                seen.has(candidate) ||
                queue.length >= options.maxPages * 4 ||
                /\.(?:pdf|zip|png|jpe?g|gif|svg|webp|mp4|webm|css|js)(?:\?|$)/i.test(
                  candidate,
                )
              )
                continue;
              seen.add(candidate);
              queue.push({ url: candidate, depth: next.depth + 1 });
            } catch {
              /* Outside this scan's exact origin. */
            }
          }
          if (!sitemapQueued && options.maxDepth > 0) {
            sitemapQueued = true;
            for (const href of await sitemapUrls(
              context,
              allowedOrigin,
              options.maxPages * 2,
            ).catch(() => [])) {
              if (seen.has(href) || queue.length >= options.maxPages * 4)
                continue;
              seen.add(href);
              queue.push({ url: href, depth: 1 });
            }
          }
        } catch (error) {
          if (timedOut || pages.length === 0) throw error;
        }
      }
      return { pages, focusObservations, focusScreenshot };
    } finally {
      await context.close();
    }
  } catch (error) {
    if (timedOut) throw new Error("SCAN_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}

export async function scanPage(
  url: string,
  allowedOrigin: string,
  pinnedAddress: string | null = null,
): Promise<
  ScannedPage & {
    focusObservations: FocusObservation[];
    focusScreenshot: Buffer;
  }
> {
  const result = await scanSite(url, allowedOrigin, pinnedAddress, {
    maxPages: 1,
    maxDepth: 0,
  });
  return {
    ...result.pages[0]!,
    focusObservations: result.focusObservations,
    focusScreenshot: result.focusScreenshot,
  };
}
