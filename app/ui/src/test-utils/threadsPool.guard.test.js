// Guards the UI suite's `pool: 'threads'` (vite.config.js).
//
// Worker threads share one process, so the few process-wide operations a forked
// worker allows are unavailable: `process.chdir()` throws
// ERR_WORKER_UNSUPPORTED_OPERATION inside a worker thread. A test that needs it
// would fail only under this pool, with an error that doesn't point back here.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import viteConfig from '../../vite.config.js'

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const roots = ['src', 'eslint-rules', '../../tools/crawlers'].map(r => path.resolve(uiRoot, r))
const SELF = fileURLToPath(import.meta.url)

function testFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...testFiles(full))
    else if (/\.test\.jsx?$/.test(name) && full !== SELF) out.push(full)
  }
  return out
}

// Matches a call, not the words in a comment or string about it.
const CHDIR_CALL = /\bprocess\.chdir\s*\(/

describe('UI test suite runs in worker threads', () => {
  it('is configured with the threads pool', () => {
    expect(viteConfig.test.pool).toBe('threads')
  })

  it('the chdir detector matches a call and nothing else', () => {
    expect(CHDIR_CALL.test("process.chdir('/tmp')")).toBe(true)
    expect(CHDIR_CALL.test('process.chdir (dir)')).toBe(true)
    expect(CHDIR_CALL.test('process.cwd()')).toBe(false)
    expect(CHDIR_CALL.test('myprocess.chdirectory()')).toBe(false)
  })

  it('no test file calls process.chdir(), which a worker thread cannot do', () => {
    const files = roots.flatMap(testFiles)
    expect(files.length).toBeGreaterThan(300) // the walk found the suite, not an empty dir
    const offenders = files
      .filter(f => CHDIR_CALL.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(uiRoot, f))
    expect(offenders).toEqual([])
  })
})
