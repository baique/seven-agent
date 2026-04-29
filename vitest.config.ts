import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,js}'],
    exclude: ['node_modules', 'dist', '.electron'],
    reporters: ['default'],
    outputFile: {
      json: './test-results/report.json',
      html: './test-results/report.html',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './test-results/coverage',
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/main/test/**', '**/*.test.ts', '**/*.spec.ts'],
    },
  },
})
