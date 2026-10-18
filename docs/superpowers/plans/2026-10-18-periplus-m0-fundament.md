# Periplus M0 – Fundament Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Periplus skeleton: database with all extensions and base tables, admin login, default-deny proxy, worker with pg-boss and runs, cost ledger with budgets, archive adapter, model adapter skeleton, admin shell with empty map, production compose, CI/CD and backups.

**Architecture:** One repo, two entry points: Next.js 16 (admin UI, API, health) and `worker/index.ts` (pg-boss handlers). Both share `lib/`. Postgres 17 + PostGIS/pgvector via Drizzle; pg-boss lives in the same database (schema `pgboss`). The web app never runs pipeline work, it only enqueues jobs and reads results.

**Tech Stack:** Next.js 16.4.2, React 19.3, Tailwind 4, TypeScript 5 strict, Drizzle ORM 0.45 + drizzle-kit 0.31, pg 8, pg-boss 12, jose 6, @node-rs/argon2 2, zod 4, pino 10, @aws-sdk/client-s3 3, @anthropic-ai/sdk (current), maplibre-gl 6, Vitest 5, Playwright 1.64, tsx 4.

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-01-fundament-design.md` (primary), `…-02-datenmodell-design.md` (base tables, mutation triggers, IDs), `…-09-admin-ui-design.md` (shell pages), overall `…-periplus-design.md`. Domain source: `.idea/datendienst-spec.md`.

## Global Constraints

- Node `>=22`; keep `next` at `16.4.2`, `react`/`react-dom` at `19.3.0` (already in `package.json`).
- Before touching `proxy.ts`, route handlers, `next.config.ts` or pages using `cookies()`: read the matching file in `node_modules/next/dist/docs/` (`AGENTS.md`). `next.config.ts` has `cacheComponents: true`; pages reading cookies or the DB must follow the Cache Components rules in those docs (dynamic data inside `<Suspense>` or opt out per the docs).
- `proxy.ts` runs on the Node.js runtime; never set `runtime` in it.
- Code, identifiers, tables, enum values, log messages, test names: English. Everything a user reads in the UI: German.
- No `console.*` (ESLint error); log only via `createLogger(module)` from `lib/logger.ts`.
- Business logic only in `lib/domain`, `lib/pipeline`, `lib/jobs`, `lib/security`; `app/` files stay thin.
- Never log passwords, API keys, session tokens, cookies, `authorization` headers.
- Secrets only from environment (`.env.local` in dev, `.env` on the server). Config files in `config/` are validated with zod at startup; invalid config aborts startup.
- Tests: Vitest against the real `db-test` Postgres (`TEST_DATABASE_URL`, database name must end in `_test`) and the local S3 (`s3` service, bucket `periplus-test`). No test calls the internet; AI only via `MockModel`.
- Append-only tables reject `UPDATE`/`DELETE` via the trigger function `forbid_mutation()`.
- Every route under `app/` producing a URL has an entry in `lib/security/route-policy.ts`.
- Attempts per job: 3 (pg-boss `retryLimit: 2`), backoff starting at 60 s.
- Session: 12 h sliding, 7 days absolute, cookie `periplus_session`, httpOnly, Secure in production, SameSite=Lax.
- Login limit: 10 failed attempts per 15 min per IP and per email.
- Commit after every task with the `Co-Authored-By` trailer from the session.

## Review Focus

1. Paths that dodge the policy (`/Runs`, `/runs/`, `/api/v1//ping`, percent-encoded segments) must get the same decision as the canonical path or a 404, never an unauthenticated page. → Task 7 test `decideAccess normalizes path variants`.
2. A session cookie that is tampered, expired, or past the 7-day absolute limit must redirect to `/login`, never 500. → Task 5 tests.
3. The 11th failed login within 15 min must be rejected as `rate_limited` even when the password is right. → Task 5 test.
4. A job that throws on all 3 attempts must create exactly one `failed_job` review task, and sibling jobs of the same run must still finish. → Task 11 test.
5. Reaching a daily budget mid-run must pause the affected queue (jobs wait, they do not fail) and resuming must continue them. → Task 10 + Task 11 tests.

---

## File Structure

```
package.json, vitest.config.mts, eslint.config.mjs, drizzle.config.ts, next.config.ts   (modify/create)
lib/env.ts                         env parsing (zod), lazy getEnv()
lib/logger.ts                      pino, createLogger(), redaction
lib/config/index.ts                load + validate config/*.json, getConfig()
lib/config/schemas.ts              zod schemas for queues.json, budgets.json, models.json
config/queues.json, budgets.json, models.json, prompts/system.echo/v1.md
lib/db/client.ts                   getDb(), createDb()
lib/db/schema/{index,auth,ops,review}.ts
drizzle/0000_extensions.sql, 0001_*.sql (generated), 0002_forbid_mutation.sql
scripts/migrate.ts                 apply migrations to DATABASE_URL
lib/domain/ids.ts                  newId(), newPublicId(), isPublicId()
lib/security/password.ts, session.ts, api-keys.ts, route-policy.ts, access.ts, require-admin.ts
lib/domain/users.ts, api-clients.ts, costs.ts, rate-limit.ts, runs.ts, review.ts
lib/api/handler.ts                 withApiClient()
lib/adapters/s3.ts                 Archive
lib/jobs/{boss,queues,registry,controls}.ts, lib/jobs/handlers/system-ping.ts
lib/pipeline/runs.ts               startRun(), stage registry
lib/ai/{types,prompts,anthropic,mock}.ts, lib/ai/tasks/system-echo.ts
worker/index.ts
proxy.ts
app/login/{page.tsx,actions.ts}, app/healthz/route.ts, app/readyz/route.ts, app/api/v1/ping/route.ts
app/(admin)/{layout.tsx,page.tsx,actions.ts}, app/(admin)/{map,runs,runs/[id],jobs,costs,settings}/page.tsx
app/(admin)/_components/{nav.tsx,map-view.tsx}
scripts/user.ts, scripts/apikey.ts, scripts/smoke-ai.ts
test/{global-setup.ts,db.ts,s3.ts}
docker/web.Dockerfile, docker/worker.Dockerfile, docker/compose.prod.yml, docker/Caddyfile
.github/workflows/ci.yml, scripts/deploy/deploy.sh, scripts/server/bootstrap.sh, scripts/ops/backup.sh
docs/runbook.md
e2e/login.spec.ts, playwright.config.ts
```

---

### Task 1: Tooling, env, logger, config

**Files:**
- Modify: `package.json`, `eslint.config.mjs`, `tsconfig.json` (target `ES2022`)
- Create: `vitest.config.mts`, `lib/env.ts`, `lib/logger.ts`, `lib/config/schemas.ts`, `lib/config/index.ts`, `config/queues.json`, `config/budgets.json`, `config/models.json`
- Test: `lib/__tests__/env.test.ts`, `lib/__tests__/logger.test.ts`, `lib/config/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  - `type Env = { DATABASE_URL: string; SESSION_SECRET: string; S3_ENDPOINT: string; S3_REGION: string; S3_BUCKET: string; S3_ACCESS_KEY_ID: string; S3_SECRET_ACCESS_KEY: string; ANTHROPIC_API_KEY?: string; CONTACT_EMAIL: string; LOG_LEVEL: "debug"|"info"|"warn"|"error"; NODE_ENV: "development"|"test"|"production" }`
  - `parseEnv(source: Record<string, string | undefined>): Env` (throws `ZodError` with variable names, never values), `getEnv(): Env` (memoized)
  - `createLogger(module: string): pino.Logger`
  - `type QueueConfig = { concurrency: number; retryLimit: number; retryDelaySeconds: number; retryBackoff: boolean }`
  - `type BudgetService = "anthropic" | "voyage" | "dataforseo" | "firecrawl" | "jina"`
  - `type AppConfig = { queues: Record<string, QueueConfig>; budgets: Record<BudgetService, { dailyEur: number }>; models: { tasks: Record<string, { model: string; promptVersion: number }>; pricesEurPerMTok: Record<string, { input: number; output: number }> } }`
  - `loadConfig(dir?: string): AppConfig` (default `config`), `getConfig(): AppConfig` (memoized)

- [ ] **Step 1: Install dependencies**

Run: `npm install drizzle-orm@0.45 pg@8 pg-boss@12 jose@6 @node-rs/argon2@2 zod@4 pino@10 @aws-sdk/client-s3@3 @anthropic-ai/sdk maplibre-gl@6 uuid@14 ulid@3 tsx@4 && npm install -D drizzle-kit@0.31 vitest@5 @vitest/coverage-v8@5 @types/pg pino-pretty@13 @playwright/test@1.64`
Expected: exit 0.

Add scripts: `"typecheck": "tsc --noEmit"`, `"lint": "eslint . --max-warnings 0"`, `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:e2e": "playwright test"`, `"worker": "tsx watch worker/index.ts"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate": "tsx scripts/migrate.ts"`, `"user:create": "tsx scripts/user.ts create"`, `"user:password": "tsx scripts/user.ts password"`, `"apikey:create": "tsx scripts/apikey.ts create"`, `"smoke:ai": "tsx scripts/smoke-ai.ts"`. Scripts load `.env.local` via `node --env-file-if-exists=.env.local` (use `tsx --env-file-if-exists=.env.local`).

ESLint: add rule `"no-console": "error"`; ignore `drizzle/**`, `playwright-report/**`.

- [ ] **Step 2: Write failing tests**

```ts
// lib/__tests__/env.test.ts
it("parses a complete env and defaults LOG_LEVEL to info", () => {
  expect(parseEnv(validSource).LOG_LEVEL).toBe("info");
});
it("rejects a SESSION_SECRET shorter than 32 chars without echoing the value", () => {
  expect(() => parseEnv({ ...validSource, SESSION_SECRET: "short-secret-value" }))
    .toThrow(/SESSION_SECRET/);
  try { parseEnv({ ...validSource, SESSION_SECRET: "short-secret-value" }); }
  catch (e) { expect(String(e)).not.toContain("short-secret-value"); }
});
it("does not read process.env at import time", async () => {
  vi.stubEnv("DATABASE_URL", "");
  await expect(import("../env")).resolves.toBeDefined();
});

// lib/__tests__/logger.test.ts
it("redacts password, apiKey, authorization and cookie fields", () => {
  const lines = captureLogs(log => log.info({ password: "p", apiKey: "k", headers: { authorization: "a", cookie: "c" } }, "x"));
  expect(lines[0]).not.toMatch(/"p"|"k"|"a"|"c"/);
  expect(lines[0]).toContain("[Redacted]");
});

// lib/config/__tests__/config.test.ts
it("loads the repo config", () => {
  const c = loadConfig("config");
  expect(c.queues["system.ping"].retryLimit).toBe(2);
  expect(c.budgets.anthropic.dailyEur).toBeGreaterThan(0);
});
it("rejects a queue with concurrency 0", () => {
  expect(() => loadConfig(fixtureDir({ queues: { "system.ping": { concurrency: 0, retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true } } }))).toThrow(/concurrency/);
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npx vitest run lib/__tests__ lib/config`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`vitest.config.mts`: `globalSetup: ["test/global-setup.ts"]` comes in Task 2; for now environment `node`, `include: ["**/__tests__/**/*.test.ts", "test/**/*.test.ts"]`, path alias `@` → repo root.
`lib/logger.ts`: pino with `level` from `getEnv().LOG_LEVEL` (fallback `info` if env invalid in tests), redact paths `["password","passwordHash","apiKey","key","token","*.password","*.apiKey","headers.authorization","headers.cookie","authorization","cookie"]`, `pino-pretty` transport only when `NODE_ENV=development`.
`config/queues.json`: `{ "system.ping": { "concurrency": 2, "retryLimit": 2, "retryDelaySeconds": 60, "retryBackoff": true } }`.
`config/budgets.json`: `{ "anthropic": { "dailyEur": 20 }, "voyage": { "dailyEur": 5 }, "dataforseo": { "dailyEur": 10 }, "firecrawl": { "dailyEur": 5 }, "jina": { "dailyEur": 5 } }`.
`config/models.json`: `tasks.system.echo = { model: "claude-haiku-5-5", promptVersion: 1 }`; `pricesEurPerMTok` for `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` taken from the current Anthropic pricing page at implementation time (convert USD→EUR at the day's rate, note the date in the commit message).

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx vitest run lib/__tests__ lib/config && npm run lint && npm run typecheck`
Expected: PASS, lint and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: add tooling, env parsing, logger and config loading"
```

---

### Task 2: Database plumbing and test harness

**Files:**
- Create: `drizzle.config.ts`, `lib/db/client.ts`, `lib/db/schema/index.ts`, `drizzle/0000_extensions.sql`, `scripts/migrate.ts`, `test/global-setup.ts`, `test/db.ts`
- Modify: `vitest.config.mts` (add `globalSetup`)
- Test: `lib/db/__tests__/client.test.ts`

**Interfaces:**
- Consumes: `getEnv()` (Task 1)
- Produces:
  - `type Db = NodePgDatabase<typeof schema>`
  - `getDb(): Db` (lazy singleton pool from `DATABASE_URL`), `createDb(url: string): { db: Db; close(): Promise<void> }`
  - `migrate(url: string): Promise<void>` in `scripts/migrate.ts` (exported for the test setup), CLI runs it against `DATABASE_URL`
  - `testDb(): Db` in `test/db.ts` (one pool per test worker on `TEST_DATABASE_URL`)

- [ ] **Step 1: Write failing test**

```ts
// lib/db/__tests__/client.test.ts
it("has all extensions after migration", async () => {
  const rows = await testDb().execute(sql`select extname from pg_extension`);
  expect(rows.rows.map(r => r.extname)).toEqual(expect.arrayContaining(["postgis","postgis_raster","vector","pg_trgm","unaccent"]));
});
it("importing the client module without DATABASE_URL does not throw", async () => {
  vi.stubEnv("DATABASE_URL", "");
  await expect(import("../client")).resolves.toHaveProperty("getDb");
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm run services:up && npx vitest run lib/db`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`drizzle/0000_extensions.sql` is a custom migration (`drizzle-kit generate --custom --name extensions`) with `CREATE EXTENSION IF NOT EXISTS` for the five extensions. `drizzle.config.ts`: dialect `postgresql`, schema `lib/db/schema/index.ts`, out `drizzle`, `extensionsFilters: ["postgis"]`. `test/global-setup.ts`: read `TEST_DATABASE_URL`, abort with a clear error unless the database name ends in `_test`, then `migrate(url)`. `scripts/migrate.ts` uses `drizzle-orm/node-postgres/migrator`.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run lib/db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): add drizzle client, migrations and test database harness"
```

---

### Task 3: Base tables, mutation trigger, IDs

**Files:**
- Create: `lib/db/schema/auth.ts`, `lib/db/schema/ops.ts`, `lib/db/schema/review.ts`, `drizzle/0001_*.sql` (generated), `drizzle/0002_forbid_mutation.sql` (custom), `lib/domain/ids.ts`
- Modify: `lib/db/schema/index.ts`
- Test: `lib/db/__tests__/schema.test.ts`, `lib/domain/__tests__/ids.test.ts`

**Interfaces:**
- Produces (Drizzle tables; all `id uuid primary key` default via `newId()`, `created_at timestamptz default now()`):
  - `users`: `email text unique not null`, `passwordHash text not null`, `lastLoginAt`, `disabledAt`
  - `loginAttempts`: `email text`, `ip text`, `success boolean`, `at timestamptz`; index (email, at), (ip, at)
  - `apiClients`: `name text unique`, `keyHash text unique`, `scopes text[]`, `rateLimitPerMin int default 60`, `revokedAt`
  - `runs`: `kind` enum `full|stage|revisit|event|reprocess|system`, `scopeType` enum `tile|area|place|source|system`, `scopeId text`, `stages text[]`, `params jsonb`, `triggeredBy text`, `status` enum `queued|running|finished|failed`, `startedAt`, `finishedAt`
  - `runStages`: `runId`, `stage text`, `ordinal int`, `total int`, `done int`, `failed int`, `status` enum `pending|running|finished`; unique (runId, stage)
  - `externalCalls`: `service text`, `operation text`, `units numeric`, `unit text`, `costEur numeric(12,6)`, `runId uuid null`, `tileId text null`, `stage text null`, `meta jsonb`, `at timestamptz`; index (service, at)
  - `rateLimits`: `key text primary key`, `tokens double precision`, `updatedAt timestamptz`
  - `queueControls`: `queue text primary key`, `pausedUntil timestamptz null`, `reason text null`, `updatedBy text`
  - `workerHeartbeats`: `workerId text primary key`, `host text`, `startedAt`, `beatAt`
  - `reviewTasks`: `kind` enum (`source_approval|place_candidate|conflict|failed_job|coast_tile_without_area|uncertain_change|comparison_deviation`), `subjectType text`, `subjectId text`, `context jsonb`, `status` enum `open|decided|dismissed`, `priority int default 0`
  - `reviewDecisions` (append-only): `taskId`, `decision jsonb`, `decidedBy text`, `decidedAt`, `durationMs int`
  - exported types `ReviewKind`, `RunStatus`, `RunKind` derived from the enums
  - SQL function `forbid_mutation()` (trigger arg: comma-separated whitelist of updatable columns) and trigger on `review_decisions` with empty whitelist
  - `newId(): string` (UUIDv7), `type PublicIdPrefix = "sp" | "hl" | "rg" | "ar"`, `newPublicId(prefix: PublicIdPrefix): string` → `${prefix}_${ulid()}`, `isPublicId(value: string, prefix: PublicIdPrefix): boolean`

- [ ] **Step 1: Write failing tests**

```ts
// lib/db/__tests__/schema.test.ts
it("rejects UPDATE on review_decisions", async () => {
  const id = await insertDecision(testDb());
  await expect(testDb().execute(sql`update review_decisions set decided_by='x' where id=${id}`)).rejects.toThrow(/append-only/);
});
it("rejects DELETE on review_decisions", async () => { /* same with delete */ });
it("forbid_mutation allows whitelisted columns", async () => {
  // create a temp table with trigger arg 'note', update note succeeds, update other column fails
});

// lib/domain/__tests__/ids.test.ts
it("newId is a UUIDv7 and sorts by creation time", () => { const a = newId(); const b = newId(); expect(a < b).toBe(true); expect(a[14]).toBe("7"); });
it("newPublicId has prefix and 26-char ULID", () => { expect(newPublicId("sp")).toMatch(/^sp_[0-9A-HJKMNP-TV-Z]{26}$/); });
it("isPublicId rejects the wrong prefix", () => { expect(isPublicId(newPublicId("hl"), "sp")).toBe(false); });
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run lib/db lib/domain/__tests__/ids.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement tables, run `npm run db:generate`, write `0002_forbid_mutation.sql`**

Trigger function raises `'% is append-only', TG_TABLE_NAME` on DELETE; on UPDATE compares `to_jsonb(OLD) - whitelist` with `to_jsonb(NEW) - whitelist` and raises the same message if they differ.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run lib/db lib/domain/__tests__/ids.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): add base tables, append-only trigger and id helpers"
```

---

### Task 4: Archive adapter (S3)

**Files:**
- Create: `lib/adapters/s3.ts`, `test/s3.ts`
- Modify: `.env.example` (add `S3_TEST_BUCKET=periplus-test`), `lib/env.ts` (optional `S3_TEST_BUCKET`)
- Test: `lib/adapters/__tests__/s3.test.ts`

**Interfaces:**
- Consumes: `getEnv()`
- Produces:
  - `type Archive = { ensureBucket(): Promise<void>; put(key: string, body: string | Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<Uint8Array | null>; exists(key: string): Promise<boolean>; ping(): Promise<boolean> }`
  - `createArchive(opts: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }): Archive` (`forcePathStyle: true`), `getArchive(): Archive` (from env, memoized)
  - `testArchive(): Archive` in `test/s3.ts`

- [ ] **Step 1: Write failing tests**

```ts
it("ensureBucket is idempotent", async () => { await testArchive().ensureBucket(); await testArchive().ensureBucket(); });
it("put then get returns the same bytes", async () => {
  const key = `t/${newId()}.md`; await testArchive().put(key, "# Ägina", "text/markdown");
  expect(new TextDecoder().decode((await testArchive().get(key))!)).toBe("# Ägina");
});
it("get of a missing key returns null, exists returns false", async () => { /* … */ });
it("ping is false for a wrong endpoint without throwing", async () => {
  expect(await createArchive({ ...testOpts, endpoint: "http://127.0.0.1:1" }).ping()).toBe(false);
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/adapters` → FAIL.
- [ ] **Step 3: Implement** with `@aws-sdk/client-s3` (`HeadBucket`/`CreateBucket`, `PutObject`, `GetObject` → `transformToByteArray()`, `HeadObject`; `NotFound`/`NoSuchKey` → null/false). `ping()` = `HeadBucket` with 3 s timeout.
- [ ] **Step 4: Run, verify pass** — `npx vitest run lib/adapters` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add S3 archive adapter"`

---

### Task 5: Admin users, passwords, sessions, login limit

**Files:**
- Create: `lib/security/password.ts`, `lib/security/session.ts`, `lib/domain/users.ts`, `scripts/user.ts`
- Test: `lib/security/__tests__/password.test.ts`, `lib/security/__tests__/session.test.ts`, `lib/domain/__tests__/users.test.ts`

**Interfaces:**
- Consumes: `testDb()`, tables `users`, `loginAttempts`, `getEnv().SESSION_SECRET`
- Produces:
  - `hashPassword(password: string): Promise<string>` (argon2id), `verifyPassword(hash: string, password: string): Promise<boolean>`; passwords shorter than 12 chars → `Error("password_too_short")`
  - `SESSION_COOKIE = "periplus_session"`, `type SessionClaims = { sub: string; email: string; iat: number; exp: number; abs: number }` (seconds)
  - `createSessionToken(user: { id: string; email: string }, now?: Date, absoluteExpiry?: number): Promise<string>` — `exp = now + 12h` capped at `abs`, `abs` default `now + 7d`
  - `verifySessionToken(token: string | undefined, now?: Date): Promise<SessionClaims | null>` (null for missing, tampered, expired, past `abs`)
  - `refreshSessionToken(claims: SessionClaims, now?: Date): Promise<string | null>` (null when past `abs`)
  - `sessionCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/" }`
  - `createUser(db: Db, email: string, password: string): Promise<{ id: string }>`, `setPassword(db, email, password): Promise<void>`
  - `authenticate(db: Db, input: { email: string; password: string; ip: string }, now?: Date): Promise<{ ok: true; user: { id: string; email: string } } | { ok: false; reason: "invalid" | "rate_limited" | "disabled" }>` — records every attempt in `login_attempts`; email compared lowercased

- [ ] **Step 1: Write failing tests**

```ts
// session.test.ts
it("round-trips claims", async () => { const t = await createSessionToken(u, t0); expect((await verifySessionToken(t, t0))?.sub).toBe(u.id); });
it("returns null for a tampered token", async () => { expect(await verifySessionToken(flipLastChar(t), t0)).toBeNull(); });
it("returns null after 12h without refresh", async () => { expect(await verifySessionToken(t, addHours(t0, 12.01))).toBeNull(); });
it("refresh extends to 12h but never past the 7-day absolute limit", async () => {
  const claims = await verifySessionToken(t, addHours(t0, 6.9 * 24));
  const r = await refreshSessionToken(claims!, addHours(t0, 6.9 * 24));
  expect((await verifySessionToken(r!, addHours(t0, 7 * 24 + 0.01)))).toBeNull();
});

// users.test.ts
it("authenticates with the right password, case-insensitive email", async () => { /* ok true */ });
it("returns invalid for a wrong password and unknown email alike", async () => { /* reason invalid both */ });
it("returns rate_limited on the 11th attempt in 15 minutes even with the right password", async () => {
  for (let i = 0; i < 10; i++) await authenticate(db, { email, password: "wrong-password-x", ip }, t0);
  expect(await authenticate(db, { email, password: correct, ip }, addMinutes(t0, 5))).toEqual({ ok: false, reason: "rate_limited" });
});
it("allows login again after the 15-minute window", async () => { /* … addMinutes(t0, 16) → ok */ });
it("returns disabled for a disabled user", async () => { /* … */ });
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/security lib/domain/__tests__/users.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `scripts/user.ts create <email>` / `password <email>` reads the password from stdin with echo off (`readline` + muted output), prints only `created`/`updated`.
- [ ] **Step 4: Run, verify pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): add admin users, password hashing, sessions and login limit"`

---

### Task 6: API clients

**Files:**
- Create: `lib/security/api-keys.ts`, `lib/domain/api-clients.ts`, `lib/api/handler.ts`, `scripts/apikey.ts`, `app/api/v1/ping/route.ts`
- Test: `lib/domain/__tests__/api-clients.test.ts`, `lib/api/__tests__/handler.test.ts`

**Interfaces:**
- Consumes: `apiClients` table, `takeToken()` is **not** available yet → rate limiting per client is added in Task 10 (handler calls a no-op limiter until then; Task 10 replaces it)
- Produces:
  - `type ApiScope = "delivery:read" | "reports:write"`
  - `generateApiKey(): { key: string; hash: string }` (key `pk_` + 43 base62 chars from 32 random bytes), `hashApiKey(key: string): string` (SHA-256 hex)
  - `createApiClient(db, input: { name: string; scopes: ApiScope[]; rateLimitPerMin?: number }): Promise<{ id: string; key: string }>`
  - `type ApiClient = { id: string; name: string; scopes: ApiScope[]; rateLimitPerMin: number }`, `authenticateApiClient(db, authorization: string | null): Promise<ApiClient | null>` (Bearer only; revoked → null)
  - `revokeApiClient(db, id: string): Promise<void>`
  - `withApiClient(scope: ApiScope, handler: (req: Request, client: ApiClient) => Promise<Response>): (req: Request) => Promise<Response>` — 401 `{error:{code:"unauthorized"}}`, 403 `forbidden`, 429 `rate_limited`, unexpected errors → 500 `internal` without details; every response `Cache-Control: no-store` unless the handler sets it
  - `GET /api/v1/ping` (scope `delivery:read`) → `{ ok: true, client: name }`

- [ ] **Step 1: Write failing tests**

```ts
it("authenticates a created key and rejects a revoked one", async () => { /* … */ });
it("rejects a key with a valid prefix but unknown hash", async () => { expect(await authenticateApiClient(db, "Bearer pk_" + "a".repeat(43))).toBeNull(); });
it("withApiClient returns 401 without header, 403 with wrong scope, 200 with right scope", async () => { /* … */ });
it("withApiClient hides thrown error messages", async () => {
  const res = await withApiClient("delivery:read", async () => { throw new Error("db password xyz"); })(reqWith(key));
  expect(res.status).toBe(500); expect(await res.text()).not.toContain("xyz");
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/domain/__tests__/api-clients.test.ts lib/api` → FAIL.
- [ ] **Step 3: Implement**; `scripts/apikey.ts create <name> --scope delivery:read [--scope …]` prints the key once.
- [ ] **Step 4: Run, verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): add API clients with hashed keys and handler wrapper"`

---

### Task 7: Route policy, access decision, proxy

**Files:**
- Create: `lib/security/route-policy.ts`, `lib/security/access.ts`, `proxy.ts`
- Test: `lib/security/__tests__/access.test.ts`, `lib/security/__tests__/route-policy.test.ts`

**Interfaces:**
- Consumes: `verifySessionToken`, `refreshSessionToken`, `SESSION_COOKIE`, `sessionCookieOptions` (Task 5)
- Produces:
  - `type RouteRule = { kind: "public" } | { kind: "auth" } | { kind: "admin" } | { kind: "api"; scope: ApiScope }`
  - `ROUTE_POLICY: Record<string, RouteRule>` keyed by route pattern as written under `app/` without route groups (`/`, `/login`, `/healthz`, `/readyz`, `/map`, `/runs`, `/runs/[id]`, `/jobs`, `/costs`, `/settings`, `/api/v1/ping`)
  - `normalizePath(pathname: string): string | null` — decodes once, rejects (`null`) on `%2F`, `%5C`, `..`, double slashes, or a second decoding layer; strips one trailing slash; keeps case
  - `matchRoute(path: string): { pattern: string; rule: RouteRule } | null`
  - `type AccessDecision = { action: "allow" } | { action: "redirect"; to: string } | { action: "deny"; status: 401 | 404 }`
  - `decideAccess(input: { pathname: string; session: SessionClaims | null; hasBearer: boolean }): AccessDecision`
    - `normalizePath` null → deny 404
    - `/api/v1/*`: no bearer → deny 401; unknown route → deny 404; else allow (key verified in `withApiClient`)
    - other paths: `public`/`auth` rule → allow; no session → redirect `/login?next=<path>`; with session → allow (unknown pages fall through to Next's 404)
  - `proxy(request: NextRequest)`: runs `decideAccess`; on allow with a session, sets a refreshed cookie (`refreshSessionToken`); adds `x-trace-id` request header (random UUID); matcher excludes `/_next/static`, `/_next/image`, `/favicon.ico`

- [ ] **Step 1: Write failing tests**

```ts
// access.test.ts
it.each(["/runs", "/runs/abc", "/"])("redirects %s to login without session", p => {
  expect(decideAccess({ pathname: p, session: null, hasBearer: false })).toEqual({ action: "redirect", to: `/login?next=${encodeURIComponent(p)}` });
});
it("allows /healthz, /readyz and /login without session", () => { /* … */ });
it("denies /api/v1/ping without bearer with 401 and unknown api route with 404", () => { /* … */ });
it("decideAccess normalizes path variants", () => {
  expect(decideAccess({ pathname: "/runs/", session: null, hasBearer: false })).toMatchObject({ action: "redirect" });
  expect(decideAccess({ pathname: "/api/v1//ping", session: null, hasBearer: true })).toEqual({ action: "deny", status: 404 });
  expect(decideAccess({ pathname: "/runs%2F..%2Fhealthz", session: null, hasBearer: false })).toEqual({ action: "deny", status: 404 });
  expect(decideAccess({ pathname: "/Healthz", session: null, hasBearer: false })).toMatchObject({ action: "redirect" });
});
it("never treats a session as API credentials", () => {
  expect(decideAccess({ pathname: "/api/v1/ping", session: claims, hasBearer: false })).toEqual({ action: "deny", status: 401 });
});

// route-policy.test.ts
it("every page.tsx and route.ts under app/ has a policy entry and vice versa", () => {
  const routes = collectRoutes("app"); // strips (groups), keeps [params]
  expect(Object.keys(ROUTE_POLICY).sort()).toEqual(routes.sort());
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/security` → FAIL.
- [ ] **Step 3: Implement**; read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` first. The route-policy test will stay red until Task 8 creates the pages; delete the boilerplate `app/page.tsx` and create placeholder `page.tsx` files under `app/(admin)/` for the listed admin routes (`/` included) so the matrix is complete.
- [ ] **Step 4: Run, verify pass** — `npx vitest run lib/security` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(security): add default-deny route policy and proxy"`

---

### Task 8: Login, health endpoints, admin shell

**Files:**
- Create: `lib/security/require-admin.ts`, `app/login/page.tsx`, `app/login/actions.ts`, `app/healthz/route.ts`, `app/readyz/route.ts`, `app/(admin)/layout.tsx`, `app/(admin)/_components/nav.tsx`, `app/(admin)/actions.ts` (logout), `playwright.config.ts`, `e2e/login.spec.ts`
- Modify: `app/layout.tsx` (lang `de`, title `Periplus`), `app/(admin)/page.tsx` placeholder from Task 7 shows the heading „Übersicht“ (full overview in Task 13); delete the `public/*.svg` boilerplate
- Test: `app/__tests__/health.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `createSessionToken`, `verifySessionToken`, `getDb`, `getArchive().ping()`
- Produces:
  - `requireAdmin(): Promise<SessionClaims>` (reads `cookies()`, redirects to `/login` if invalid) — call in every admin page and server action
  - `login(prev: LoginState, formData: FormData): Promise<LoginState>` with `type LoginState = { error: "invalid" | "rate_limited" | null }`; on success sets cookie and `redirect(next ?? "/")`; only same-origin relative `next` values starting with `/` and not `//` are honored
  - `logout(): Promise<void>` clears the cookie, redirects to `/login`
  - `GET /healthz` → 200 `{ status: "ok" }`; `GET /readyz` → 200 `{ status: "ok" }` or 503 `{ status: "unavailable" }` (DB `select 1` and archive ping, each with 3 s timeout; no error details)
  - German UI copy: login form „E-Mail“, „Passwort“, „Anmelden“; errors „E-Mail oder Passwort falsch.“, „Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.“; nav items „Übersicht“, „Karte“, „Läufe“, „Jobs“, „Kosten“, „Einstellungen“, „Abmelden“

- [ ] **Step 1: Write failing tests**

```ts
// app/__tests__/health.test.ts
it("readyz returns 503 without details when the archive is unreachable", async () => {
  mockArchivePing(false);
  const res = await GET(); expect(res.status).toBe(503); expect(await res.json()).toEqual({ status: "unavailable" });
});
// e2e/login.spec.ts
test("admin logs in, sees the overview, logs out", async ({ page }) => {
  await page.goto("/runs"); await expect(page).toHaveURL(/\/login\?next=%2Fruns/);
  await page.getByLabel("E-Mail").fill(E2E_EMAIL); await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByRole("button", { name: "Abmelden" }).click(); await expect(page).toHaveURL(/\/login/);
});
test("open redirect via next is ignored", async ({ page }) => { /* next=//evil.example → lands on / */ });
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run app && npx playwright test` → FAIL.
- [ ] **Step 3: Implement**; `playwright.config.ts` runs `npm run build && npm start` against `TEST_DATABASE_URL`, global setup creates the e2e user via `createUser`.
- [ ] **Step 4: Run, verify pass** — both commands PASS; `npm run build` succeeds without `DATABASE_URL` set.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): add login, health endpoints and admin shell"`

---

### Task 9: Runs (domain)

**Files:**
- Create: `lib/domain/runs.ts`
- Test: `lib/domain/__tests__/runs.test.ts`

**Interfaces:**
- Consumes: tables `runs`, `runStages`, `externalCalls`
- Produces:
  - `type RunKind = "full" | "stage" | "revisit" | "event" | "reprocess" | "system"`, `type RunScope = { type: "tile" | "area" | "place" | "source" | "system"; id: string }`
  - `createRun(db, input: { kind: RunKind; scope: RunScope; stages: string[]; params?: Record<string, unknown>; triggeredBy: string }): Promise<{ id: string }>` — creates `run_stages` rows with ordinal, status `pending`
  - `beginStage(db, runId: string, stage: string, total: number): Promise<void>` — status `running`; `total = 0` finishes the stage immediately
  - `recordJobOutcome(db, runId: string, stage: string, outcome: "done" | "failed"): Promise<{ stageFinished: boolean; nextStage: string | null; runFinished: boolean }>` — atomic increment (`UPDATE … RETURNING`); when `done + failed = total` marks the stage `finished`; when the last stage finishes marks the run `finished` (or `failed` if every job of the last stage failed)
  - `type RunView = { id; kind; scope: RunScope; status; triggeredBy; startedAt; finishedAt; costEur: number; stages: Array<{ stage; ordinal; total; done; failed; status }> }`
  - `getRun(db, id): Promise<RunView | null>` with stages and `costEur` (sum of `external_calls.cost_eur` for the run), `listRuns(db, { limit: number; before?: string }): Promise<RunView[]>`

- [ ] **Step 1: Write failing tests**

```ts
it("finishes a two-stage run only after both stages complete", async () => { /* … */ });
it("counts concurrent outcomes exactly", async () => {
  await beginStage(db, id, "ping", 20);
  await Promise.all(Array.from({ length: 20 }, () => recordJobOutcome(db, id, "ping", "done")));
  expect((await getRun(db, id))!.stages[0]).toMatchObject({ done: 20, status: "finished" });
});
it("sums external call costs into costEur", async () => { /* two calls 0.10 + 0.25 → 0.35 */ });
it("a stage with total 0 is finished at once and reports the next stage", async () => { /* … */ });
```

- [ ] **Step 2–4:** run `npx vitest run lib/domain/__tests__/runs.test.ts` → FAIL, implement, → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runs): add run and stage bookkeeping"`

---

### Task 10: Cost ledger, budgets, rate limits, queue controls

**Files:**
- Create: `lib/domain/costs.ts`, `lib/domain/rate-limit.ts`, `lib/jobs/controls.ts`
- Modify: `lib/api/handler.ts` (use `takeToken` with key `api:<clientId>`)
- Test: `lib/domain/__tests__/costs.test.ts`, `lib/domain/__tests__/rate-limit.test.ts`, `lib/jobs/__tests__/controls.test.ts`

**Interfaces:**
- Consumes: `getConfig().budgets`, tables `externalCalls`, `rateLimits`, `queueControls`
- Produces:
  - `recordExternalCall(db, call: { service: string; operation: string; units: number; unit: string; costEur: number; runId?: string; tileId?: string; stage?: string; meta?: Record<string, unknown> }): Promise<void>`
  - `dailySpendEur(db, service: string, day?: Date): Promise<number>` (UTC day)
  - `class BudgetExceeded extends Error { service: BudgetService; spentEur: number; budgetEur: number }`
  - `assertWithinBudget(db, service: BudgetService, budgets?: AppConfig["budgets"], now?: Date): Promise<void>`
  - `type BudgetStatus = { service: BudgetService; spentEur: number; budgetEur: number; ratio: number }`, `budgetStatus(db, budgets?, now?): Promise<BudgetStatus[]>`
  - `takeToken(db, key: string, ratePerMinute: number, now?: Date): Promise<{ ok: true } | { ok: false; retryAfterMs: number }>` (token bucket, capacity = ratePerMinute, row locked with `SELECT … FOR UPDATE`)
  - `pauseQueue(db, queue: string, until: Date | null, reason: string, by: string): Promise<void>`, `resumeQueue(db, queue: string, by: string): Promise<void>`, `isQueuePaused(db, queue: string, now?: Date): Promise<boolean>` (`until` null = until resumed)
  - `pauseForBudget(db, err: BudgetExceeded, queues: string[], now?: Date): Promise<void>` — pauses until next 00:00 UTC with reason `budget:<service>`

- [ ] **Step 1: Write failing tests**

```ts
it("assertWithinBudget throws BudgetExceeded at 100% and not at 99%", async () => { /* budgets {anthropic:{dailyEur:1}} */ });
it("spend from yesterday does not count today", async () => { /* … */ });
it("takeToken allows ratePerMinute calls then returns retryAfterMs > 0", async () => { /* 3/min → 3 ok, 4th not ok */ });
it("takeToken refills over time", async () => { /* +20 s at 3/min → 1 token */ });
it("pauseForBudget pauses until next UTC midnight and resumeQueue clears it", async () => { /* … */ });
it("api handler returns 429 after the client's limit", async () => { /* rateLimitPerMin 2 → third call 429 */ });
```

- [ ] **Step 2–4:** `npx vitest run lib/domain lib/jobs lib/api` → FAIL, implement, → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add cost ledger, budgets, rate limits and queue controls"`

---

### Task 11: Worker, pg-boss, ping run

**Files:**
- Create: `lib/jobs/boss.ts`, `lib/jobs/queues.ts`, `lib/jobs/registry.ts`, `lib/jobs/handlers/system-ping.ts`, `lib/pipeline/runs.ts`, `lib/domain/review.ts`, `worker/index.ts`
- Test: `lib/jobs/__tests__/worker.test.ts`

**Interfaces:**
- Consumes: `createRun`, `beginStage`, `recordJobOutcome` (Task 9); `isQueuePaused`, `pauseForBudget`, `BudgetExceeded` (Task 10); `getConfig().queues`
- Produces:
  - `QUEUES = ["system.ping"] as const`, `type QueueName = (typeof QUEUES)[number]`; dead-letter queue `system.dead`
  - `createBoss(url: string): PgBoss` (schema `pgboss`), `getBoss(): Promise<PgBoss>` (started singleton for web), `ensureQueues(boss, config): Promise<void>` (`createQueue` with `retryLimit`, `retryDelay`, `retryBackoff`, `deadLetter: "system.dead"`)
  - `type JobContext = { db: Db; log: Logger; jobId: string; runId?: string }`, `type JobHandler<T> = (data: T, ctx: JobContext) => Promise<void>`
  - `type JobData = { runId?: string; stage?: string; key: string; [k: string]: unknown }`
  - `startWorkers(boss, db, handlers: Record<QueueName, JobHandler<JobData>>, config): Promise<{ stop(): Promise<void> }>` — wraps each handler: on success `recordJobOutcome(done)`; on `BudgetExceeded` → `pauseForBudget` and rethrow so pg-boss retries later (the retry is not an attempt that counts toward failure; implement by `boss.retry`/re-send with `startAfter` = pause end instead of throwing — check pg-boss 12 docs via context7 for the exact call); polls `queue_controls` every 30 s and calls `offWork`/`work` accordingly; dead-letter handler for `system.dead`: `recordJobOutcome(failed)` and `createReviewTask(db, { kind: "failed_job", subjectType: "job", subjectId: jobId, context: { queue, key, error } })` once per job (idempotent on subjectId)
  - `createReviewTask(db, input: { kind: ReviewKind; subjectType: string; subjectId: string; context: Record<string, unknown>; priority?: number }): Promise<{ id: string; created: boolean }>` — no second open task for the same (kind, subjectId)
  - `type StageDefinition = { name: string; queue: QueueName; plan(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> }`
  - `startRun(db, boss, input: Parameters<typeof createRun>[1]): Promise<{ id: string }>` — creates run, plans and enqueues the first stage (`singletonKey = runId:stage:key`); after `recordJobOutcome` reports `nextStage`, the wrapper plans and enqueues it
  - stage `ping` (queue `system.ping`): plans `params.count ?? 3` jobs; handler sleeps `params.delayMs ?? 0` and throws when `data.fail === true`
  - `worker/index.ts`: `createBoss`, `ensureQueues`, `startWorkers`, heartbeat upsert into `worker_heartbeats` every 30 s (workerId = hostname + pid), graceful stop on SIGTERM/SIGINT

- [ ] **Step 1: Write failing tests** (real pg-boss on the test DB, `pollingIntervalSeconds: 0.5`)

```ts
it("a ping run with 3 jobs finishes", async () => {
  const { id } = await startRun(db, boss, { kind: "system", scope: { type: "system", id: "ping" }, stages: ["ping"], params: { count: 3 }, triggeredBy: "test" });
  await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
  expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 3, done: 3, failed: 0 });
});
it("a job failing all 3 attempts creates exactly one failed_job task and siblings finish", async () => {
  // params { count: 3, failKeys: ["1"] } → stage done 2, failed 1; one review task with subjectType "job"
});
it("budget exhaustion pauses the queue instead of failing jobs, resume continues", async () => {
  // handler throws BudgetExceeded once → queue_controls paused, job not failed; resumeQueue → run finishes
});
it("enqueueing the same run stage twice does not duplicate jobs", async () => { /* singletonKey */ });
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/jobs` → FAIL.
- [ ] **Step 3: Implement**; look up pg-boss 12 API (`createQueue`, `work` options incl. local concurrency, `offWork`, dead letter, `send` with `singletonKey`/`startAfter`) via context7 before writing code; use `retryLimit`/`retryDelaySeconds` from config.
- [ ] **Step 4: Run, verify pass** — `npx vitest run lib/jobs` → PASS; manual: `npm run worker` starts, logs `worker started` with queue list.
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): add pg-boss worker, run orchestration and failed-job review"`

---

### Task 12: Model adapter skeleton

**Files:**
- Create: `lib/ai/types.ts`, `lib/ai/prompts.ts`, `lib/ai/anthropic.ts`, `lib/ai/mock.ts`, `lib/ai/tasks/system-echo.ts`, `config/prompts/system.echo/v1.md`, `scripts/smoke-ai.ts`
- Test: `lib/ai/__tests__/ai.test.ts`

**Interfaces:**
- Consumes: `getConfig().models`, `assertWithinBudget`, `recordExternalCall`
- Produces:
  - `type ModelTask<I, O> = { name: string; output: z.ZodType<O>; variables(input: I): Record<string, string> }`
  - `type ModelResult<O> = { output: O; model: string; promptVersion: number; usage: { inputTokens: number; outputTokens: number }; costEur: number }`
  - `interface ModelClient { call<I, O>(task: ModelTask<I, O>, input: I, ctx?: { runId?: string; stage?: string }): Promise<ModelResult<O>> }`
  - `loadPrompt(taskName: string, version: number): { system: string; user: string }` — file `config/prompts/<task>/v<N>.md` with sections `## system` and `## user`; `renderPrompt(template: string, vars: Record<string,string>): string` replaces `{{name}}`, throws on a missing variable
  - `createAnthropicClient(db: Db, config?: AppConfig): ModelClient` — model and prompt version from `config.models.tasks[task.name]`; structured output via the JSON schema of `task.output` (`z.toJSONSchema`); output parsed with `task.output.parse` (failure throws `ModelOutputInvalid`); `assertWithinBudget(db, "anthropic")` before, `recordExternalCall` after (service `anthropic`, operation = task name, unit `tokens`, costEur from `pricesEurPerMTok`)
  - `class MockModel implements ModelClient` — constructor `(responses: Record<string, (input: unknown) => unknown>)`, returns `promptVersion` from config, zero cost
  - task `system.echo`: input `{ text: string }`, output `{ echo: string; language: string }`
  - Batch submission (`submitBatch`/`collectBatch`) is **not** part of M0; it is planned with M4.

- [ ] **Step 1: Write failing tests**

```ts
it("renderPrompt throws on a missing variable", () => { expect(() => renderPrompt("Hi {{name}}", {})).toThrow(/name/); });
it("loadPrompt reads system and user sections of system.echo v1", () => { /* both non-empty */ });
it("MockModel validates output against the task schema", async () => {
  await expect(new MockModel({ "system.echo": () => ({ echo: 1 }) }).call(echoTask, { text: "x" })).rejects.toThrow();
});
it("anthropic client refuses to call when the budget is exhausted", async () => {
  // budgets anthropic dailyEur 0.01, existing spend 0.02 → BudgetExceeded, SDK never invoked (inject a fake SDK)
});
it("anthropic client records tokens and cost", async () => { /* fake SDK returns usage 1000/200 → external_calls row with expected costEur */ });
```

- [ ] **Step 2–4:** `npx vitest run lib/ai` → FAIL, implement (load the `claude-api` skill before writing `lib/ai/anthropic.ts`; inject the SDK client for tests), → PASS. Manual: `npm run smoke:ai` with a real key prints the echo and the cost.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai): add model client abstraction with prompts, budgets and mock"`

---

### Task 13: Admin pages (overview, runs, jobs, costs, settings, map)

**Files:**
- Create/replace: `app/(admin)/page.tsx`, `app/(admin)/runs/page.tsx`, `app/(admin)/runs/[id]/page.tsx`, `app/(admin)/runs/actions.ts`, `app/(admin)/jobs/page.tsx`, `app/(admin)/jobs/actions.ts`, `app/(admin)/costs/page.tsx`, `app/(admin)/settings/page.tsx`, `app/(admin)/map/page.tsx`, `app/(admin)/_components/map-view.tsx`, `lib/domain/overview.ts`, `lib/domain/queues-view.ts`
- Test: `lib/domain/__tests__/overview.test.ts`, `app/(admin)/__tests__/actions.test.ts`, extend `e2e/login.spec.ts`

**Interfaces:**
- Consumes: `requireAdmin`, `listRuns`, `getRun`, `startRun`, `budgetStatus`, `pauseQueue`, `resumeQueue`, `getBoss`, `getConfig`
- Produces:
  - `overview(db, now?): Promise<{ openReviewTasks: Record<ReviewKind, number>; jobs: Record<QueueName, { queued: number; active: number; failed: number; paused: boolean }>; budgets: BudgetStatus[]; workers: Array<{ workerId: string; beatAgeSeconds: number }>; recentRuns: RunView[] }>`
  - `queuesView(db, boss): Promise<…same jobs shape…>`
  - Server actions (each calls `requireAdmin()`, validates with zod): `startPingRun(formData: { count: 1–50 })`, `pauseQueueAction({ queue })`, `resumeQueueAction({ queue })`; triggeredBy = admin email
  - Map: MapLibre client component, style `https://tiles.openfreemap.org/styles/liberty`, initial center `[23.4, 37.55]`, zoom 8, OSM attribution visible
  - German labels: „Offene Prüfungen“, „Jobs“, „Kosten heute“, „Budget“, „Worker zuletzt aktiv vor {n} s“, „Ping-Lauf starten“, „Pausieren“, „Fortsetzen“, „Läufe“, „Kosten je Dienst (30 Tage)“, „Aktive Konfiguration“

- [ ] **Step 1: Write failing tests**

```ts
it("overview reports a worker heartbeat age", async () => { /* beat 40 s ago → beatAgeSeconds 40 */ });
it("startPingRun rejects count 0 and 51", async () => { /* zod error, no run created */ });
it("server actions redirect without a session", async () => { /* requireAdmin mocked to throw redirect */ });
// e2e: after login, "Ping-Lauf starten" creates a run listed on /runs (status may be queued without a worker)
```

- [ ] **Step 2–4:** `npx vitest run lib/domain app && npx playwright test` → FAIL, implement, → PASS; route-policy test still green.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): add overview, runs, jobs, costs, settings and map pages"`

---

### Task 14: Production images and compose

**Files:**
- Create: `docker/web.Dockerfile`, `docker/worker.Dockerfile`, `docker/compose.prod.yml`, `docker/Caddyfile`, `.dockerignore`
- Modify: `next.config.ts` (`output: "standalone"`)

**Interfaces:**
- Produces: images `ghcr.io/crilabs/periplus-web:<sha>`, `ghcr.io/crilabs/periplus-worker:<sha>`, `ghcr.io/crilabs/periplus-postgres:<sha>` (from `docker/postgres/Dockerfile`); compose services `caddy` (caddy:2, ports 80/443, `{$PERIPLUS_DOMAIN}` → `web:3000`), `web` (`node .next/standalone/server.js`, `HOSTNAME=0.0.0.0`, `PORT=3000`), `worker` (`node --import tsx worker/index.ts`, base `mcr.microsoft.com/playwright:v1.64.1-noble`), `migrate` (worker image, `profiles: ["migrate"]`, runs `node --import tsx scripts/migrate.ts`), `postgres` (volume `pg-data`, not published); all read `.env`; `IMAGE_TAG` variable selects the tag

- [ ] **Step 1: Build locally**

Run: `docker build -f docker/web.Dockerfile -t periplus-web:local . && docker build -f docker/worker.Dockerfile -t periplus-worker:local .`
Expected: both succeed.

- [ ] **Step 2: Smoke the prod compose locally**

Run: `IMAGE_TAG=local PERIPLUS_DOMAIN=localhost docker compose -f docker/compose.prod.yml --env-file .env.prod.local up -d` (with local images retagged), then `curl -k https://localhost/healthz`
Expected: `{"status":"ok"}`; `curl -k https://localhost/readyz` → `{"status":"ok"}` with a test bucket configured.

- [ ] **Step 3: Commit** — `git commit -m "build: add production images and compose setup"`

---

### Task 15: CI/CD, server bootstrap, backups, runbook

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/deploy/deploy.sh`, `scripts/server/bootstrap.sh`, `scripts/ops/backup.sh`, `scripts/ops/restore-check.sh`, `docs/runbook.md`

**Interfaces:**
- Produces:
  - `ci.yml`: on PR and push. Job `check`: `npm ci`, `docker compose -f docker/compose.dev.yml up -d --build db-test s3`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npx playwright install --with-deps chromium && npm run test:e2e`. Job `deploy` (push to `main`, needs `check`): build and push the three images with tag `${{ github.sha }}`, then `ssh deploy@$HOST 'bash -s' < scripts/deploy/deploy.sh <sha>`. Secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.
  - `deploy.sh <sha>`: in `/opt/periplus`: remember current tag from `.deployed-tag`, `IMAGE_TAG=<sha> docker compose pull`, `docker compose --profile migrate run --rm migrate`, `docker compose up -d web worker caddy`, poll `/readyz` up to 60 s; on failure redeploy the previous tag and exit 1; on success write `.deployed-tag`.
  - `bootstrap.sh`: Ubuntu 24.04: Docker Engine + compose plugin, user `deploy` in group `docker`, ufw allow 22/80/443, SSH password login off, unattended-upgrades, `/opt/periplus` with `compose.prod.yml`, `Caddyfile`, `.env` template (chmod 600), cron for `backup.sh` at 02:30 UTC.
  - `backup.sh`: `docker compose exec -T postgres pg_dump -Fc -U periplus periplus | restic backup --stdin --stdin-filename periplus.dump`; `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune`; `rclone copy hetzner-s3:periplus-archive storagebox:periplus-archive` (copy, never sync-delete). Restic repo and rclone remotes from `/opt/periplus/.env`.
  - `restore-check.sh`: restores the latest dump into a throwaway container from the postgres image and runs `select count(*) from users` — exit 0 when it succeeds.
  - `docs/runbook.md` (German): server creation (human), Hetzner Object Storage bucket and keys (human), Storage Box (human), DNS (human), GitHub secrets (human), first deploy, creating the first admin (`docker compose exec web node --import tsx scripts/user.ts create <email>`), API key creation, backup and restore steps, rollback (`deploy.sh <previous sha>`), where logs are (`docker compose logs -f worker`).

- [ ] **Step 1: Validate workflow and scripts**

Run: `npx --yes action-validator .github/workflows/ci.yml && bash -n scripts/deploy/deploy.sh scripts/server/bootstrap.sh scripts/ops/backup.sh scripts/ops/restore-check.sh`
Expected: no errors.

- [ ] **Step 2: Push the branch and open a PR; CI job `check` green**

Run: `gh pr checks --watch`
Expected: `check` passes.

- [ ] **Step 3: Human steps from the runbook (server, storage, DNS, secrets), then merge → deploy job green**

Expected: `https://<domain>/readyz` → `{"status":"ok"}`.

- [ ] **Step 4: M0 acceptance on the server**

- Admin login works on the server.
- A ping run started in „Läufe“ finishes and appears with its stage counts on the overview.
- `scripts/ops/backup.sh` runs; `scripts/ops/restore-check.sh` exits 0; result noted in `docs/runbook.md` with date.

- [ ] **Step 5: Commit** — `git commit -m "ci: add CI/CD pipeline, server bootstrap, backups and runbook"`
