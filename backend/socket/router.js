import { EVENTS } from '../../shared/events.js';

/**
 * Event routing only. Each handler validates input, calls repos, and emits.
 * @param {import('socket.io').Server} io
 * @param {ReturnType<typeof import('../../database/repositories.js').createRepositories>} repos
 */
export function registerSocketRouter(io, repos) {
  io.on('connection', (socket) => {
    socket.on(EVENTS.SESSION_JOIN, () => {
      const map = repos.maps.first();
      socket.emit(EVENTS.SESSION_STATE, {
        map: map && { id: map.id, name: map.name, gridSize: map.grid_size, width: map.width, height: map.height },
        tokens: map ? repos.tokens.listByMap(map.id) : [],
      });
    });

    socket.on(EVENTS.TOKEN_MOVE, ({ id, x, y } = {}) => {
      if (typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (repos.tokens.move(id, x, y)) {
        socket.broadcast.emit(EVENTS.TOKEN_MOVED, { id, x, y });
      }
    });
  });
}
