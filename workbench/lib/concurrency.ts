// Tiny dependency-free concurrent map. We use it to fan out classification
// of incremental files: each file does one parse + (maybe) one AI call,
// and AI calls are network-bound so we can run several in parallel.

export async function pMap<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) break;
        results[idx] = await fn(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
