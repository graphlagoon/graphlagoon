/**
 * Scope hardening for the custom-metric worker.
 *
 * Pure (takes the scope and prototypes as arguments) so it is unit-testable
 * in Node. The worker calls it as its first statement, after capturing its
 * own `postMessage` binding.
 *
 * Threat model: the code is authored by a user with WRITE access to the
 * context and only ever runs for users with write access (the backend hides
 * definitions from readers). The sandbox therefore guards against a writer
 * who is careless or hostile towards other writers/superusers: no network,
 * no storage, no nested workers, no way to forge protocol messages, and a
 * hard timeout enforced from the main thread via `terminate()`.
 *
 * Deliberately kept: `Function`/`eval` (the scope is already stripped, and
 * `new Function` is how the worker itself compiles the code), `console`
 * (useful with the Test button), `setTimeout` (cannot outlive terminate()),
 * `Math`/`Date`/`JSON`/`RegExp`/`Intl`, `WebAssembly` (no I/O) and
 * `Atomics`/`SharedArrayBuffer` (unavailable without COOP/COEP anyway).
 *
 * Residual risk: CPU and memory inside the worker until the timeout fires.
 */

export const STRIPPED_GLOBALS = [
  // network
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  // nested execution contexts (a fresh scope would have fetch again)
  'Worker',
  'SharedWorker',
  // cross-context messaging / protocol forgery
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
  'postMessage',
  'close',
  // storage
  'indexedDB',
  'caches',
  // identity / device / misc I/O
  'navigator',
  'createImageBitmap',
  'FileReaderSync',
  'FileSystemHandle',
  'showOpenFilePicker',
  'scheduler',
  'reportError',
] as const;

export type StrippedGlobal = (typeof STRIPPED_GLOBALS)[number];

function stripFrom(target: object, name: string): boolean {
  try {
    delete (target as Record<string, unknown>)[name];
  } catch {
    /* non-configurable — fall through to the override below */
  }
  if (!(name in target)) return true;
  try {
    Object.defineProperty(target, name, {
      value: undefined,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    return false;
  }
  try {
    return (target as Record<string, unknown>)[name] === undefined;
  } catch {
    return false;
  }
}

/**
 * Remove every STRIPPED_GLOBALS name from `scope` and from each prototype
 * (WorkerGlobalScope.prototype, DedicatedWorkerGlobalScope.prototype, …).
 * Returns the names that could not be removed (empty in Chromium/Firefox).
 */
export function hardenScope(scope: object, protos: readonly object[] = []): string[] {
  const failed: string[] = [];
  const targets: object[] = [scope];
  for (const p of protos) if (p && !targets.includes(p)) targets.push(p);
  // Walk the whole prototype chain of the scope too, in case a host puts a
  // global somewhere we did not list.
  let proto = Object.getPrototypeOf(scope);
  while (proto && proto !== Object.prototype) {
    if (!targets.includes(proto)) targets.push(proto);
    proto = Object.getPrototypeOf(proto);
  }
  for (const name of STRIPPED_GLOBALS) {
    let ok = true;
    for (const t of targets) {
      if (name in t && !stripFrom(t, name)) ok = false;
    }
    // After stripping every holder, the name must no longer resolve.
    let stillThere = false;
    try {
      stillThere = (scope as Record<string, unknown>)[name] !== undefined;
    } catch {
      stillThere = false;
    }
    if (!ok || stillThere) failed.push(name);
  }
  return failed;
}
