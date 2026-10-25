import { describe, expect, it } from "vitest";
import { segmentText } from "../quote";

describe("segmentText", () => {
  it("segments overlapping mention and quote spans", () => {
    expect(
      segmentText("abcdef", [
        { start: 1, end: 4, kind: "quote", ref: "f" },
        { start: 2, end: 3, kind: "mention", ref: "m" },
      ]),
    ).toEqual([
      { text: "a", kinds: [], refs: [] },
      { text: "b", kinds: ["quote"], refs: ["f"] },
      { text: "c", kinds: ["quote", "mention"], refs: ["f", "m"] },
      { text: "d", kinds: ["quote"], refs: ["f"] },
      { text: "ef", kinds: [], refs: [] },
    ]);
  });

  it("clamps spans outside the text and drops empty ones", () => {
    expect(
      segmentText("abc", [
        { start: -5, end: 1, kind: "mention", ref: "m" },
        { start: 2, end: 99, kind: "quote", ref: "f" },
        { start: 7, end: 9, kind: "quote", ref: "g" },
        { start: 1, end: 1, kind: "quote", ref: "h" },
      ]),
    ).toEqual([
      { text: "a", kinds: ["mention"], refs: ["m"] },
      { text: "b", kinds: [], refs: [] },
      { text: "c", kinds: ["quote"], refs: ["f"] },
    ]);
  });

  it("lists a kind once when two spans of that kind overlap", () => {
    expect(
      segmentText("abc", [
        { start: 0, end: 3, kind: "quote", ref: "f1" },
        { start: 1, end: 2, kind: "quote", ref: "f2" },
      ]),
    ).toEqual([
      { text: "a", kinds: ["quote"], refs: ["f1"] },
      { text: "b", kinds: ["quote"], refs: ["f1", "f2"] },
      { text: "c", kinds: ["quote"], refs: ["f1"] },
    ]);
    expect(segmentText("", [])).toEqual([]);
    expect(segmentText("abc", [])).toEqual([{ text: "abc", kinds: [], refs: [] }]);
  });
});
