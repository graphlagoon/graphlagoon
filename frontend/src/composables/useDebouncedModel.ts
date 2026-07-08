import { ref, watch, onUnmounted, getCurrentInstance, type Ref } from 'vue';

/**
 * Two-way bridge between a text input and a *slow* reactive target — e.g. a
 * PrimeVue global-filter value where every write triggers a full-table
 * re-filter (an O(n) pass per keystroke, which janks on 200k+ rows).
 *
 * The returned ref updates instantly so typing stays responsive; writes to the
 * target are debounced. External changes to the target (tab switch, "Clear"
 * button) flow back into the input immediately, without waiting on the timer
 * and without re-triggering a write.
 *
 * @param read   getter for the current target value
 * @param write  setter that applies a value to the (slow) target
 * @param delay  debounce window in ms
 */
export function useDebouncedModel(
  read: () => string | null,
  write: (v: string | null) => void,
  delay = 300,
): Ref<string | null> {
  const local = ref<string | null>(read());
  let timer: ReturnType<typeof setTimeout> | null = null;

  // input → target (debounced)
  watch(local, v => {
    // Value already matches the target — nothing to write. This also stops the
    // back-sync below (which sets `local` from the target) from scheduling a
    // pointless write of the value it just pulled in.
    if (v === read()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; write(v); }, delay);
  });

  // target → input (immediate; cancels a pending write so the two can't fight)
  watch(read, v => {
    if (v !== local.value) {
      if (timer) { clearTimeout(timer); timer = null; }
      local.value = v;
    }
  });

  if (getCurrentInstance()) onUnmounted(() => { if (timer) clearTimeout(timer); });

  return local;
}
