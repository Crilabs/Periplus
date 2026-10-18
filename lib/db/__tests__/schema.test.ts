import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { testDb } from "@/test/db";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

async function insertDecision(): Promise<string> {
  const db = testDb();
  const [task] = await db
    .insert(reviewTasks)
    .values({
      kind: "conflict",
      subjectType: "place",
      subjectId: "p1",
      context: {},
    })
    .returning({ id: reviewTasks.id });
  const [decision] = await db
    .insert(reviewDecisions)
    .values({
      taskId: task!.id,
      decision: { ok: true },
      decidedBy: "t",
      durationMs: 1,
    })
    .returning({ id: reviewDecisions.id });
  return decision!.id;
}

describe("forbid_mutation", () => {
  it("rejects UPDATE on review_decisions", async () => {
    const id = await insertDecision();
    const message = await rejectionMessage(
      testDb().execute(
        sql`update review_decisions set decided_by='x' where id=${id}`,
      ),
    );
    expect(message).toMatch(/review_decisions is append-only/);
  });
  it("rejects DELETE on review_decisions", async () => {
    const id = await insertDecision();
    const message = await rejectionMessage(
      testDb().execute(sql`delete from review_decisions where id=${id}`),
    );
    expect(message).toMatch(/review_decisions is append-only/);
  });
  it("allows whitelisted columns only", async () => {
    // temp table is per connection, so run everything in one transaction (rolled back by the final failure)
    let noteAfterAllowedUpdate: unknown;
    const message = await rejectionMessage(
      testDb().transaction(async (tx) => {
        await tx.execute(
          sql`create temp table fm_test (id int primary key, note text, other text)`,
        );
        await tx.execute(sql`create trigger fm before update or delete on fm_test
          for each row execute function forbid_mutation('note')`);
        await tx.execute(sql`insert into fm_test values (1, 'a', 'b')`);
        await tx.execute(sql`update fm_test set note='z' where id=1`);
        noteAfterAllowedUpdate = (
          await tx.execute(sql`select note from fm_test where id=1`)
        ).rows[0];
        await tx.execute(sql`update fm_test set other='z' where id=1`);
      }),
    );
    expect(message).toMatch(/fm_test is append-only/);
    expect(noteAfterAllowedUpdate).toEqual({ note: "z" });
  });
});
