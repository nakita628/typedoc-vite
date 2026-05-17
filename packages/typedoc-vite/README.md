# typedoc-vite

A Vite plugin that generates [TypeDoc](https://typedoc.org/) documentation with HMR.

## Install

```bash
npm install -D typedoc-vite
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { typedocVite } from 'typedoc-vite'

export default defineConfig({
  publicDir: 'docs',
  plugins: [
    typedocVite({
      entryPoints: ['./src/**/*.ts'],
    }),
  ],
})
```

```bash
npx vite
```

## License

Distributed under the MIT License. See [LICENSE](https://github.com/nakita628/typedoc-vite?tab=MIT-1-ov-file) for more information.
