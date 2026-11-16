export function createQueue(concurrency, handler, onError = () => {}) {
  const items = [];
  let running = 0;
  let waiters = [];

  const settle = () => {
    if (!items.length && running === 0) {
      waiters.forEach((w) => w());
      waiters = [];
    }
  };
  const pump = () => {
    while (running < concurrency && items.length) {
      const item = items.shift();
      running++;
      Promise.resolve()
        .then(() => handler(item))
        .catch((e) => onError(e, item))
        .finally(() => {
          running--;
          pump();
          settle();
        });
    }
  };
  return {
    push(item) {
      items.push(item);
      pump();
    },
    get size() {
      return items.length + running;
    },
    idle() {
      return items.length || running ? new Promise((r) => waiters.push(r)) : Promise.resolve();
    },
  };
}
