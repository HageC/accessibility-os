import { request } from "node:https";
import { validateScanTarget } from "./index.js";

export interface PublicAsset {
  body: Buffer;
  contentType: string;
  cors: string | null;
}

const MAX_ASSET_BYTES = 3 * 1024 * 1024;

export async function fetchPublicAsset(
  input: string,
  redirects = 0,
): Promise<PublicAsset> {
  if (redirects > 3) throw new Error("Too many asset redirects");
  const target = await validateScanTarget(input, "http://fixture.invalid");
  if (!target.address) throw new Error("Asset requires a public HTTPS address");
  return new Promise<PublicAsset>((resolve, reject) => {
    const url = new URL(target.url);
    const req = request(
      url,
      {
        method: "GET",
        lookup: (_hostname, options, callback) => {
          if (options.all)
            callback(null, [{ address: target.address!, family: 4 }]);
          else callback(null, target.address!, 4);
        },
        headers: {
          "accept-encoding": "identity",
          "user-agent": "AccessibilityOS/0.1",
        },
        timeout: 7000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          void fetchPublicAsset(
            new URL(response.headers.location, url).toString(),
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`Asset returned HTTP ${status}`));
          return;
        }
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (declaredLength > MAX_ASSET_BYTES) {
          response.destroy();
          reject(new Error("Asset is too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ASSET_BYTES) {
            response.destroy(new Error("Asset is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            contentType: String(
              response.headers["content-type"] ?? "application/octet-stream",
            ),
            cors:
              typeof response.headers["access-control-allow-origin"] ===
              "string"
                ? response.headers["access-control-allow-origin"]
                : null,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Asset timed out")));
    req.on("error", reject);
    req.end();
  });
}
