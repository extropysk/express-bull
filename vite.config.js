import path from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { name } from './package.json'

const formattedName = name.match(/[^/]+$/)?.[0] ?? name

export default defineConfig({
  plugins: [
    dts({
      exclude: ['**/*.test.ts'],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: formattedName,
    },
    rollupOptions: {
      external: ['bullmq'],
    },
  },
})
