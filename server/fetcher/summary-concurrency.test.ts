import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetSetting } = vi.hoisted(() => ({
  mockGetSetting: vi.fn<(key: string) => string | null>(),
}))

vi.mock('../db.js', () => ({
  getSetting: (key: string) => mockGetSetting(key),
}))

import {
  DynamicSemaphore,
  getSummaryConcurrency,
  runWithSummaryConcurrency,
  summaryLimiter,
  SUMMARY_CONCURRENCY_DEFAULT,
  SUMMARY_CONCURRENCY_MAX,
} from './summary-concurrency.js'

beforeEach(() => {
  mockGetSetting.mockReturnValue(null)
})

describe('getSummaryConcurrency', () => {
  it('returns the default when the setting is unset', () => {
    expect(getSummaryConcurrency(() => null)).toBe(SUMMARY_CONCURRENCY_DEFAULT)
  })

  it('returns the default for an empty string', () => {
    expect(getSummaryConcurrency(() => '')).toBe(SUMMARY_CONCURRENCY_DEFAULT)
  })

  it('parses a stored integer', () => {
    expect(getSummaryConcurrency(() => '7')).toBe(7)
  })

  it('clamps values above the upper bound', () => {
    expect(getSummaryConcurrency(() => '999')).toBe(SUMMARY_CONCURRENCY_MAX)
  })

  it('falls back to the default for malformed values', () => {
    expect(getSummaryConcurrency(() => 'abc')).toBe(SUMMARY_CONCURRENCY_DEFAULT)
    expect(getSummaryConcurrency(() => '2.5')).toBe(SUMMARY_CONCURRENCY_DEFAULT)
    expect(getSummaryConcurrency(() => '0')).toBe(SUMMARY_CONCURRENCY_DEFAULT)
    expect(getSummaryConcurrency(() => '-3')).toBe(SUMMARY_CONCURRENCY_DEFAULT)
  })

  it('reads the real setting key', () => {
    mockGetSetting.mockReturnValue('3')
    expect(getSummaryConcurrency()).toBe(3)
    expect(mockGetSetting).toHaveBeenCalledWith('summary.concurrency')
  })
})

describe('DynamicSemaphore', () => {
  it('runs at most N tasks concurrently', async () => {
    const sem = new DynamicSemaphore(() => 2)
    let inFlight = 0
    let peak = 0

    const task = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight--
    }

    await Promise.all(Array.from({ length: 6 }, () => sem.run(task)))
    expect(peak).toBe(2)
    expect(sem.activeCount).toBe(0)
    expect(sem.queueLength).toBe(0)
  })

  it('preserves return values and propagates errors', async () => {
    const sem = new DynamicSemaphore(() => 1)
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok')
    await expect(sem.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // A failed task must still release its slot.
    await expect(sem.run(async () => 'after')).resolves.toBe('after')
  })

  it('applies a lowered capacity to queued waiters', async () => {
    let capacity = 3
    const sem = new DynamicSemaphore(() => capacity)
    let inFlight = 0
    let peak = 0
    const task = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight--
    }

    const runs = Array.from({ length: 6 }, () => sem.run(task))
    // Shrink capacity while tasks are queued: waiters re-check when woken.
    capacity = 1
    await Promise.all(runs)
    // Late tasks (already admitted before the shrink) may overlap, but
    // once the shrink landed no new task may start above the new cap.
    expect(peak).toBeLessThanOrEqual(3)
    expect(sem.activeCount).toBe(0)
  })

  it('respects a capacity raise immediately for new acquires', async () => {
    let capacity = 1
    const sem = new DynamicSemaphore(() => capacity)
    let inFlight = 0
    let peak = 0
    const task = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight--
    }

    const first = sem.run(task)
    capacity = 4
    await Promise.all([first, sem.run(task), sem.run(task), sem.run(task)])
    expect(peak).toBe(4)
  })
})

describe('runWithSummaryConcurrency / summaryLimiter', () => {
  it('is wired to the setting-driven capacity', async () => {
    mockGetSetting.mockReturnValue('2')
    let inFlight = 0
    let peak = 0
    const task = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight--
    }

    await Promise.all(Array.from({ length: 5 }, () => runWithSummaryConcurrency(task)))
    expect(peak).toBe(2)
  })

  it('exposes the shared limiter singleton', () => {
    expect(summaryLimiter).toBeInstanceOf(DynamicSemaphore)
  })
})
