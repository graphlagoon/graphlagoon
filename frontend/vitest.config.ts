import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'd3-force-3d': fileURLToPath(new URL('./src/__tests__/__mocks__/d3-force-3d.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'ext-3d-force'],
    setupFiles: ['./src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/utils/**',
        'src/services/**',
        'src/stores/**',
        'src/types/**',
        'src/composables/**',
      ],
      exclude: [
        'src/**/*.vue',
        'src/workers/**',
        'src/utils/FastLabelRenderer.ts',
        'src/services/metricsCalculator.ts',
        'src/services/workerPool.ts',
      ],
    },
  },
})
