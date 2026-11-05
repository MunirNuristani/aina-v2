import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  // Next's recommended rules, plus the TypeScript ones (no-explicit-any, unused vars, ...)
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
