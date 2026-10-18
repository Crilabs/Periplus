import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";

const db = testDb();

describe("review tasks", () => {
  it("creates at most one open task per kind and subject", async () => {
    const subjectId = newId();
    const input = { kind: "failed_job" as const, subjectType: "job", subjectId, context: { a: 1 } };
    const [a, b] = await Promise.all([createReviewTask(db, input), createReviewTask(db, input)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    const rows = await db.select().from(reviewTasks).where(eq(reviewTasks.subjectId, subjectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", priority: 0, context: { a: 1 } });
  });

  it("allows a new open task once the previous one is no longer open", async () => {
    const subjectId = newId();
    const input = { kind: "failed_job" as const, subjectType: "job", subjectId, context: {}, priority: 5 };
    const first = await createReviewTask(db, input);
    await db.update(reviewTasks).set({ status: "dismissed" }).where(eq(reviewTasks.id, first.id));
    const second = await createReviewTask(db, input);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    const open = await db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.subjectId, subjectId), eq(reviewTasks.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0].priority).toBe(5);
  });
});
