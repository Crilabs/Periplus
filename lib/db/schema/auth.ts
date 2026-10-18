import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    email: text("email").notNull(),
    ip: text("ip").notNull(),
    success: boolean("success").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_email_at_idx").on(t.email, t.at), index("login_attempts_ip_at_idx").on(t.ip, t.at)],
);

export const apiClients = pgTable("api_clients", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  name: text("name").notNull().unique(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes").array().notNull().default([]),
  rateLimitPerMin: integer("rate_limit_per_min").notNull().default(60),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
