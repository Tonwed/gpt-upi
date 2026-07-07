import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local-only generated artifacts and QA/research scratch files:
    ".tmp/**",
    "qa/**",
    "docs/upi-qr-extraction-flow.md",
    "inspect_autopublish_pending.cjs",
    "run_inspect_autopublish_pending.sh",
    "scripts/*experiment*.ts",
    "scripts/local-approve-*.ts",
    "*.log",
  ]),
]);

export default eslintConfig;
