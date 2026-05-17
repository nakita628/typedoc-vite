import { describe, expect, it } from 'vite-plus/test'

import { typedocVite } from './index.js'

describe('typedocVite', () => {
  it('returns a Vite plugin object with name "typedoc-vite"', () => {
    const plugin = typedocVite()
    expect(plugin && typeof plugin === 'object' && 'name' in plugin && plugin.name).toBe(
      'typedoc-vite',
    )
  })

  it('applies only to the dev server (apply: "serve")', () => {
    const plugin = typedocVite()
    expect(plugin && typeof plugin === 'object' && 'apply' in plugin && plugin.apply).toBe('serve')
  })

  it('exposes a configureServer hook as a function', () => {
    const plugin = typedocVite()
    const obj = plugin as { configureServer: unknown }
    expect(typeof obj.configureServer).toBe('function')
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
