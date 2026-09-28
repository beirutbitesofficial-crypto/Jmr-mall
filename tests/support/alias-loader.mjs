// Lets tests import the app's TypeScript files directly: resolves the "@/..." path alias
// from tsconfig and adds the .ts/.tsx extension Next.js normally fills in.
import { existsSync } from "node:fs";

const root = new URL("../../", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  const base = specifier.startsWith("@/") ? new URL(specifier.slice(2), root)
    : specifier.startsWith(".") && context.parentURL?.startsWith(root.href) ? new URL(specifier, context.parentURL) : null;
  if (base && !/\.[cm]?[jt]sx?$/.test(base.pathname)) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const candidate = new URL(base.href + ext);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
  }
  try {
    return await nextResolve(base ? base.href : specifier, context);
  } catch (error) {
    // Packages without an exports map (e.g. "next/server") need the .js extension under ESM.
    if (!base && error?.code === "ERR_MODULE_NOT_FOUND" && /^[@a-z]/.test(specifier) && !specifier.endsWith(".js")) return nextResolve(`${specifier}.js`, context);
    throw error;
  }
}
