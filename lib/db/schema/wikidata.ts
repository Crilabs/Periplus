import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Working state: number of sitelinks (all wikis) per Wikidata item (importance signal, ruling M5-P1). */
export const wikidataSitelinks = pgTable("wikidata_sitelinks", {
  wikidataId: text("wikidata_id").primaryKey(),
  sitelinks: integer("sitelinks").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});
