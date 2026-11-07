import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

const initial = {
  scope: null,
  messages: [],
  historyState: 'idle',
  historyError: null,
};
function mergeMessages(current, incoming) {
  const accepted = new Set(
    incoming
      .filter((m) => m.status === 'sent')
      .map((m) => `${m.senderId}:${m.requestId}`),
  );
  const rows = new Map(
    current
      .filter(
        (m) =>
          m.status === 'sent' || !accepted.has(`${m.senderId}:${m.requestId}`),
      )
      .map((m) => [m.id, m]),
  );
  for (const message of incoming) rows.set(message.id, message);
  return [...rows.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-300);
}
export const chatStore = createStore((set) => ({
  ...initial,
  activateScope: (scope) =>
    set((s) => (s.scope === scope ? s : { ...initial, scope })),
  reset: () => set({ ...initial }),
  setHistoryState: (historyState, historyError = null) =>
    set({ historyState, historyError }),
  accept: (messages) =>
    set((s) => ({
      messages: mergeMessages(
        s.messages,
        messages.map((m) => ({ ...m, status: 'sent', error: null })),
      ),
    })),
  pending: (message) =>
    set((s) => ({
      messages: mergeMessages(
        s.messages.filter((m) => m.id !== message.id),
        [{ ...message, status: 'pending', error: null }],
      ),
    })),
  fail: (requestId, error) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.requestId === requestId && m.status !== 'sent'
          ? { ...m, status: 'failed', error }
          : m,
      ),
    })),
  failPending: () =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.status === 'pending'
          ? {
              ...m,
              status: 'failed',
              error: 'Connection interrupted. Retry when connected.',
            }
          : m,
      ),
    })),
}));
export const useChat = (selector) => useStore(chatStore, selector);
