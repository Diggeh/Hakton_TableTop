import crypto from 'node:crypto';

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64);
}

/**
 * User account repository backed by SQLite.
 * Passwords are salted and hashed using Node's built-in crypto.scryptSync.
 */
export function createUserModel(db) {
  const insertStmt = db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, last_login_at)
    VALUES (@id, @username, @passwordHash, @salt, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `);
  const byIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const byUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
  const firstStmt = db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1');
  const allStmt = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
  const countStmt = db.prepare('SELECT COUNT(*) AS total FROM users');
  const touchLoginStmt = db.prepare(`
    UPDATE users
    SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `);

  return {
    count() {
      const row = countStmt.get();
      return row?.total ?? 0;
    },

    hasAny() {
      return this.count() > 0;
    },

    first() {
      return sanitizeUser(firstStmt.get());
    },

    get(id) {
      if (!id) return null;
      return sanitizeUser(byIdStmt.get(String(id)));
    },

    getByUsername(username) {
      if (!username) return null;
      return sanitizeUser(byUsernameStmt.get(String(username).trim()));
    },

    list() {
      return allStmt.all().map(sanitizeUser);
    },

    create({ id, username, password } = {}) {
      const cleanName = typeof username === 'string' ? username.trim() : '';
      if (!cleanName) {
        throw new Error('Username is required.');
      }
      if (cleanName.length > 40) {
        throw new Error('Username must be 40 characters or fewer.');
      }
      if (typeof password !== 'string' || password.length < 4) {
        throw new Error('Password must be at least 4 characters.');
      }

      const existing = byUsernameStmt.get(cleanName);
      if (existing) {
        throw new Error(`Account "${cleanName}" already exists.`);
      }

      const userId =
        typeof id === 'string' && id.trim()
          ? id.trim()
          : `u_${crypto.randomBytes(6).toString('hex')}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(password, salt).toString('hex');

      insertStmt.run({
        id: userId,
        username: cleanName,
        passwordHash,
        salt,
      });

      return sanitizeUser(byIdStmt.get(userId));
    },

    authenticate(usernameOrObj, maybePassword) {
      const username =
        typeof usernameOrObj === 'object' && usernameOrObj !== null
          ? usernameOrObj.username
          : usernameOrObj;
      const password =
        typeof usernameOrObj === 'object' && usernameOrObj !== null
          ? usernameOrObj.password
          : maybePassword;

      const cleanName = typeof username === 'string' ? username.trim() : '';
      if (!cleanName || typeof password !== 'string' || !password) {
        return null;
      }

      const row = byUsernameStmt.get(cleanName);
      if (!row) return null;

      try {
        const expected = Buffer.from(row.password_hash, 'hex');
        const actual = hashPassword(password, row.salt);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
          return null;
        }
      } catch {
        return null;
      }

      touchLoginStmt.run(row.id);
      return sanitizeUser(byIdStmt.get(row.id));
    },
  };
}
