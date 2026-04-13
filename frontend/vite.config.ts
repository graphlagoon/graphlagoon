import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'

// Always use local 3d-force-graph libraries (from ext-3d-force/)
const aliases: Record<string, string> = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  '3d-force-graph': fileURLToPath(new URL('./ext-3d-force/3d-force-graph/src/index.js', import.meta.url)),
  'three-forcegraph': fileURLToPath(new URL('./ext-3d-force/three-forcegraph/src/index.js', import.meta.url)),
  'd3-force-3d': fileURLToPath(new URL('./ext-3d-force/d3-force-3d/src/index.js', import.meta.url)),
  // three-render-objects imports from 'three/webgpu' which bundles a second copy
  // of Three.js. We only use WebGL, so stub out the WebGPU renderer.
  'three/webgpu': fileURLToPath(new URL('./ext-3d-force/three-webgpu-shim.js', import.meta.url)),
}

export default defineConfig({
  plugins: [vue()],
  // Empty base = relative to where the main bundle is loaded from
  // This allows the app to work when mounted at any prefix (e.g., /graphlagoon)
  // The Jinja template uses static_prefix to set the correct initial script path
  base: '',
  resolve: {
    alias: aliases,
    dedupe: ['three']
  },
  build: {
    // Output to the Python package's static directory
    outDir: resolve(__dirname, '../api/graphlagoon/static'),
    emptyOutDir: true,
    // Generate manifest for Jinja template to read asset paths
    manifest: true,
    // Disable code splitting - single bundle for simpler Jinja serving
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      },
      output: {
        // Single JS bundle (no code splitting)
        manualChunks: undefined,
        inlineDynamicImports: true,
        // Put all assets in an assets folder
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  },
  server: {
    port: 3000,
    proxy: {
      // Proxy all /graphlagoon requests to the backend
      '/graphlagoon': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  },
  // Set default API URL for development
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify('/graphlagoon'),
    'import.meta.env.VITE_BACKEND_ORIGIN': JSON.stringify('http://localhost:8000')
  }
})
