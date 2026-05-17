import { fork } from 'node:child_process'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TypeDocOptions } from 'typedoc'
import type { Plugin, ViteDevServer } from 'vite'

import type { WorkerOptions } from './worker.js'

export function typedocVite(
  options: {
    readonly entryPoints?: readonly string[]
    readonly out?: string
    readonly tsconfig?: string
    readonly exclude?: readonly string[]
    readonly watch?: readonly string[]
    readonly debounceMs?: number
    readonly serve?: false | { readonly base?: string }
    readonly typedoc?: Partial<TypeDocOptions>
  } = {},
) {
  const entryPoints = options.entryPoints ?? ['./src/**/*.ts']
  const out = options.out ?? 'docs'
  const tsconfig = options.tsconfig ?? 'tsconfig.json'
  const exclude =
    options.exclude ?? (['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.d.ts'] as const)
  const watch = options.watch ?? ['src/**/*.{ts,tsx,mts,cts}']
  const debounceMs = options.debounceMs ?? 200
  const serve =
    options.serve === false ? false : { base: normalizeBase(options.serve?.base ?? '/') }
  const typedoc = options.typedoc ?? {}

  const serverRef: { current: ViteDevServer | null } = { current: null }
  const runPromise: { current: Promise<void> | null } = { current: null }
  const fileHashCache = new Map<string, string>()

  const run = async () => {
    const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url))
    const payload = JSON.stringify({
      entryPoints,
      exclude,
      tsconfig,
      out,
      typedoc,
    } satisfies WorkerOptions)
    await new Promise<void>((resolve, reject) => {
      const child = fork(workerPath, [payload], { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else
          reject(
            new Error(
              `typedoc-vite: worker exited with code ${code ?? 'null'}. ` +
                'Check the TypeDoc output above (entryPoints / tsconfig).',
            ),
          )
      })
    })
    serverRef.current?.ws.send({ type: 'full-reload' })
  }

  const handleError = (err: unknown) => {
    const logger = serverRef.current?.config.logger
    const msg = err instanceof Error ? err.message : String(err)
    if (logger) logger.error(`[typedoc-vite] ${msg}`)
    else console.error('[typedoc-vite]', err)
  }

  const safeRun = () => {
    const p = run()
      .catch(handleError)
      .finally(() => {
        if (runPromise.current === p) runPromise.current = null
      })
    runPromise.current = p
  }

  const runDebounced = debounce(debounceMs, safeRun)

  return {
    name: 'typedoc-vite',
    apply: 'serve' as const,
    config() {
      return {
        server: {
          watch: {
            ignored: [`**/${out}/**`],
          },
        },
      }
    },
    configureServer(server) {
      serverRef.current = server

      const absOut = path.resolve(server.config.root, out)
      server.watcher.unwatch(absOut)
      server.watcher.unwatch(`${absOut}/**`)

      if (server.httpServer && !server.httpServer.listening) {
        server.httpServer.once('listening', safeRun)
      } else {
        setImmediate(safeRun)
      }

      for (const w of watch) {
        server.watcher.add(path.resolve(server.config.root, w))
      }

      server.watcher.on('change', (file: string) => {
        void (async () => {
          if (!['.ts', '.tsx', '.mts', '.cts'].some((ext) => file.endsWith(ext))) return
          const changed = await detectContentChange(fileHashCache, file)
          if (changed) runDebounced()
        })().catch(handleError)
      })

      if (serve === false) return
      const base = serve.base
      const publicRoot = path.resolve(server.config.root, out)
      const viteBase = server.config.base

      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? '/'
          const urlPath = rawUrl.split('?')[0] ?? '/'
          const sub = stripBase(urlPath, base)
          if (sub === null) return next()
          const isHtml = sub === '/' || sub.endsWith('/') || sub.endsWith('.html')
          const file = resolveStaticPath(sub, publicRoot, isHtml)
          if (file === null) return next()
          if (isHtml) {
            if (runPromise.current) await runPromise.current
            const raw = await fsp.readFile(file, 'utf8')
            const clientTag = `<script type="module" src="${viteBase}@vite/client"></script>`
            const headPattern = /<head(\s[^>]*)?>/i
            const html = headPattern.test(raw)
              ? raw.replace(headPattern, (m) => `${m}${clientTag}`)
              : (() => {
                  server.config.logger.warn(
                    `[typedoc-vite] <head> tag not found in ${path.relative(publicRoot, file)}; ` +
                      'HMR client not injected. Check TypeDoc template output.',
                  )
                  return raw
                })()
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            res.end(html)
            return
          }
          const data = await fsp.readFile(file)
          res.setHeader('Content-Type', mimeFor(file))
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
          res.end(data)
        } catch {
          next()
        }
      })
    },
  } satisfies Plugin
}

function normalizeBase(raw: string) {
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

function stripBase(urlPath: string, base: string) {
  if (base === '/') return urlPath
  const baseNoTrailing = base.slice(0, -1)
  if (urlPath === baseNoTrailing || urlPath === base) return '/'
  if (!urlPath.startsWith(base)) return null
  return `/${urlPath.slice(base.length)}`
}

function resolveStaticPath(urlPath: string, root: string, addIndex: boolean) {
  if (urlPath.includes('\0')) return null
  const rel = addIndex
    ? urlPath === '/' || urlPath === ''
      ? 'index.html'
      : urlPath.endsWith('/')
        ? `${urlPath.replace(/^\/+/, '')}index.html`
        : urlPath.replace(/^\/+/, '')
    : urlPath.replace(/^\/+/, '')
  const absRoot = path.resolve(root)
  const file = path.resolve(absRoot, rel)
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : `${absRoot}${path.sep}`
  if (file !== absRoot && !file.startsWith(rootWithSep)) return null
  return file
}

function mimeFor(file: string) {
  const ext = path.extname(file).toLowerCase()
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.txt': 'text/plain; charset=utf-8',
    }[ext] ?? 'application/octet-stream'
  )
}

function debounce(ms: number, fn: () => void) {
  const state: { id: NodeJS.Timeout | undefined } = { id: undefined }
  return () => {
    if (state.id !== undefined) clearTimeout(state.id)
    state.id = setTimeout(fn, ms)
  }
}

async function detectContentChange(cache: Map<string, string>, filePath: string) {
  try {
    const content = await fsp.readFile(filePath, 'utf8')
    const newHash = crypto.createHash('sha256').update(content).digest('hex')
    const oldHash = cache.get(filePath)
    if (oldHash === newHash) return false
    cache.set(filePath, newHash)
    return true
  } catch {
    cache.delete(filePath)
    return false
  }
}
