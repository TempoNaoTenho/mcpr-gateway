import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SCRIPT_PATH), '..')

export function shouldInstallUiDependencies(rootDir = ROOT) {
  return existsSync(join(rootDir, 'ui', 'package.json'))
}

export function runUiPostinstall(rootDir = ROOT, runNpm = defaultRunNpm) {
  if (!shouldInstallUiDependencies(rootDir)) {
    console.log('Skipping ui dependency install because ui/package.json is not present yet.')
    return 0
  }

  return runNpm(rootDir)
}

function defaultRunNpm(rootDir) {
  const result = spawnSync('npm', ['--prefix', 'ui', 'ci'], {
    cwd: rootDir,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  return result.status ?? 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exit(runUiPostinstall())
}
