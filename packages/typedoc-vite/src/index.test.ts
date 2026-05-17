import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { typedocVite } from './index.js'

vi.mock('node:child_process', async () => {
  const { EventEmitter: EE } = await import('node:events')
  const forks: Array<{ workerPath: string; args: readonly string[] }> = []
  const config = { exitCode: 0 }
  const fork = (workerPath: string, args: readonly string[]) => {
    forks.push({ workerPath, args })
    const child = new EE()
    setImmediate(() => child.emit('exit', config.exitCode))
    return child
  }
  return { fork, __forks: forks, __config: config }
})

type Handler = (
  req: { url?: string },
  res: ResStub,
  next: (err?: unknown) => void,
) => void | Promise<void>

type ResStub = {
  setHeader: (name: string, value: string) => void
  end: (chunk?: string | Buffer) => void
}

type FakeServer = {
  config: {
    root: string
    base: string
    logger: {
      warn: (m: string) => void
      error: (m: string) => void
      info: (m: string) => void
    }
  }
  httpServer: null
  ws: { send: (msg: { type: string }) => void }
  watcher: EventEmitter & { add: (p: string) => void; unwatch: (p: string) => void }
  middlewares: { use: (h: Handler) => void }
}

type PluginShape = {
  name: string
  apply: string
  config: () => unknown
  configureServer: (server: FakeServer) => void | Promise<void>
}

const cp = (await import('node:child_process')) as unknown as {
  __forks: Array<{ workerPath: string; args: readonly string[] }>
  __config: { exitCode: number }
}

const flush = () => new Promise<void>((r) => setImmediate(r))
const drain = async () => {
  await flush()
  await flush()
  await flush()
  await flush()
  await flush()
}

const createFakeServer = (root: string, viteBase = '/') => {
  const watcher = new EventEmitter()
  const state = {
    watcherAdds: [] as string[],
    watcherUnwatches: [] as string[],
    wsMessages: [] as Array<{ type: string }>,
    loggerWarns: [] as string[],
    loggerErrors: [] as string[],
    handlers: [] as Handler[],
  }
  const enhancedWatcher = Object.assign(watcher, {
    add: (p: string) => {
      state.watcherAdds.push(p)
    },
    unwatch: (p: string) => {
      state.watcherUnwatches.push(p)
    },
  })
  const fake: FakeServer = {
    config: {
      root,
      base: viteBase,
      logger: {
        warn: (m) => state.loggerWarns.push(m),
        error: (m) => state.loggerErrors.push(m),
        info: () => undefined,
      },
    },
    httpServer: null,
    ws: { send: (msg) => state.wsMessages.push(msg) },
    watcher: enhancedWatcher,
    middlewares: { use: (h) => state.handlers.push(h) },
  }
  return { fake, watcher: enhancedWatcher, state }
}

const createReq = (url: string) => ({ url })

const createRes = () => {
  const data = {
    headers: {} as Record<string, string>,
    chunks: [] as Buffer[],
    ended: false,
  }
  const res: ResStub = {
    setHeader: (k, v) => {
      data.headers[k.toLowerCase()] = v
    },
    end: (chunk) => {
      if (typeof chunk === 'string') data.chunks.push(Buffer.from(chunk))
      else if (chunk) data.chunks.push(chunk)
      data.ended = true
    },
  }
  return {
    res,
    headers: () => data.headers,
    body: () => (data.chunks.length ? Buffer.concat(data.chunks) : undefined),
    text: () => (data.chunks.length ? Buffer.concat(data.chunks).toString('utf8') : undefined),
    ended: () => data.ended,
  }
}

const createNext = () => {
  const data = { calls: [] as unknown[] }
  return {
    next: (err?: unknown) => {
      data.calls.push(err)
    },
    calls: () => data.calls,
  }
}

const tmpRoot = path.join(os.tmpdir(), `typedoc-vite-test-${process.pid}`)
const tmpState = { current: '' }

const mkTmp = async () => {
  const dir = path.join(tmpRoot, `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fsp.mkdir(dir, { recursive: true })
  tmpState.current = dir
  return dir
}

const writeFile = async (rel: string, content: string | Buffer) => {
  const abs = path.join(tmpState.current, rel)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
  return abs
}

beforeEach(() => {
  cp.__forks.length = 0
  cp.__config.exitCode = 0
})

afterEach(async () => {
  if (tmpState.current) {
    await fsp.rm(tmpState.current, { recursive: true, force: true })
    tmpState.current = ''
  }
  vi.useRealTimers()
})

describe('typedocVite (plugin contract)', () => {
  it('returns a Vite plugin object with name "typedoc-vite"', () => {
    const plugin = typedocVite() as unknown as PluginShape
    expect(plugin.name).toBe('typedoc-vite')
  })

  it('applies only to the dev server (apply: "serve")', () => {
    const plugin = typedocVite() as unknown as PluginShape
    expect(plugin.apply).toBe('serve')
  })

  it('exposes a configureServer hook as a function', () => {
    const plugin = typedocVite() as unknown as PluginShape
    expect(typeof plugin.configureServer).toBe('function')
  })

  it('accepts a fully populated options object without throwing', () => {
    expect(() =>
      typedocVite({
        entryPoints: ['packages/**/*.ts'],
        out: 'public/docs',
        tsconfig: './tsconfig.docs.json',
        exclude: ['**/node_modules/**'],
        watch: ['packages/**/*.ts'],
        debounceMs: 50,
        serve: { base: '/api/docs' },
        typedoc: { plugin: ['typedoc-plugin-mermaid'] },
      }),
    ).not.toThrow()
  })

  it('accepts serve: false without throwing', () => {
    expect(() => typedocVite({ serve: false })).not.toThrow()
  })

  it('accepts no arguments and uses defaults without throwing', () => {
    expect(() => typedocVite()).not.toThrow()
  })
})

describe('typedocVite.config()', () => {
  it('returns an ignored watch glob derived from the default out directory', () => {
    const plugin = typedocVite() as unknown as PluginShape
    expect(plugin.config()).toStrictEqual({
      server: { watch: { ignored: ['**/docs/**'] } },
    })
  })

  it('reflects a custom out directory in the ignored watch glob', () => {
    const plugin = typedocVite({ out: 'public/docs' }) as unknown as PluginShape
    expect(plugin.config()).toStrictEqual({
      server: { watch: { ignored: ['**/public/docs/**'] } },
    })
  })
})

describe('configureServer middleware (HTML)', () => {
  it('serves docs/index.html with @vite/client injected into <head>', async () => {
    const root = await mkTmp()
    await writeFile(
      'docs/index.html',
      '<!doctype html><html><head><title>x</title></head><body>ok</body></html>',
    )
    const { fake, state } = createFakeServer(root, '/')
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers, text } = createRes()
    const { next, calls } = createNext()
    await state.handlers[0]?.(createReq('/'), res, next)
    expect(calls()).toStrictEqual([])
    expect(headers()['content-type']).toBe('text/html; charset=utf-8')
    expect(headers()['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(text()).toBe(
      '<!doctype html><html><head><script type="module" src="/@vite/client"></script><title>x</title></head><body>ok</body></html>',
    )
  })

  it('serves a subpath HTML file (e.g. /functions/foo.html)', async () => {
    const root = await mkTmp()
    await writeFile('docs/functions/foo.html', '<html><head></head><body>foo</body></html>')
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers, text } = createRes()
    const { next, calls } = createNext()
    await state.handlers[0]?.(createReq('/functions/foo.html'), res, next)
    expect(calls()).toStrictEqual([])
    expect(headers()['content-type']).toBe('text/html; charset=utf-8')
    expect(text()).toBe(
      '<html><head><script type="module" src="/@vite/client"></script></head><body>foo</body></html>',
    )
  })

  it('warns and serves unmodified HTML when <head> is missing', async () => {
    const root = await mkTmp()
    await writeFile('docs/index.html', '<html><body>no head</body></html>')
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, text } = createRes()
    const { next } = createNext()
    await state.handlers[0]?.(createReq('/'), res, next)
    expect(state.loggerWarns.length).toBe(1)
    expect(text()).toBe('<html><body>no head</body></html>')
  })

  it('appends index.html when URL ends with a slash', async () => {
    const root = await mkTmp()
    await writeFile('docs/functions/index.html', '<html><head></head><body>idx</body></html>')
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers } = createRes()
    const { next } = createNext()
    await state.handlers[0]?.(createReq('/functions/'), res, next)
    expect(headers()['content-type']).toBe('text/html; charset=utf-8')
  })
})

describe('configureServer middleware (assets)', () => {
  it('serves a .css asset with text/css Content-Type', async () => {
    const root = await mkTmp()
    await writeFile('docs/assets/style.css', 'body{color:red}')
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers, body } = createRes()
    const { next } = createNext()
    await state.handlers[0]?.(createReq('/assets/style.css'), res, next)
    expect(headers()['content-type']).toBe('text/css; charset=utf-8')
    expect(body()).toStrictEqual(Buffer.from('body{color:red}'))
  })

  it('returns application/octet-stream for unknown file extensions', async () => {
    const root = await mkTmp()
    await writeFile('docs/data.bin', Buffer.from([0, 1, 2]))
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers } = createRes()
    const { next } = createNext()
    await state.handlers[0]?.(createReq('/data.bin'), res, next)
    expect(headers()['content-type']).toBe('application/octet-stream')
  })

  it('falls through to next() when the file does not exist', async () => {
    const root = await mkTmp()
    await fsp.mkdir(path.join(root, 'docs'), { recursive: true })
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers, ended } = createRes()
    const { next, calls } = createNext()
    await state.handlers[0]?.(createReq('/missing/file.css'), res, next)
    expect(calls()).toStrictEqual([undefined])
    expect(ended()).toBe(false)
    expect(headers()).toStrictEqual({})
  })
})

describe('configureServer middleware (security)', () => {
  it('rejects path traversal via .. segments by falling through', async () => {
    const root = await mkTmp()
    await writeFile('secret.txt', 'top-secret')
    await fsp.mkdir(path.join(root, 'docs'), { recursive: true })
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers, ended } = createRes()
    const { next, calls } = createNext()
    await state.handlers[0]?.(createReq('/../secret.txt'), res, next)
    expect(calls()).toStrictEqual([undefined])
    expect(ended()).toBe(false)
    expect(headers()).toStrictEqual({})
  })

  it('rejects URL paths containing a null byte by falling through', async () => {
    const root = await mkTmp()
    await fsp.mkdir(path.join(root, 'docs'), { recursive: true })
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers, ended } = createRes()
    const { next, calls } = createNext()
    await state.handlers[0]?.(createReq('/foo\0.html'), res, next)
    expect(calls()).toStrictEqual([undefined])
    expect(ended()).toBe(false)
    expect(headers()).toStrictEqual({})
  })
})

describe('configureServer middleware (base prefix)', () => {
  it('serves index.html under the configured serve.base', async () => {
    const root = await mkTmp()
    await writeFile('docs/index.html', '<html><head></head><body>b</body></html>')
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite({ serve: { base: '/api/docs' } }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers } = createRes()
    const { next, calls } = createNext()
    await state.handlers[0]?.(createReq('/api/docs/'), res, next)
    expect(calls()).toStrictEqual([])
    expect(headers()['content-type']).toBe('text/html; charset=utf-8')
  })

  it('falls through when URL is outside the configured serve.base', async () => {
    const root = await mkTmp()
    await writeFile('docs/index.html', '<html><head></head><body>b</body></html>')
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite({ serve: { base: '/api/docs' } }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const { res, headers, ended } = createRes()
    const { next, calls } = createNext()
    await state.handlers[0]?.(createReq('/other/path'), res, next)
    expect(calls()).toStrictEqual([undefined])
    expect(ended()).toBe(false)
    expect(headers()).toStrictEqual({})
  })
})

describe('configureServer (serve: false)', () => {
  it('does not register any middleware', async () => {
    const root = await mkTmp()
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite({ serve: false }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    expect(state.handlers).toStrictEqual([])
  })
})

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('configureServer (watcher + worker)', () => {
  it('runs the worker once on startup and sends a full-reload over ws', async () => {
    const root = await mkTmp()
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    expect(cp.__forks.length).toBe(1)
    expect(state.wsMessages).toStrictEqual([{ type: 'full-reload' }])
  })

  it('ignores changes to non-TypeScript files', async () => {
    const root = await mkTmp()
    const { fake, watcher } = createFakeServer(root)
    const plugin = typedocVite({ debounceMs: 10 }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    const before = cp.__forks.length
    watcher.emit('change', path.join(root, 'src', 'readme.md'))
    await wait(50)
    await drain()
    expect(cp.__forks.length).toBe(before)
  })

  it('coalesces a burst of TypeScript changes into a single worker run via debounce', async () => {
    const root = await mkTmp()
    const fileA = await writeFile('src/a.ts', 'export const a = 1\n')
    const fileB = await writeFile('src/b.ts', 'export const b = 2\n')
    const fileC = await writeFile('src/c.ts', 'export const c = 3\n')
    const { fake, watcher } = createFakeServer(root)
    const plugin = typedocVite({ debounceMs: 50 }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await wait(30)
    await drain()
    const before = cp.__forks.length
    watcher.emit('change', fileA)
    watcher.emit('change', fileB)
    watcher.emit('change', fileC)
    await wait(150)
    await drain()
    expect(cp.__forks.length).toBe(before + 1)
  })

  it('skips re-running when the same file changes with identical content', async () => {
    const root = await mkTmp()
    const file = await writeFile('src/a.ts', 'export const a = 1\n')
    const { fake, watcher } = createFakeServer(root)
    const plugin = typedocVite({ debounceMs: 10 }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await wait(30)
    await drain()
    watcher.emit('change', file)
    await wait(50)
    await drain()
    const after1 = cp.__forks.length
    watcher.emit('change', file)
    await wait(50)
    await drain()
    expect(cp.__forks.length).toBe(after1)
  })

  it('re-runs when the file content actually changes', async () => {
    const root = await mkTmp()
    const file = await writeFile('src/a.ts', 'export const a = 1\n')
    const { fake, watcher } = createFakeServer(root)
    const plugin = typedocVite({ debounceMs: 10 }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await wait(30)
    await drain()
    watcher.emit('change', file)
    await wait(50)
    await drain()
    const after1 = cp.__forks.length
    await fsp.writeFile(file, 'export const a = 2\n')
    watcher.emit('change', file)
    await wait(50)
    await drain()
    expect(cp.__forks.length).toBe(after1 + 1)
  })

  it('registers watch paths resolved against config.root', async () => {
    const root = await mkTmp()
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite({ watch: ['src/**/*.ts'] }) as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    expect(state.watcherAdds).toStrictEqual([path.resolve(root, 'src/**/*.ts')])
  })
})

describe('configureServer (error path)', () => {
  it('logs an error via the Vite logger when the worker exits with a non-zero code', async () => {
    cp.__config.exitCode = 1
    const root = await mkTmp()
    const { fake, state } = createFakeServer(root)
    const plugin = typedocVite() as unknown as PluginShape
    await plugin.configureServer(fake)
    await drain()
    expect(state.loggerErrors.length).toBe(1)
    expect(state.wsMessages).toStrictEqual([])
  })
})
