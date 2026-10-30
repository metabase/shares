import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          SESSION_SECRET: 'test-session-secret',
          UPLOAD_TOKEN: 'test-upload-token',
          // split hosts; ORIGIN of test/helpers.ts matches neither (combined)
          CONTENT_HOST: 'content.shares.test',
          APP_HOST: 'app.shares.test',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    })),
  ],
  test: {
    // the CLI tests run in Node: cli/vitest.config.ts
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
})
