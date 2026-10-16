import path from 'path'
import { createRequire } from 'node:module'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'
import { LIGHT_PRESETS } from '../apps/desktop/src/lightAppearance'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

export default defineConfig(({ mode }) => {
  // Load the single root .env and let exported shell vars override file values.
  const env = {
    ...loadEnv(mode, repoRoot, ''),
    ...process.env,
  }

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = env.PROXY_HOST || getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001
  // Resolve through the package manager: npm may hoist React to the workspace
  // root while pnpm exposes it locally. Never assume a physical node_modules path.
  const require = createRequire(import.meta.url)
  // Keep this list to direct dependencies: pnpm does not expose transitive
  // packages at the root used by resolve.dedupe and optimizeDeps.include.
  const codeMirrorDependencies = [
    '@codemirror/lang-css',
    '@codemirror/lang-html',
    '@codemirror/lang-javascript',
    '@codemirror/lang-json',
    '@codemirror/lang-markdown',
    '@codemirror/lang-python',
    '@codemirror/language',
    '@codemirror/merge',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/theme-one-dark',
    '@codemirror/view',
    '@replit/codemirror-minimap',
    '@uiw/react-codemirror',
  ]

  const disableLocalAuth =
    env.PILOTDECK_DISABLE_LOCAL_AUTH !== '0' &&
    env.PILOTDECK_DISABLE_LOCAL_AUTH !== 'false'

  return {
    define: {
      'import.meta.env.VITE_DISABLE_LOCAL_AUTH': JSON.stringify(disableLocalAuth ? 'true' : 'false'),
    },
    plugins: [react(), {
      name: 'appearance-first-paint',
      transformIndexHtml() {
        // Inline and synchronous: even a slow app bundle must not flash the
        // wrong canvas. Full validation and token application follow at boot.
        return [{ tag: 'script', injectTo: 'head-prepend', children: `
          try {
            var desktop = window.pilotdeckDesktop?.getAppearance?.();
            var mode = desktop?.themeMode || localStorage.getItem('themeMode') || localStorage.getItem('theme') || 'system';
            if (!['light', 'dark', 'system'].includes(mode)) mode = 'system';
            var dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
            document.documentElement.classList.toggle('dark', dark);
            document.documentElement.style.backgroundColor = dark ? '#0a0a0a' : '#ffffff';
            var preference = desktop?.lightAppearance || JSON.parse(localStorage.getItem('pilotdeck-light-appearance-v1') || 'null');
            var presets = ${JSON.stringify(LIGHT_PRESETS)};
            var background = preference?.preset === 'custom' ? preference.custom?.background : presets[preference?.preset]?.background;
            document.documentElement.style.backgroundColor = dark ? '#0a0a0a' : /^#[0-9a-f]{6}$/i.test(background) ? background : '#ffffff';
          } catch (_) {}
        ` }];
      },
    }],
    resolve: {
      // Extensions and the React wrapper must share the same CodeMirror state
      // instance, including after dependency updates or a Vite cache rebuild.
      dedupe: ['react', 'react-dom', ...codeMirrorDependencies],
      alias: [
        { find: /^react$/, replacement: require.resolve('react') },
        { find: /^react-dom$/, replacement: require.resolve('react-dom') },
        { find: /^react\/jsx-runtime$/, replacement: require.resolve('react/jsx-runtime') },
        { find: /^react\/jsx-dev-runtime$/, replacement: require.resolve('react/jsx-dev-runtime') },
      ]
    },
    optimizeDeps: {
      // Pre-bundle the wrapper and extensions together to avoid mixing
      // optimized and source instances in development.
      include: codeMirrorDependencies,
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        // Artifacts console is merged into this app and served same-origin, so the
        // browser needs no second login. It reaches the store over the console's own
        // local-access path: keep this preview on trusted networks only, since anyone
        // who can reach it can read and annotate local artifacts.
        '/api/artifacts': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts-static': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts.js': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts.css': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts.html': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/api': `http://${proxyHost}:${serverPort}`,
        '/memory-dashboard': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    },
    test: {
      environment: 'jsdom',
      server: {
        deps: {
          inline: ['react', 'react-dom']
        }
      }
    }
  }
})
