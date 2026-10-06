// tsc keeps side-effect imports in declaration files, so `import './TranslateControl.css'`
// reaches `dist/**/*.d.ts`, where TypeScript cannot resolve it (arethetypeswrong reports an
// internal resolution error). Declarations do not need the stylesheet; the JS still imports it.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CSS_IMPORT = /^import ['"][^'"]+\.css['"];?\n/gm

const declarationsIn = async dir =>
  (await readdir(dir, { recursive: true }))
    .filter(file => file.endsWith('.d.ts'))
    .map(file => join(dir, file))

for (const file of await declarationsIn('dist')) {
  const source = await readFile(file, 'utf8')
  const stripped = source.replace(CSS_IMPORT, '')
  if (stripped !== source) await writeFile(file, stripped)
}
