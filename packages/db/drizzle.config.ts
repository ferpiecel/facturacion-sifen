import { defineConfig } from 'drizzle-kit';

// Used only by `pnpm db:generate` (drizzle-kit generate) to emit SQL
// migrations from src/schema.ts. `DATABASE_URL` is required by drizzle-kit's
// CLI schema but is never read at generate time for the `generate` command.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/sifen_placeholder',
  },
});
