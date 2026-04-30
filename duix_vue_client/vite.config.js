import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      '/duix-video': {
        target: 'http://154.93.109.240:8383',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/duix-video/, '')
      },
      '/duix-tts': {
        target: 'http://154.93.109.240:18180',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/duix-tts/, '')
      }
    }
  }
})
