import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    include: ['src/**/*.test.{js,jsx}'],
  },
  server: {
    fs: {
      // Allow the dev server to serve files from the repo root so that
      // import.meta.glob can reach tools/crawlers/* wizard files.
      allow: [path.resolve(__dirname, '../..')],
    },
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
