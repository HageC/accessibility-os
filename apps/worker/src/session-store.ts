import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let keyPromise: Promise<Buffer> | null = null;

async function encryptionKey(artifactDir: string): Promise<Buffer> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const dir = resolve("../../", artifactDir);
      await mkdir(dir, { recursive: true });
      const keyPath = resolve(dir, "session.key");
      try {
        const handle = await open(keyPath, "wx", 0o600);
        try {
          await handle.writeFile(randomBytes(32));
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const key = await readFile(keyPath);
      if (key.length !== 32) throw new Error("Invalid session encryption key");
      return key;
    })();
  }
  return keyPromise;
}

export async function encryptSession(
  state: StorageState,
  artifactDir: string,
): Promise<string> {
  const plaintext = Buffer.from(JSON.stringify(state));
  if (plaintext.length > 2 * 1024 * 1024)
    throw new Error("Browser session is too large");
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    await encryptionKey(artifactDir),
    iv,
  );
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export async function decryptSession(
  ciphertext: string,
  artifactDir: string,
): Promise<StorageState> {
  const data = Buffer.from(ciphertext, "base64");
  if (data.length < 29 || data.length > 2 * 1024 * 1024 + 64)
    throw new Error("Invalid browser session");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await encryptionKey(artifactDir),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  ) as StorageState;
}
