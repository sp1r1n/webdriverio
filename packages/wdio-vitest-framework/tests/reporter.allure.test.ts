import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AllureReporter from '../../wdio-allure-reporter/src/index.js'
import { WdioBridgeReporter } from '../src/reporter.js'

const emitted = vi.hoisted(() => [] as [string, Record<string, any>][])

vi.mock('@wdio/runner', () => ({
    BaseReporter: class {
        initReporters = vi.fn().mockResolvedValue(undefined)
        waitForSync = vi.fn().mockResolvedValue(undefined)
        onMessage = vi.fn()
        setContextIdResolver = vi.fn()
        emit(event: string, payload: Record<string, any>) {
            emitted.push([event, { ...payload }])
        }
    }
}))

type HookOutcome = { state: 'pass' | 'fail', error?: object }

const attempt = (retry: number, state: 'passed' | 'failed', hooks: { beforeEach?: HookOutcome, afterEach?: HookOutcome }, error?: object) => ({
    event: 'wdio:attempt', retry,
    payload: { start: 100 * retry, end: 100 * retry + 10, state, ...(error && { error }), hooks }
})

const readJson = (dir: string, suffix: string) => fs.readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))

const run = async (outputDir: string, entries: object[]) => {
    const module: any = {
        type: 'module', id: 'm', moduleId: '/repo/a.spec.ts', relativeModuleId: 'a.spec.ts', children: { allTests: () => [test] },
        project: { config: { provide: { wdioCapabilities: { browserName: 'chrome' } } } },
        meta: () => ({ wdio: { sessionId: 's', capabilities: { browserName: 'chrome' } } }), state: () => 'passed'
    }
    const test: any = {
        type: 'test', id: 't1', name: 't', module, parent: module, options: { concurrent: false },
        result: () => ({ state: 'passed' }), diagnostic: () => ({ duration: 5, retryCount: entries.length - 1 }),
        meta: () => ({ 'wdio:runtime': entries })
    }
    const config = { framework: 'vitest', reporters: ['allure'] } as unknown as WebdriverIO.Config
    const bridge = new WdioBridgeReporter(config, () => {}, (err) => { throw err })
    bridge.onTestModuleStart(module)
    await bridge.onTestCaseReady(test)
    await bridge.onTestCaseResult(test)
    await bridge.onTestModuleEnd(module)

    const allure = new AllureReporter({ outputDir, stdout: true, writeStream: { write: () => true } as never, disableWebdriverStepsReporting: true, disableWebdriverScreenshotsReporting: true })
    emitted.forEach(([event, payload]) => allure.emit(event, payload))
    await vi.waitFor(() => expect(allure.isSynchronised).toBe(true))
    return readJson(outputDir, '-result.json').sort((a, b) => a.start - b.start)
}

describe('Allure output of a bridged run with a failing afterEach on a retried attempt', () => {
    let outputDir: string

    beforeEach(() => {
        emitted.length = 0
        outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdio-vitest-allure-'))
    })

    afterEach(() => {
        fs.rmSync(outputDir, { recursive: true, force: true })
    })

    it('writes one result per attempt and keeps the failed afterEach on its attempt', async () => {
        const results = await run(outputDir, [
            attempt(0, 'failed', { afterEach: { state: 'fail', error: { message: 'after boom' } } }, { message: 'after boom' }),
            attempt(1, 'passed', { afterEach: { state: 'pass' } })
        ])

        expect(results.map(({ name, status }) => [name, status])).toEqual([['t', 'broken'], ['t', 'passed']])
        // Allure keeps fixtures on the container of their test
        const afterHooksOf = (uuid: string) => readJson(outputDir, '-container.json')
            .filter(({ children }) => children.includes(uuid))
            .flatMap(({ afters }) => afters.map(({ name, status }: { name: string, status: string }) => [name, status]))
        expect(afterHooksOf(results[0].uuid)).toEqual([['"after each" hook for "t"', 'broken']])
        expect(afterHooksOf(results[1].uuid)).toEqual([['"after each" hook for "t"', 'passed']])
    })
})
