/**
 * Wrap a dynamic import so a failed chunk fetch (typically because the
 * user opened the app before a redeploy and the old hashed asset file
 * no longer exists) triggers a one-time hard reload.
 */
export function withReloadOnChunkError<T>(loader: () => Promise<T>): () => Promise<T> {
  const KEY = "chunk_reload_attempted";
  return async () => {
    try {
      const result = await loader();
      if (typeof window !== "undefined") sessionStorage.removeItem(KEY);
      return result;
    } catch (err) {
      const isChunkError =
        err instanceof Error &&
        /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(
          err.message,
        );
      if (isChunkError && typeof window !== "undefined") {
        if (sessionStorage.getItem(KEY) !== "1") {
          sessionStorage.setItem(KEY, "1");
          window.location.reload();
          return new Promise<T>(() => {});
        }
      }
      throw err;
    }
  };
}
