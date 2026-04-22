import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Cloudflare quick tunnels use *.trycloudflare.com; host changes per tunnel.
    allowedHosts: ['.trycloudflare.com'],
    // Multiplayer relay (server/) listens on :3001; tunnel only reaches Vite, so proxy WS here.
    proxy: {
      '/relay': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/relay': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
