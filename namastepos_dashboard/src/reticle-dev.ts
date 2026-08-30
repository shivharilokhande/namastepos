// Dev-only. Imported automatically by @reticlehq/vite-plugin, so you do not need to import it.
// Self-guards on import.meta.env.DEV, so it is a no-op in a production build.
import { registerCapabilities, registerStore, tanstackQueryStore } from '@reticlehq/react';
import { queryClient } from './main';

if (import.meta.env.DEV) {
  // Expose the TanStack Query cache so Reticle can assert on what the app
  // BELIEVES (server state: orders, customers, session, plans), not just what
  // rendered — the class of bug a screenshot can't see.
  registerStore('queries', tanstackQueryStore(queryClient));
  // ── Start with ONE flow. ─────────────────────────────────────────────────────────────────────
  // You do not need to describe the whole app to get value, and trying to is the slow path. Register
  // the store your most important flow reads, and list the testids that flow touches. Add more later,
  // when a flow you actually replay needs them.
  //
  // Registering a store is the highest-value line in this file: it lets the agent check what the app
  // BELIEVES, not just what it rendered — the class of bug a screenshot cannot see. Pass the STORE,
  // not `() => store.getState()`: the store form wires `subscribe` too, so every mutation emits a
  // state diff; the getter form is read-only and silently produces empty diffs.
  // import your store, then: registerStore('queries', tanstackQueryStore(queryClient))

  registerCapabilities({
    testids: [], // add data-testid to key elements as flows are verified
    signals: [], // names you pass to reticle.signal()
    stores: ['queries'], // registered above
  });
}
