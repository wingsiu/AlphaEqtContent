import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { importMediaPlugin } from './vite.import-media.ts'
import { hoksiDownloadPlugin } from './vite.hoksi-download.ts'

// mathjax-full reads PACKAGE_VERSION at runtime; without it, it eval('require')
// which crashes in the browser and blanks the page.
export default defineConfig({
  plugins: [react(), importMediaPlugin(), hoksiDownloadPlugin()],
  define: {
    PACKAGE_VERSION: JSON.stringify('3.2.1'),
  },
  optimizeDeps: {
    include: ['rehype-mathjax', 'mathjax-full'],
  },
  server: {
    proxy: {
      // UniMERNet (formula crop) — Tools/unimernet_api.py
      '/api/ocr': {
        target: 'http://127.0.0.1:8503',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ocr/, ''),
      },
      // Optional fallback: pix2tex Docker on :8502
      '/api/ocr-pix2tex': {
        target: 'http://127.0.0.1:8502',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ocr-pix2tex/, ''),
      },
      // Smart PDF/page pipeline — Tools/smart_page_api.py (long-running NDJSON stream)
      '/api/page-ocr': {
        target: 'http://127.0.0.1:8504',
        changeOrigin: true,
        timeout: 0,
        rewrite: (path) => path.replace(/^\/api\/page-ocr/, ''),
      },
    },
  },
})
