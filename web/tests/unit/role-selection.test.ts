import { expect, it } from "vitest";
import { selectRoleResults } from "../../app/utils/role-selection";
it("selects every result even above one thousand with no 100-item cap", () => {
  const ids = Array.from({ length: 1107 }, (_, i) => `r${i}`);
  expect(selectRoleResults([], ids)).toEqual(ids);
  expect(selectRoleResults(ids, ids)).toEqual(ids);
});
it("inverts filtered results and preserves selected roles outside the search", () => {
  expect(selectRoleResults(["outside", "a"], ["a", "b", "c"], true)).toEqual([
    "outside",
    "b",
    "c",
  ]);
  expect(selectRoleResults(["outside"], [], true)).toEqual(["outside"]);
});
it("never produces duplicate selection IDs", () => {
  expect(selectRoleResults(["a", "a"], ["a", "b", "b"])).toEqual(["a", "b"]);
  expect(selectRoleResults(["a"], ["a", "a"], true)).toEqual([]);
});
