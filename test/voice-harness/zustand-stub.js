// The renderer's React binding is irrelevant in the harness (no UI); the vanilla store is all we use.
export const useStore = () => {
  throw new Error('React binding is unavailable in the voice harness.');
};
