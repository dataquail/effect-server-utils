#!/usr/bin/env node
// Post-processes a package's `dist/` after `build-utils pack-v2` has assembled
// it. Run from the package root (`node ../../scripts/prune-dist.mjs`), which is
// what each package's `build-prune` script does.
//
// Two things get removed, neither of which pack-v2 offers a flag for. Patching
// @effect/build-utils itself would work, but it would put a pnpm patch in the
// way of every upgrade of a tool we otherwise take as-is, so this runs after it
// instead.
//
// 1. Co-located tests. Tests live beside the source they cover, and pack-v2
//    copies `src/` verbatim to `dist/src/` (for source maps and go-to-
//    definition), so without this every `*.test.ts` ships. The compiled output
//    under `dist/dist/` is already clean — tsconfig.src.json excludes tests.
//
// 2. The subpath proxy directories. pack-v2 unconditionally writes a
//    `dist/<entrypoint>/package.json` carrying `main`/`module`/`types` for
//    every subpath export, one directory per module: 15 for cqrs, 5 for authz.
//    That is the pre-`exports` resolution mechanism, where `pkg/command`
//    resolved by finding a real `command/` directory with its own manifest.
//    Nothing these packages can be consumed from still takes that path — Node
//    has honoured `exports` since 12.7, and TypeScript under
//    node16/nodenext/bundler resolves `./command` from the exports map and
//    never looks at the directory. `effect@4` is itself exports-only, so a
//    consumer old enough to need the proxies could not resolve the peer dep.
//
// `typesVersions` deliberately stays. It looks like part of the same legacy
// mechanism, and it is, but it is the half that still works: a consumer on
// TypeScript's `moduleResolution: "node"` gets types for `pkg/command` from
// typesVersions while its *runtime* resolution goes through Node, which reads
// `exports`. Dropping it would break that combination for no size win — it is
// a few lines of metadata, not files on disk.
import * as fs from "node:fs";
import * as path from "node:path";

const DIST = "dist";

if (!fs.existsSync(path.join(DIST, "package.json"))) {
  console.error(
    `prune-dist: no ${DIST}/package.json — run this from a package root, after \`build-utils pack-v2\`.`,
  );
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "package.json"), "utf8"));

let removedTests = 0;

const removeTests = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeTests(full);
    } else if (entry.name.endsWith(".test.ts")) {
      fs.rmSync(full);
      removedTests += 1;
    }
  }
};

if (fs.existsSync(path.join(DIST, "src"))) {
  removeTests(path.join(DIST, "src"));
}

// Drive off the exports map rather than "every directory in dist except the
// ones I know about": the entrypoint list is where the proxies came from, so
// deriving the removals from it cannot delete something pack-v2 wrote for a
// different reason. The single-file assertion is the second half of that — if a
// future pack-v2 puts real content in these directories, this fails loudly
// instead of silently deleting the package's payload.
const subpaths = Object.keys(manifest.exports ?? {}).filter(
  (entry) => entry !== "." && entry !== "./package.json",
);

let removedProxies = 0;

for (const subpath of subpaths) {
  const dir = path.join(DIST, subpath.replace(/^\.\//, ""));
  if (!fs.existsSync(path.join(dir, "package.json"))) continue;

  const contents = fs.readdirSync(dir);
  if (contents.length !== 1 || contents[0] !== "package.json") {
    console.error(
      `prune-dist: refusing to remove ${dir} — expected it to hold only the ` +
        `subpath proxy package.json, found: ${contents.join(", ")}`,
    );
    process.exit(1);
  }

  fs.rmSync(dir, { recursive: true });
  removedProxies += 1;
}

console.log(
  `prune-dist: removed ${removedTests} test file(s) from ${DIST}/src and ` +
    `${removedProxies} subpath proxy director${removedProxies === 1 ? "y" : "ies"}.`,
);
