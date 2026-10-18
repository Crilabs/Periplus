import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "lib/db/schema/index.ts",
  out: "drizzle",
  extensionsFilters: ["postgis"],
});
