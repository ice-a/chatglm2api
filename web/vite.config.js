import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 输出到项目根目录的 public/，并内联为单一 index.html，
// 以兼容 server.js 的静态服务（只服务 / 与 /index.html）与 Node SEA 打包。
export default defineConfig({
  base: './',
  plugins: [vue(), viteSingleFile()],
  publicDir: false,
  build: {
    outDir: '../public',
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 100 * 1024 * 1024,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/oauth': 'http://127.0.0.1:8788',
    },
  },
})
