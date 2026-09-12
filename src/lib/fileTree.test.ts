import { describe, it, expect } from "vitest";
import { ancestorDirs, orderFiles } from "./fileTree";

const files = [{ path: "z.ts" }, { path: "src/b.ts" }, { path: "src/lib/a.ts" }, { path: "a.ts" }];

describe("orderFiles", () => {
  it("keeps the given order in path view", () => {
    expect(orderFiles(files, "path").map((f) => f.path)).toEqual(["z.ts", "src/b.ts", "src/lib/a.ts", "a.ts"]);
  });

  it("walks the tree depth-first, folders before files, in tree view", () => {
    expect(orderFiles(files, "tree").map((f) => f.path)).toEqual(["src/lib/a.ts", "src/b.ts", "a.ts", "z.ts"]);
  });
});

describe("ancestorDirs", () => {
  it("lists every enclosing folder, outermost first", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorDirs("top.ts")).toEqual([]);
  });
});
