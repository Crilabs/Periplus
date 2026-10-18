import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../lib/db/client";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

export async function migrate(url: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    await drizzleMigrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is not set\n");
    process.exit(1);
  }
  migrate(url).then(
    () => process.stdout.write("migrations applied\n"),
    (err: unknown) => {
      process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
