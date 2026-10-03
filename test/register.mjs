import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";

// Source imports use production .js names; run the matching TypeScript in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith("./") &&
      specifier.endsWith(".js") &&
      context.parentURL?.includes("/src/")
    ) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
