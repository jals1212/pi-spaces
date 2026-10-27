// Makes cli/node_modules/@jals1212/pi-spaces a symlink to this repository, so
// the CLI (its own package, in cli/) imports '@jals1212/pi-spaces/spaces' from
// the working tree, as it will from npm. Run before the CLI's build and tests.
// Safe to repeat: it leaves alone anything already there (a link, or a real
// install), and never replaces it.

import { lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const link = join(root, 'cli', 'node_modules', '@jals1212', 'pi-spaces')

try {
  lstatSync(link)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  mkdirSync(dirname(link), { recursive: true })
  // 'junction' is what Windows takes without admin rights; the other systems ignore it.
  symlinkSync(root, link, 'junction')
}
