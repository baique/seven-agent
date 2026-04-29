import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import VueMacros from 'vue-macros/vite'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@modelcontextprotocol/sdk': resolve('node_modules/@modelcontextprotocol/sdk/dist/esm'),
      },
    },
    build: {
      rollupOptions: {
        external: [/^@modelcontextprotocol/],
      },
    },
  },
  preload: {},
  renderer: {
    publicDir: resolve('src/renderer/public'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@main': resolve('src/main'),
        '@cubism': resolve('src/renderer/public/cubism-framework'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          toolReview: resolve('src/renderer/tool-review.html'),
          terminal: resolve('src/renderer/terminal.html'),
          splash: resolve('src/renderer/splash.html'),
        },
      },
    },
    server: {
      hmr: {
        overlay: false,
      },
      fs: {
        allow: [resolve('src/renderer'), resolve('resources')],
      },
      proxy: {
        '/model': {
          target: 'http://localhost',
          changeOrigin: true,
        },
        '/vtube-model': {
          target: 'http://localhost',
          changeOrigin: true,
        },
      },
    },
    plugins: [
      //@ts-ignore
      tailwindcss(),
      VueMacros({
        plugins: {
          vue: vue(),
          vueJsx: vueJsx(),
        },
      }),
      {
        name: 'serve-resources',
        configureServer(server) {
          server.middlewares.use('/model', (req, res, next) => {
            const filePath = path.join(__dirname, 'resources', 'model', req.url || '')
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const ext = path.extname(filePath)
              const mimeTypes: Record<string, string> = {
                '.json': 'application/json',
                '.png': 'image/png',
                '.moc3': 'application/octet-stream',
              }
              res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
              fs.createReadStream(filePath).pipe(res)
              return
            }
            next()
          })
        },
      },
    ],
  },
})
