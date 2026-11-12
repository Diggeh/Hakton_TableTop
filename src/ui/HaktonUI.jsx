import { useEffect, useState } from 'react';
import { decodeRoomCode } from '../../shared/roomCode.js';
import { campaigns as initialCampaigns } from './fixtures.js';
import { IconButton, Mark, Modal } from './Primitives.jsx';
import ToolIcon from './ToolIcon.jsx';
import Tabletop from './Tabletop.jsx';
import RecoveryBanner from './RecoveryBanner.jsx';
import './hakton.css';
import './prototype.css';

const LOCAL_USERS_KEY = 'hakton:local-users:v1';
const LOCAL_ACTIVE_USER_KEY = 'hakton:active-user-id:v1';

function readLocalUsers() {
  try {
    const raw = localStorage.getItem(LOCAL_USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocalUsers(users) {
  try {
    localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
  } catch {
    // Ignore storage quota errors in restricted environments
  }
}

async function getInitialAccountState() {
  if (typeof window !== 'undefined' && window.hakton?.user?.getCurrent) {
    try {
      const res = await window.hakton.user.getCurrent();
      if (res?.ok) {
        return {
          hasAccount: Boolean(res.hasAccount),
          user: res.user || null,
        };
      }
    } catch {
      // Fallback to local storage below
    }
  }
  const users = readLocalUsers();
  const activeId = localStorage.getItem(LOCAL_ACTIVE_USER_KEY);
  const activeUser =
    users.find((u) => u.id === activeId) || users[0] || null;
  return {
    hasAccount: users.length > 0,
    user: activeUser
      ? { id: activeUser.id, username: activeUser.username }
      : null,
  };
}

async function registerUserAccount({ username, password }) {
  if (typeof window !== 'undefined' && window.hakton?.user?.create) {
    return window.hakton.user.create({ username, password });
  }
  const cleanName = String(username || '').trim();
  if (!cleanName) return { ok: false, error: 'Account name is required.' };
  if (!password || password.length < 4) {
    return { ok: false, error: 'Password must be at least 4 characters.' };
  }
  const users = readLocalUsers();
  if (users.some((u) => u.username.toLowerCase() === cleanName.toLowerCase())) {
    return { ok: false, error: `Account "${cleanName}" already exists.` };
  }
  const newUser = {
    id: `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    username: cleanName,
    password,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  writeLocalUsers(users);
  localStorage.setItem(LOCAL_ACTIVE_USER_KEY, newUser.id);
  return {
    ok: true,
    user: { id: newUser.id, username: newUser.username },
  };
}

async function loginUserAccount({ username, password }) {
  if (typeof window !== 'undefined' && window.hakton?.user?.login) {
    return window.hakton.user.login({ username, password });
  }
  const cleanName = String(username || '').trim();
  const users = readLocalUsers();
  const found = users.find(
    (u) =>
      u.username.toLowerCase() === cleanName.toLowerCase() &&
      u.password === password,
  );
  if (!found) {
    return { ok: false, error: 'Invalid account name or password.' };
  }
  localStorage.setItem(LOCAL_ACTIVE_USER_KEY, found.id);
  return {
    ok: true,
    user: { id: found.id, username: found.username },
  };
}

function previewCodeMode(rawInput) {
  if (!rawInput || !rawInput.trim()) return null;
  try {
    const decoded = decodeRoomCode(rawInput);
    return decoded.mode === 'webrtc'
      ? { label: 'Internet (WebRTC P2P)', mode: 'webrtc' }
      : { label: `Local Network (${decoded.ip}:${decoded.port})`, mode: 'lan' };
  } catch {
    return null;
  }
}

export default function HaktonUI() {
  const [screen, setScreen] = useState('loading');
  const [authMode, setAuthMode] = useState('create'); // 'create' | 'login'
  const [accountUser, setAccountUser] = useState(null);
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authError, setAuthError] = useState('');

  const [role, setRole] = useState('DM');
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [selected, setSelected] = useState('salt');
  const [modal, setModal] = useState(null);
  const [name, setName] = useState('Adventurer');

  // Player Room Code join state
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [roomCodeError, setRoomCodeError] = useState('');
  const [joinTarget, setJoinTarget] = useState(null);

  // Campaign editing state
  const [editDraft, setEditDraft] = useState({
    name: '',
    description: '',
    coverPhoto: '',
    sessions: 0,
  });

  useEffect(() => {
    let cancelled = false;
    getInitialAccountState().then(({ hasAccount, user }) => {
      if (cancelled) return;
      if (hasAccount && user) {
        setAccountUser(user);
        setName(user.username);
        setScreen('home');
      } else {
        setAuthMode('create');
        setScreen('account');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const campaign = campaigns.find((c) => c.id === selected) || campaigns[0];
  const activeDisplayName = accountUser?.username || name;
  const codeHint = previewCodeMode(roomCodeInput);

  async function handleAccountSubmit(e) {
    e.preventDefault();
    setAuthError('');

    const trimmedName = authUsername.trim();
    if (!trimmedName) {
      setAuthError('Please enter an account name.');
      return;
    }
    if (authPassword.length < 4) {
      setAuthError('Password must be at least 4 characters.');
      return;
    }
    if (authMode === 'create' && authPassword !== authConfirmPassword) {
      setAuthError('Passwords do not match.');
      return;
    }

    const res =
      authMode === 'create'
        ? await registerUserAccount({
            username: trimmedName,
            password: authPassword,
          })
        : await loginUserAccount({
            username: trimmedName,
            password: authPassword,
          });

    if (!res?.ok || !res.user) {
      setAuthError(res?.error || 'Could not authenticate account.');
      return;
    }

    setAccountUser(res.user);
    setName(res.user.username);
    setAuthPassword('');
    setAuthConfirmPassword('');
    setScreen('home');
  }

  function handleJoinByCode(e) {
    e.preventDefault();
    setRoomCodeError('');
    try {
      const decoded = decodeRoomCode(roomCodeInput);
      setJoinTarget(decoded);
      setRole('Player');
      setScreen('table');
    } catch (err) {
      setRoomCodeError(err.message || 'Enter a valid room code.');
    }
  }

  if (screen === 'loading') {
    return (
      <div className="hakton-app screen-home">
        <RecoveryBanner />
      </div>
    );
  }

  return (
    <div className={`hakton-app screen-${screen}`}>
      <RecoveryBanner />
      {screen === 'table' ? (
        <Tabletop
          campaign={
            role === 'Player'
              ? {
                  id: joinTarget?.code || 'joined-session',
                  name: `Session ${joinTarget?.code || ''}`.trim(),
                  scene: 'Drowned Sanctuary',
                  hostUrl: joinTarget?.hostUrl,
                }
              : campaign
          }
          role={role}
          name={activeDisplayName}
          userId={accountUser?.id}
          hostUrl={role === 'Player' ? joinTarget?.hostUrl : undefined}
          onLeave={() =>
            setScreen(role === 'Player' ? 'join-code' : 'campaigns')
          }
        />
      ) : screen === 'account' ? (
        <main className="account-screen" aria-label="Account setup">
          <div className="account-card">
            <div className="account-brand">
              <Mark />
              <span>HAKTON</span>
            </div>
            <h1>
              {authMode === 'create'
                ? 'Create Your Account'
                : 'Sign In to Hakton'}
            </h1>
            <p className="account-subtitle">
              {authMode === 'create'
                ? 'Set up your account on this device. Your account links your characters, inventory, chat messages, and logs across campaigns.'
                : 'Sign in with your account name and password.'}
            </p>
            <form className="account-form" onSubmit={handleAccountSubmit}>
              <label>
                Account name
                <input
                  name="username"
                  required
                  maxLength={40}
                  placeholder="Enter your adventurer or DM name"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  autoFocus
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  required
                  minLength={4}
                  placeholder="At least 4 characters"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </label>
              {authMode === 'create' && (
                <label>
                  Confirm password
                  <input
                    name="confirmPassword"
                    type="password"
                    required
                    minLength={4}
                    placeholder="Re-enter your password"
                    value={authConfirmPassword}
                    onChange={(e) => setAuthConfirmPassword(e.target.value)}
                  />
                </label>
              )}
              {authError && (
                <p className="account-error" role="alert">
                  {authError}
                </p>
              )}
              <button type="submit" className="primary account-submit">
                {authMode === 'create' ? 'Create Account →' : 'Sign In →'}
              </button>
            </form>
            <div className="account-footer">
              {authMode === 'create' ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setAuthError('');
                    setAuthMode('login');
                  }}
                >
                  Already have an account on this device? Sign in
                </button>
              ) : (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setAuthError('');
                    setAuthMode('create');
                  }}
                >
                  Need a new account? Create one
                </button>
              )}
            </div>
          </div>
        </main>
      ) : (
        <>
          <header className="app-header">
            <button className="brand" onClick={() => setScreen('home')}>
              <Mark />
              <span>HAKTON</span>
            </button>
            <button className="profile" onClick={() => setModal('profile')}>
              <span className="avatar">
                {activeDisplayName.slice(0, 2).toUpperCase()}
              </span>
              {activeDisplayName}
            </button>
          </header>

          {screen === 'home' ? (
            <main className="start-screen">
              <h1>
                <Mark />
                <span>Hakton</span>
              </h1>
              <nav className="start-actions" aria-label="Start menu">
                <button
                  className="primary"
                  onClick={() => {
                    setRole('DM');
                    setScreen('campaigns');
                  }}
                >
                  Host a session <span>→</span>
                </button>
                <button
                  onClick={() => {
                    setRole('Player');
                    setRoomCodeError('');
                    setScreen('join-code');
                  }}
                >
                  Join with Code <span>→</span>
                </button>
                {window.hakton?.quit && (
                  <button
                    className="quiet"
                    onClick={() => window.hakton.quit()}
                  >
                    Exit program
                  </button>
                )}
              </nav>
            </main>
          ) : screen === 'join-code' ? (
            <main className="join-code-screen" aria-label="Join with room code">
              <div className="page-top">
                <button
                  className="text-button"
                  onClick={() => setScreen('home')}
                >
                  ← Start menu
                </button>
              </div>
              <div className="join-code-card">
                <div className="join-code-header">
                  <span className="join-code-badge">PLAYER JOIN</span>
                  <h1>Enter Room Code</h1>
                  <p>
                    Enter the code displayed on your Dungeon Master’s screen to
                    join via Local Wi-Fi (LAN) or over the Internet (WebRTC).
                  </p>
                </div>
                <form className="join-code-form" onSubmit={handleJoinByCode}>
                  <label className="join-code-field">
                    <span>ROOM CODE</span>
                    <input
                      className="room-code-input"
                      aria-label="Room code"
                      placeholder="7H9K-42M1 or NET-8Y2P"
                      maxLength={64}
                      value={roomCodeInput}
                      onChange={(e) => {
                        setRoomCodeInput(e.target.value.toUpperCase());
                        setRoomCodeError('');
                      }}
                      autoFocus
                    />
                  </label>
                  {codeHint && (
                    <div
                      className={`join-code-mode is-${codeHint.mode}`}
                      aria-live="polite"
                    >
                      Mode detected: <strong>{codeHint.label}</strong>
                    </div>
                  )}
                  {roomCodeError && (
                    <p className="account-error" role="alert">
                      {roomCodeError}
                    </p>
                  )}
                  <button
                    type="submit"
                    className="primary join-code-submit"
                    disabled={!roomCodeInput.trim()}
                  >
                    Join Game →
                  </button>
                </form>
              </div>
            </main>
          ) : (
            <main className="campaign-screen">
              <div className="page-top">
                <button
                  className="text-button"
                  onClick={() => setScreen('home')}
                >
                  ← Start menu
                </button>
              </div>
              <div className="page-title">
                <h1>Host a Campaign</h1>
              </div>
              <div className="campaign-layout">
                <section className="campaign-list" aria-label="Campaign list">
                  {campaigns.map((c) => (
                    <button
                      key={c.id}
                      className={`campaign-row ${selected === c.id ? 'selected' : ''}`}
                      onClick={() => {
                        setSelected(c.id);
                        setModal('campaign');
                      }}
                    >
                      <span className="campaign-monogram">
                        {c.name
                          .split(' ')
                          .filter((w) => w !== 'The')
                          .slice(0, 2)
                          .map((w) => w[0])
                          .join('')}
                      </span>
                      <span>
                        <strong>{c.name}</strong>
                        <small>
                          {c.system} · {c.sessions} sessions
                        </small>
                      </span>
                      <span>›</span>
                    </button>
                  ))}
                  <button
                    className="add-campaign"
                    onClick={() => setModal('add')}
                  >
                    + Add campaign
                  </button>
                </section>
                {!campaigns.length && (
                  <p className="empty-inline">No campaigns</p>
                )}
              </div>
            </main>
          )}
        </>
      )}
      {modal && (
        <Modal
          title={
            {
              campaign: campaign?.name,
              'edit-campaign': 'Edit Campaign Details',
              profile: 'Account Profile',
              add: 'New campaign',
              delete: 'Delete campaign?',
            }[modal]
          }
          onClose={() => setModal(null)}
        >
          {modal === 'campaign' && campaign && (
            <div className="campaign-info">
              <div
                className="campaign-cover"
                style={
                  campaign.coverPhoto
                    ? {
                        backgroundImage: `url(${campaign.coverPhoto})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }
                    : undefined
                }
              >
                <span>{campaign.scene}</span>
                {!campaign.coverPhoto && <Mark />}
                <IconButton
                  className="icon-button campaign-edit-button"
                  label="Edit campaign details"
                  title="Edit campaign details"
                  onClick={() => {
                    setEditDraft({
                      name: campaign.name || '',
                      description: campaign.description || '',
                      coverPhoto: campaign.coverPhoto || '',
                      sessions: Number(campaign.sessions) || 0,
                    });
                    setModal('edit-campaign');
                  }}
                >
                  <ToolIcon name="draw" />
                </IconButton>
              </div>
              <div className="campaign-info-body">
                <div className="campaign-info-header-row">
                  <p className="chapter">{campaign.chapter}</p>
                </div>
                <p>{campaign.description}</p>
                <div className="campaign-info-meta">
                  {campaign.system} · {campaign.sessions} sessions
                </div>
                <div className="detail-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      setRole('DM');
                      setModal(null);
                      setScreen('table');
                    }}
                  >
                    Start campaign
                  </button>
                  <button onClick={() => setModal('delete')}>
                    Delete campaign
                  </button>
                </div>
              </div>
            </div>
          )}
          {modal === 'edit-campaign' && campaign && (
            <form
              className="campaign-edit-form"
              onSubmit={(e) => {
                e.preventDefault();
                const cleanName = editDraft.name.trim();
                if (!cleanName) return;
                setCampaigns((prev) =>
                  prev.map((c) =>
                    c.id === campaign.id
                      ? {
                          ...c,
                          name: cleanName,
                          description: editDraft.description,
                          coverPhoto: editDraft.coverPhoto,
                          sessions: Math.max(0, Number(editDraft.sessions) || 0),
                        }
                      : c,
                  ),
                );
                setModal('campaign');
              }}
            >
              <label>
                Campaign name
                <input
                  required
                  maxLength={60}
                  value={editDraft.name}
                  onChange={(e) =>
                    setEditDraft((d) => ({ ...d, name: e.target.value }))
                  }
                  autoFocus
                />
              </label>
              <label>
                Description
                <textarea
                  rows={3}
                  maxLength={400}
                  value={editDraft.description}
                  onChange={(e) =>
                    setEditDraft((d) => ({ ...d, description: e.target.value }))
                  }
                />
              </label>
              <label>
                Cover photo
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      if (typeof reader.result === 'string') {
                        setEditDraft((d) => ({
                          ...d,
                          coverPhoto: reader.result,
                        }));
                      }
                    };
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
              <div className="session-stepper-field">
                <span>Sessions held</span>
                <div className="session-stepper" role="group" aria-label="Session count">
                  <button
                    type="button"
                    aria-label="Decrease sessions"
                    onClick={() =>
                      setEditDraft((d) => ({
                        ...d,
                        sessions: Math.max(0, (Number(d.sessions) || 0) - 1),
                      }))
                    }
                  >
                    −
                  </button>
                  <output aria-live="polite">{editDraft.sessions}</output>
                  <button
                    type="button"
                    aria-label="Increase sessions"
                    onClick={() =>
                      setEditDraft((d) => ({
                        ...d,
                        sessions: (Number(d.sessions) || 0) + 1,
                      }))
                    }
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  onClick={() => setModal('campaign')}
                >
                  Cancel
                </button>
                <button type="submit" className="primary">
                  Save changes
                </button>
              </div>
            </form>
          )}
          {modal === 'profile' && (
            <div className="profile-modal-body">
              <dl>
                <div>
                  <dt>Account Name</dt>
                  <dd>{activeDisplayName}</dd>
                </div>
                {accountUser?.id && (
                  <div>
                    <dt>Account ID</dt>
                    <dd>{accountUser.id}</dd>
                  </div>
                )}
              </dl>
              <div className="form-actions">
                <button
                  type="button"
                  onClick={() => {
                    setModal(null);
                    setAuthUsername('');
                    setAuthPassword('');
                    setAuthConfirmPassword('');
                    setAuthError('');
                    setAuthMode('login');
                    setScreen('account');
                  }}
                >
                  Switch Account
                </button>
                <button className="primary" onClick={() => setModal(null)}>
                  Done
                </button>
              </div>
            </div>
          )}
          {modal === 'add' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const id = crypto.randomUUID();
                setCampaigns([
                  ...campaigns,
                  {
                    id,
                    name: data.get('name').trim(),
                    description: '',
                    system: data.get('system'),
                    chapter: 'Chapter I',
                    scene: 'Untitled scene',
                    sessions: 0,
                  },
                ]);
                setSelected(id);
                setModal(null);
              }}
            >
              <label>
                Campaign name
                <input
                  name="name"
                  required
                  maxLength={60}
                  pattern=".*\S.*"
                  autoFocus
                />
              </label>
              <label>
                Ruleset
                <select name="system">
                  <option>D&D 5e</option>
                  <option>D&D 5.5e</option>
                </select>
              </label>
              <div className="form-actions">
                <button type="button" onClick={() => setModal(null)}>
                  Cancel
                </button>
                <button className="primary">Add campaign</button>
              </div>
            </form>
          )}
          {modal === 'delete' && (
            <>
              <p>Remove “{campaign?.name}” from your campaigns?</p>
              <div className="form-actions">
                <button onClick={() => setModal(null)}>Cancel</button>
                <button
                  className="danger"
                  onClick={() => {
                    setCampaigns(campaigns.filter((c) => c.id !== selected));
                    setSelected(campaigns.find((c) => c.id !== selected)?.id);
                    setModal(null);
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
