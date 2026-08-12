import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 12_000,
          groups: [
            { name: 'react-vendor', test: /node_modules\/(?:react|react-dom|scheduler)\// },
            { name: 'icon-vendor', test: /node_modules\/lucide-react\// },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiProxyTarget,
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': apiProxyTarget,
    },
  },
})
