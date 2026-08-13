import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787'
const suppliedBuildCommitSha = process.env.APP_COMMIT_SHA ?? process.env.GITHUB_SHA
const buildCommitSha = suppliedBuildCommitSha && /^[0-9a-f]{40}$/.test(suppliedBuildCommitSha)
  ? suppliedBuildCommitSha
  : 'development'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'mbox-build-identity',
      transformIndexHtml(html) {
        return html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta name="mbox-build-commit" content="${buildCommitSha}" />`,
        )
      },
    },
  ],
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
