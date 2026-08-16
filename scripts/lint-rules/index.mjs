// Single plugin barrel for the repo's local rules. ESLint declared each rule as
// its own pseudo-plugin; oxlint loads one module per `jsPlugins` entry, so the
// rules are collected here and addressed as `local/<rule>`.
import noArrayPushSpread from "./no-array-push-spread.mjs";
import noEffectNamespaceImports from "./no-effect-namespace-imports.mjs";
import noRelativeImportOutsidePackage from "./no-relative-import-outside-package.mjs";
import preferNamedExports from "./prefer-named-exports.mjs";

export const rules = {
  "no-array-push-spread": noArrayPushSpread,
  "no-effect-namespace-imports": noEffectNamespaceImports,
  "no-relative-import-outside-package": noRelativeImportOutsidePackage,
  "prefer-named-exports": preferNamedExports,
};

export const localRulesPlugin = { meta: { name: "local" }, rules };

export default localRulesPlugin;
