import { defineConfig } from 'vitest/config'

// The CLI runs in Node or as a bun binary, not in the Worker runtime.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // e2e and migrate each start `wrangler dev`; two at once can fail with
    // "Address already in use (socket direct:1:default)"
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
