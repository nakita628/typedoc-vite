import { Application, TSConfigReader, TypeDocReader, type TypeDocOptions } from 'typedoc'

export type WorkerOptions = {
  readonly entryPoints: readonly string[]
  readonly exclude: readonly string[]
  readonly tsconfig: string
  readonly out: string
  readonly typedoc: Partial<TypeDocOptions>
}

async function workerMain() {
  const payload = process.argv[2]
  if (!payload) {
    throw new Error(
      'typedoc-vite: worker received no options payload. ' +
        'This is an internal error — please file an issue.',
    )
  }
  const options = JSON.parse(payload) as WorkerOptions
  const app = await Application.bootstrapWithPlugins(
    {
      entryPoints: [...options.entryPoints],
      exclude: [...options.exclude],
      tsconfig: options.tsconfig,
      skipErrorChecking: true,
      ...options.typedoc,
    },
    [new TypeDocReader(), new TSConfigReader()],
  )
  const project = await app.convert()
  if (!project) {
    throw new Error(
      'typedoc-vite: TypeDoc.convert() returned undefined. ' +
        'Check that entryPoints resolve to TypeScript files and that tsconfig is valid.',
    )
  }
  await app.generateDocs(project, options.out)
}

workerMain()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
