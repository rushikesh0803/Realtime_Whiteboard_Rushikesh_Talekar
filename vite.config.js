// vite.config.js  (unchanged but good defaults)
// ----------------------------------------------------
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_TARGET = process.env.VITE_SERVER_URL || 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
      },
      '^/socket.io/.*': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
