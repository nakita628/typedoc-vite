import { typedocVite } from 'typedoc-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    typedocVite({
      entryPoints: ['./src/index.ts'],
      tsconfig: './tsconfig.json',
      typedoc: { plugin: ['typedoc-plugin-mermaid'] },
    }),
  ],
})
