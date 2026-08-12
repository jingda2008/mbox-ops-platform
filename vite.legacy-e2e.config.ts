import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'mbox-legacy-e2e-entry',
      transformIndexHtml(html) {
        return html.replace('/src/main.tsx', '/src/legacy-e2e-main.tsx')
      },
    },
  ],
  server: {
    proxy: {
      '/api': apiProxyTarget,
    },
  },
})
