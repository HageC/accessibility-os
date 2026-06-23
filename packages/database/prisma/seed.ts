import "dotenv/config";
import { db } from "../src/index.js";

async function main() {
  const url = `${process.env.SCAN_ALLOWED_ORIGIN ?? "http://127.0.0.1:3000"}/fixture.html`;
  const existing = await db.project.findFirst({ where: { url } });
  if (!existing)
    await db.project.create({
      data: { name: "Accessibility test fixture", url },
    });
}
main().finally(() => db.$disconnect());
