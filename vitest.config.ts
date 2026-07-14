import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    exclude: ['dist/**', 'dist-server/**', 'node_modules/**'],
  },
})
