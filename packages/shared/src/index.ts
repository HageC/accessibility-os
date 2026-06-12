import { z } from "zod";
import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
export { fetchPublicAsset, type PublicAsset } from "./public-asset.js";

export const projectInput = z.object({
  name: z.string().trim().min(2).max(120),
  url: z.string().url().max(2048),
});

export function allowedTarget(input: string, allowedOrigin: string): string {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== new URL(allowedOrigin).origin
  ) {
    throw new Error("Target must be on the configured local fixture origin");
  }
  url.hash = "";
  return url.toString();
}

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 &&
      ((b === 0 && c === 0) ||
        (b === 0 && c === 2) ||
        (b === 88 && c === 99) ||
        b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export async function validateScanTarget(
  input: string,
  fixtureOrigin: string,
  resolveAddresses: (hostname: string) => Promise<string[]> = resolve4,
): Promise<{ url: string; origin: string; address: string | null }> {
  const url = new URL(input);
  if (url.origin === new URL(fixtureOrigin).origin) {
    return {
      url: allowedTarget(input, fixtureOrigin),
      origin: url.origin,
      address: null,
    };
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    isIP(url.hostname) ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    url.hostname.endsWith(".") ||
    !url.hostname.includes(".")
  ) {
    throw new Error(
      "Use a public HTTPS website URL without credentials or a custom port",
    );
  }
  const addresses = await resolveAddresses(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !publicIpv4(address))
  ) {
    throw new Error(
      "Website address is private, reserved, or could not be resolved safely",
    );
  }
  url.hash = "";
  return { url: url.toString(), origin: url.origin, address: addresses[0]! };
}

export type ScanStatus =
  "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMED_OUT";
