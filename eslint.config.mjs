import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/**"] },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      // Preserve canonical product names and the literal connection path.
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["Obsidian", "Univocal", "Keychain", "macOS"], acronyms: ["QA", "URL", "R"], ignoreRegex: ["^~/"] }],
    },
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
