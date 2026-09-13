import { config as loadDotenv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside the app, so it reads .env from the repo root itself.
loadDotenv({ path: "../../.env" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
  // Keeps generated SQL readable and reviewable — this project hand-writes the
  // btree_gist migration, so generated and hand-written files sit side by side.
  verbose: true,
  strict: true,
});
