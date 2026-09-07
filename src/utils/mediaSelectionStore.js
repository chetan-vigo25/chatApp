/**
 * Selection state for the media grid, held OUTSIDE React.
 *
 * Why not useState: the grid renders thousands of cells. If the selected set
 * lives in component state, every tap changes `renderItem`'s identity, so
 * VirtualizedList re-runs it for the whole rendered window and React reconciles
 * every visible cell — for one checkbox. Holding it in an external store keeps
 * `renderItem` referentially stable forever; each cell subscribes to *its own*
 * order through useSyncExternalStore, so a tap re-renders exactly the cells
 * whose number changed (the tapped one, plus any that renumber after a
 * deselect) and nothing else.
 *
 * Snapshots are primitives (a number) or arrays replaced only on real change,
 * which is what useSyncExternalStore requires — returning a fresh object each
 * call would loop forever.
 */

/**
 * @param {Object}  [options]
 * @param {number}  [options.limit] max items selectable at once
 * @returns a store: { subscribe, orderOf, getIds, getCount, toggle, clear, isFull }
 */
export function createSelectionStore({ limit = 30 } = {}) {
  /** @type {string[]} replaced (never mutated) so getIds() is a valid snapshot */
  let ids = [];
  /** @type {Map<string, number>} id → 1-based tap position */
  let order = new Map();
  const listeners = new Set();

  const reindex = () => {
    order = new Map();
    for (let i = 0; i < ids.length; i += 1) order.set(ids[i], i + 1);
  };

  const emit = () => {
    // Copy: a listener may unsubscribe during the walk (a cell unmounting as
    // the list recycles), which would otherwise skip the next listener.
    for (const listener of Array.from(listeners)) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    /** 0 when unselected, otherwise the 1-based position the user tapped it in. */
    orderOf(id) {
      return order.get(id) || 0;
    },

    getIds() {
      return ids;
    },

    getCount() {
      return ids.length;
    },

    isFull() {
      return ids.length >= limit;
    },

    /** @returns {boolean} false when the tap was rejected (limit reached) */
    toggle(id) {
      if (order.has(id)) {
        ids = ids.filter((existing) => existing !== id);
        reindex();
        emit();
        return true;
      }
      if (ids.length >= limit) return false;
      ids = [...ids, id];
      order.set(id, ids.length);
      emit();
      return true;
    },

    clear() {
      if (ids.length === 0) return;
      ids = [];
      order = new Map();
      emit();
    },
  };
}
