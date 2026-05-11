import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  LABEL,
  buildBaseOutput,
  checkVitestAvailability,
  classifyFailures,
  classifySingleFailure,
  loadCache,
  main,
  parseArgs,
  parseVitestOutput,
  runClassifyMode,
  runRunMode,
  runStatusMode,
  saveCache,
} = require('../../../scripts/test-runner-bot.cjs')

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-bot-'))
  tempDirs.push(dir)
  return dir
}

function makeMemoryFsApi(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files))
  return {
    existsSync: (p: string) => store.has(p),
    readFileSync: (p: string, _encoding?: string) => {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`)
      return store.get(p)!
    },
    mkdirSync: () => {},
    writeFileSync: (p: string, content: string) => { store.set(p, content) },
    _store: store,
  }
}

describe('test runner bot', () => {
  it('status mode returns correct agent and label', () => {
    const result = runStatusMode(ROOT)

    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(result.mode).toBe('status')
    expect(typeof result.status).toBe('string')
  })

  it('status mode reports vitest availability', () => {
    const result = runStatusMode(ROOT)

    expect(typeof result.vitest_available).toBe('boolean')
    // vitest IS available in this repo
    expect(result.vitest_available).toBe(true)
  })

  it('status mode has null last_run_summary when cache is empty', () => {
    const tempDir = makeTempDir()
    const result = runStatusMode(tempDir, { fsApi: makeMemoryFsApi() })

    expect(result.last_run_summary).toBeNull()
    expect(result.last_run_at).toBeNull()
  })

  it('status mode loads last_run_summary from cache when present', () => {
    const tempDir = makeTempDir()
    const cacheFile = path.join(tempDir, '.data', 'test-runner-cache.json')
    const cacheContent = JSON.stringify({
      last_run_summary: {
        scope: 'src/lib/__tests__/foo.test.ts',
        files_run: 1,
        tests_passed: 5,
        tests_failed: 0,
        tests_skipped: 0,
        duration_ms: 1234,
        classification: 'all_pass',
      },
      last_run_at: '2026-05-10T12:00:00.000Z',
    })
    const fsApi = makeMemoryFsApi({ [cacheFile]: cacheContent })

    const result = runStatusMode(tempDir, { fsApi })

    expect(result.last_run_summary).not.toBeNull()
    expect(result.last_run_summary?.classification).toBe('all_pass')
    expect(result.last_run_at).toBe('2026-05-10T12:00:00.000Z')
  })

  it('status mode output shape includes required fields', () => {
    const result = runStatusMode(ROOT)

    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(typeof result.mode).toBe('string')
    expect(typeof result.status).toBe('string')
    expect(Array.isArray(result.warnings)).toBe(true)
    expect(Array.isArray(result.blockers)).toBe(true)
    expect(typeof result.metadata).toBe('object')
    expect(typeof result.summary).toBe('string')
  })

  it('run mode returns FAIL when scope is missing', () => {
    const result = runRunMode(ROOT, '')

    expect(result.status).toBe('FAIL')
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('run mode with injected command runner returns parsed stats', () => {
    const vitestOutput = [
      'src/lib/__tests__/foo.test.ts',
      '',
      ' Test Files  1 passed (1)',
      ' Tests  3 passed (3)',
      '',
    ].join('\n')

    const commandRunner = (_cmd: string, _args: string[]) => ({
      ok: true,
      status: 0,
      stdout: vitestOutput,
      stderr: '',
      error: '',
      _duration_ms: 500,
    })

    const result = runRunMode(
      ROOT,
      'src/lib/__tests__/foo.test.ts',
      { commandRunner, fsApi: makeMemoryFsApi() },
    )

    expect(result.mode).toBe('run')
    expect(typeof result.files_run).toBe('number')
    expect(typeof result.tests_passed).toBe('number')
    expect(typeof result.tests_failed).toBe('number')
    expect(typeof result.tests_skipped).toBe('number')
    expect(typeof result.duration_ms).toBe('number')
    expect(Array.isArray(result.failures)).toBe(true)
    expect(typeof result.classification).toBe('string')
  })

  it('run mode classification is all_pass when tests pass', () => {
    const commandRunner = () => ({
      ok: true,
      status: 0,
      stdout: ' Tests  5 passed (5)\n Test Files  2 passed (2)\n',
      stderr: '',
      error: '',
    })

    const result = runRunMode(ROOT, 'src/some.test.ts', {
      commandRunner,
      fsApi: makeMemoryFsApi(),
    })

    expect(result.classification).toBe('all_pass')
    expect(result.status).toBe('PASS')
  })

  it('run mode classification is some_fail when tests fail', () => {
    const vitestOutput = [
      ' FAIL src/lib/__tests__/foo.test.ts',
      '',
      ' Tests  2 passed | 1 failed (3)',
      ' Test Files  1 failed | 1 passed (2)',
    ].join('\n')

    const commandRunner = () => ({
      ok: false,
      status: 1,
      stdout: vitestOutput,
      stderr: '',
      error: '',
    })

    const result = runRunMode(ROOT, 'src/lib/__tests__/foo.test.ts', {
      commandRunner,
      fsApi: makeMemoryFsApi(),
    })

    expect(result.tests_failed).toBeGreaterThan(0)
    expect(result.classification).toBe('some_fail')
    expect(result.status).toBe('FAIL')
  })

  it('run mode saves to cache after a run', () => {
    const tempDir = makeTempDir()
    const cacheFile = path.join(tempDir, '.data', 'test-runner-cache.json')
    const fsApi = makeMemoryFsApi()

    const commandRunner = () => ({
      ok: true,
      status: 0,
      stdout: ' Tests  2 passed (2)\n Test Files  1 passed (1)\n',
      stderr: '',
      error: '',
    })

    runRunMode(tempDir, 'src/some.test.ts', { commandRunner, fsApi })

    expect(fsApi._store.has(cacheFile)).toBe(true)
    const saved = JSON.parse(fsApi._store.get(cacheFile)!)
    expect(saved.last_run_at).toBeTruthy()
    expect(saved.last_run_summary).toBeTruthy()
  })

  it('classify mode returns FAIL when output file is missing', () => {
    const result = runClassifyMode(ROOT, '')

    expect(result.status).toBe('FAIL')
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('classify mode reads and classifies a test output file', () => {
    const tempDir = makeTempDir()
    const outputContent = [
      ' FAIL src/lib/__tests__/foo.test.ts',
      '  × should do something',
      '  AssertionError: expected 1 to equal 2',
      '',
      ' Tests  1 passed | 1 failed (2)',
    ].join('\n')
    const outputFile = path.join(tempDir, 'test-output.txt')
    const fsApi = makeMemoryFsApi({ [outputFile]: outputContent })

    const result = runClassifyMode(tempDir, outputFile, { fsApi })

    expect(result.mode).toBe('classify')
    expect(typeof result.classification).toBe('string')
    expect(Array.isArray(result.failures)).toBe(true)
  })

  it('classify mode classification field is one of known values', () => {
    const tempDir = makeTempDir()
    const outputFile = path.join(tempDir, 'output.txt')
    const fsApi = makeMemoryFsApi({ [outputFile]: ' Tests  3 passed (3)\n' })

    const result = runClassifyMode(tempDir, outputFile, { fsApi })

    const valid = ['all_pass', 'some_fail', 'timeout', 'error']
    expect(valid).toContain(result.classification)
  })

  it('requires_human_for is not present on test runner bot (observer)', () => {
    const result = runStatusMode(ROOT)

    expect(result).not.toHaveProperty('requires_human_for')
  })

  it('run mode does not have requires_human_for field', () => {
    const commandRunner = () => ({
      ok: true,
      status: 0,
      stdout: ' Tests  1 passed (1)\n',
      stderr: '',
      error: '',
    })

    const result = runRunMode(ROOT, 'src/some.test.ts', {
      commandRunner,
      fsApi: makeMemoryFsApi(),
    })

    expect(result).not.toHaveProperty('requires_human_for')
  })

  it('parseVitestOutput extracts passed and failed counts', () => {
    const stdout = ' Tests  8 passed | 2 failed (10)\n Test Files  3 passed | 1 failed (4)\n'
    const parsed = parseVitestOutput(stdout, '', 1, 1000)

    expect(parsed.tests_passed).toBe(8)
    expect(parsed.tests_failed).toBe(2)
    expect(parsed.classification).toBe('some_fail')
  })

  it('parseVitestOutput returns all_pass for clean output', () => {
    const stdout = ' Tests  5 passed (5)\n Test Files  2 passed (2)\n'
    const parsed = parseVitestOutput(stdout, '', 0, 800)

    expect(parsed.tests_passed).toBe(5)
    expect(parsed.tests_failed).toBe(0)
    expect(parsed.classification).toBe('all_pass')
  })

  it('classifySingleFailure returns flaky for timeout errors', () => {
    const cls = classifySingleFailure('src/lib/__tests__/foo.test.ts', 'test that waits', 'timeout exceeded', [])
    expect(cls).toBe('flaky')
  })

  it('classifySingleFailure returns introduced when file matches diff', () => {
    const diffFiles = ['src/lib/__tests__/bar.test.ts']
    const cls = classifySingleFailure(
      'src/lib/__tests__/bar.test.ts',
      'some test',
      'AssertionError: 1 !== 2',
      diffFiles,
    )
    expect(cls).toBe('introduced')
  })

  it('classifySingleFailure returns pre-existing for file not in diff', () => {
    const diffFiles = ['src/lib/unrelated.ts']
    const cls = classifySingleFailure(
      'src/lib/__tests__/old.test.ts',
      'some test',
      'AssertionError',
      diffFiles,
    )
    expect(cls).toBe('pre-existing')
  })

  it('classifyFailures returns all_pass for output with no failures', () => {
    const output = ' Tests  5 passed (5)\n'
    const result = classifyFailures(output, [])
    expect(result.classification).toBe('all_pass')
    expect(result.failures).toEqual([])
  })

  it('loadCache returns null when file does not exist', () => {
    const tempDir = makeTempDir()
    const cache = loadCache(tempDir, makeMemoryFsApi())
    expect(cache).toBeNull()
  })

  it('saveCache and loadCache round-trip', () => {
    const tempDir = makeTempDir()
    const fsApi = makeMemoryFsApi()
    const data = {
      last_run_summary: { scope: 'foo', classification: 'all_pass' },
      last_run_at: '2026-05-10T12:00:00.000Z',
    }

    saveCache(tempDir, data, fsApi)
    const loaded = loadCache(tempDir, fsApi)

    expect(loaded).not.toBeNull()
    expect(loaded.last_run_at).toBe('2026-05-10T12:00:00.000Z')
    expect(loaded.last_run_summary.classification).toBe('all_pass')
  })

  it('parseArgs extracts mode and options correctly', () => {
    const parsed = parseArgs(['run', '--scope', 'src/lib/__tests__/foo.test.ts'])
    expect(parsed.mode).toBe('run')
    expect(parsed.options.scope).toBe('src/lib/__tests__/foo.test.ts')
  })

  it('parseArgs defaults to status when no mode provided', () => {
    const parsed = parseArgs([])
    expect(parsed.mode).toBe('status')
  })

  it('buildBaseOutput returns correct agent and label', () => {
    const output = buildBaseOutput('status')
    expect(output.agent).toBe(AGENT)
    expect(output.label).toBe(LABEL)
    expect(output.mode).toBe('status')
    expect(output.status).toBe('PASS')
  })

  it('CLI status returns valid JSON', () => {
    const execution = spawnSync(process.execPath, ['scripts/test-runner-bot.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('status')
    expect(typeof parsed.vitest_available).toBe('boolean')
  })

  it('CLI classify mode returns classification field in JSON', () => {
    const tempDir = makeTempDir()
    const outputFile = path.join(tempDir, 'out.txt')
    fs.writeFileSync(outputFile, ' Tests  3 passed (3)\n')

    const execution = spawnSync(
      process.execPath,
      ['scripts/test-runner-bot.cjs', 'classify', '--output', outputFile],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.mode).toBe('classify')
    expect(typeof parsed.classification).toBe('string')
  })

  it('main function dispatches to correct mode', () => {
    const result = main(['status'], { rootDir: ROOT })
    expect(result.mode).toBe('status')
    expect(result.agent).toBe(AGENT)
  })
})
