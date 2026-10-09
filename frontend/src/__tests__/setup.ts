import { vi, beforeEach, afterEach } from 'vitest'
import { setClusterProgramWorkerFactory } from '@/services/clusterProgramRunner'
import { InlineClusterProgramWorker } from './fixtures/inlineClusterProgramWorker'

// Mock localStorage for consistent test behavior
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get length() { return Object.keys(store).length },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

// Reset localStorage between tests
beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Cluster programs run in a module worker in the app; happy-dom has none, so
// every test gets an in-process stand-in (tests may swap it per case).
beforeEach(() => {
  setClusterProgramWorkerFactory(() => new InlineClusterProgramWorker() as unknown as Worker)
})
