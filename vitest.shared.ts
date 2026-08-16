import * as path from "node:path";
import { type ViteUserConfig } from "vitest/config";

// A package's own tests import it by its published name (`@effect-server-utils/cqrs`),
// not by a relative path — the same specifier a consumer writes. `TEST_DIST=1` points
// that specifier at the built output instead of `src`, so the suite can be re-run
// against what `build-utils prepare-v2` actually packaged.
const alias = (name: string) => {
  const target = process.env.TEST_DIST !== undefined ? "dist/dist/esm" : "src";
  const scopedName = `@effect-server-utils/${name}`;
  return {
    [scopedName]: path.join(__dirname, "packages", name, target),
  };
};

const config: ViteUserConfig = {
  esbuild: {
    target: "es2020",
  },
  test: {
    onConsoleLog: (log) => {
      console.log(log);
    },
    setupFiles: [path.join(__dirname, "setupTests.ts")],
    fakeTimers: {
      toFake: undefined,
    },
    sequence: {
      concurrent: true,
    },
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    alias: {
      ...alias("authz"),
      ...alias("cqrs"),
    },
  },
};

export default config;
