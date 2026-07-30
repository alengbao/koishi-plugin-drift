import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The full `koishi` entry also exports its Node loader. Tests only need the
    // core runtime, and loading the loader through Vite breaks its CJS default.
    alias: {
      koishi: '@koishijs/core',
    },
  },
  test: {
    environment: 'node',
  },
})
