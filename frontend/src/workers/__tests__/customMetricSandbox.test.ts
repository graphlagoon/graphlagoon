import { describe, it, expect } from 'vitest';
import { hardenScope, STRIPPED_GLOBALS } from '@/workers/customMetricSandbox';

/** A stand-in for DedicatedWorkerGlobalScope: scope → DWGS.prototype → WGS.prototype. */
function makeFakeWorkerRealm() {
  const workerProto: Record<string, unknown> = {
    fetch: () => 'net',
    importScripts: () => 'import',
    caches: {},
    indexedDB: {},
    navigator: { sendBeacon: () => true },
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    Worker: class {},
    SharedWorker: class {},
    BroadcastChannel: class {},
    MessageChannel: class {},
    MessagePort: class {},
    createImageBitmap: () => 0,
    FileReaderSync: class {},
    reportError: () => 0,
    scheduler: {},
  };
  const dedicatedProto: Record<string, unknown> = Object.create(workerProto);
  dedicatedProto.postMessage = () => 'sent';
  dedicatedProto.close = () => 'closed';
  const scope: Record<string, unknown> = Object.create(dedicatedProto);
  // Some hosts also put a few directly on the scope object.
  scope.fetch = () => 'net-own';
  scope.console = console;
  scope.Math = Math;
  scope.setTimeout = setTimeout;
  return { scope, dedicatedProto, workerProto };
}

describe('hardenScope', () => {
  it('strips every listed global from the scope and its prototype chain', () => {
    const { scope, dedicatedProto, workerProto } = makeFakeWorkerRealm();
    const failed = hardenScope(scope, [dedicatedProto, workerProto]);
    expect(failed).toEqual([]);
    for (const name of STRIPPED_GLOBALS) {
      expect(scope[name], name).toBeUndefined();
    }
    // Specifically the ones a hostile definition would reach for:
    expect(scope.fetch).toBeUndefined();
    expect(scope.importScripts).toBeUndefined();
    expect(scope.Worker).toBeUndefined();
    expect(scope.postMessage).toBeUndefined();
    expect(scope.indexedDB).toBeUndefined();
    expect(scope.navigator).toBeUndefined();
  });

  it('walks the prototype chain even when the prototypes are not listed', () => {
    const { scope } = makeFakeWorkerRealm();
    expect(hardenScope(scope)).toEqual([]);
    expect(scope.fetch).toBeUndefined();
    expect(scope.postMessage).toBeUndefined();
  });

  it('a binding captured BEFORE hardening keeps working (the worker\'s own postMessage)', () => {
    const { scope, dedicatedProto, workerProto } = makeFakeWorkerRealm();
    const post = (scope.postMessage as () => string).bind(scope);
    hardenScope(scope, [dedicatedProto, workerProto]);
    expect(post()).toBe('sent');
    expect(scope.postMessage).toBeUndefined();
  });

  it('leaves the allowed globals in place', () => {
    const { scope } = makeFakeWorkerRealm();
    hardenScope(scope);
    expect(scope.console).toBe(console);
    expect(scope.Math).toBe(Math);
    expect(scope.setTimeout).toBe(setTimeout);
  });

  it('overrides a non-configurable global with a locked undefined', () => {
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, 'fetch', { value: () => 1, configurable: false, writable: true });
    // Non-configurable + writable: delete fails, but the value can still be
    // neutralised by writing undefined (defineProperty on a writable prop).
    const failed = hardenScope(scope);
    expect(failed).toEqual([]);
    expect(scope.fetch).toBeUndefined();
    expect(() => {
      scope.fetch = () => 2;
    }).toThrow(); // now read-only
    expect(scope.fetch).toBeUndefined();
  });

  it('reports what it could not strip instead of throwing', () => {
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, 'fetch', { value: () => 1, configurable: false, writable: false });
    const failed = hardenScope(scope);
    expect(failed).toEqual(['fetch']);
  });

  it('user code compiled with new Function cannot see a stripped name through the scope', () => {
    const { scope } = makeFakeWorkerRealm();
    hardenScope(scope);
    // The worker calls user code with `self` = scope; a definition doing
    // `self.fetch(...)` must throw.
    const fn = new Function('self', 'return self.fetch("https://example.com")');
    expect(() => fn(scope)).toThrow(TypeError);
  });
});
