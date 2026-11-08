/**
 * Bridge between the autosave engine and Socket.IO.
 *
 * `src/net/socket.js` installs the live handler; the engine never imports the
 * socket module directly, which keeps the module graph acyclic and lets tests
 * run the engine with a fake transport.
 */
let handler = null;

export function setAutosaveTransport(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

export function sendAutosave(payload) {
  if (!handler) return Promise.resolve({ ok: false, reason: 'offline' });
  try {
    return Promise.resolve(handler(payload));
  } catch (error) {
    return Promise.resolve({
      ok: false,
      reason: 'offline',
      error: error?.message ?? 'transport failed',
    });
  }
}
