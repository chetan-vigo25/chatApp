// Per-key promise chain (no React Native imports; loadable by node --test).
// P-A-09: two pushes for the SAME chat used to run their AsyncStorage
// read-modify-write concurrently and lose a line. Tasks sharing a key now run
// strictly one after another; different keys stay parallel. A failing task
// never blocks the next one, and the map entry is removed once the chain drains
// so it cannot grow with the number of chats.

const createKeyedSerial = () => {
  const tails = new Map();
  const run = (key, task) => {
    const k = String(key);
    const prev = tails.get(k) || Promise.resolve();
    const result = prev.then(() => task());
    const tail = result.then(() => undefined, () => undefined);
    tails.set(k, tail);
    tail.then(() => { if (tails.get(k) === tail) tails.delete(k); });
    return result;
  };
  run.size = () => tails.size;
  return run;
};

module.exports = { createKeyedSerial };
