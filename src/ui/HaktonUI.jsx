import { useState } from 'react';
import { campaigns as initialCampaigns } from './fixtures.js';
import { Mark, Modal } from './Primitives.jsx';
import Tabletop from './Tabletop.jsx';
import RecoveryBanner from './RecoveryBanner.jsx';
import './hakton.css';
import './prototype.css';
export default function HaktonUI() {
  const [screen, setScreen] = useState('home');
  const [role, setRole] = useState('DM');
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [selected, setSelected] = useState('salt');
  const [modal, setModal] = useState(null);
  const [name, setName] = useState('Josh');
  const campaign = campaigns.find((c) => c.id === selected);
  function browse(nextRole) {
    setRole(nextRole);
    setScreen('campaigns');
  }
  return (
    <div className={`hakton-app screen-${screen}`}>
      <RecoveryBanner />
      {screen === 'table' ? (
        <Tabletop
          campaign={campaign}
          role={role}
          name={name}
          onLeave={() => setScreen('campaigns')}
        />
      ) : (
        <>
          <header className="app-header">
            <button className="brand" onClick={() => setScreen('home')}>
              <Mark />
              <span>HAKTON</span>
            </button>
            <button className="profile" onClick={() => setModal('profile')}>
              <span className="avatar">{name.slice(0, 2).toUpperCase()}</span>
              {name}
            </button>
          </header>
          {screen === 'home' ? (
            <main className="start-screen">
              <h1>
                <Mark />
                <span>Hakton</span>
              </h1>
              <nav className="start-actions" aria-label="Start menu">
                <button className="primary" onClick={() => browse('DM')}>
                  Host a session <span>→</span>
                </button>
                <button onClick={() => browse('Player')}>
                  Join a session <span>→</span>
                </button>
                <button className="quiet" onClick={() => setModal('exit')}>
                  Exit program
                </button>
              </nav>
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
                <span className="preview-label">Preview · Not saved</span>
              </div>
              <div className="page-title">
                <h1>Campaigns</h1>
                <div className="segmented" aria-label="Campaign role">
                  {['DM', 'Player'].map((r) => (
                    <button
                      key={r}
                      aria-pressed={role === r}
                      onClick={() => setRole(r)}
                    >
                      {r === 'DM' ? 'Dungeon Master' : 'Player'}
                    </button>
                  ))}
                </div>
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
              profile: 'Your profile',
              add: role === 'DM' ? 'New campaign' : 'Add a campaign',
              delete: role === 'DM' ? 'Delete campaign?' : 'Leave campaign?',
              exit: 'Exit Hakton?',
            }[modal]
          }
          onClose={() => setModal(null)}
        >
          {modal === 'campaign' && campaign && (
            <div className="campaign-info">
              <div className="campaign-cover">
                <span>{campaign.scene}</span>
                <Mark />
              </div>
              <div className="campaign-info-body">
                <p className="chapter">{campaign.chapter}</p>
                <p>{campaign.description}</p>
                <div className="campaign-info-meta">
                  {campaign.system} · {campaign.sessions} sessions
                </div>
                <div className="detail-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      setModal(null);
                      setScreen('table');
                    }}
                  >
                    {role === 'DM' ? 'Start campaign' : 'Join campaign'}
                  </button>
                  <button onClick={() => setModal('delete')}>
                    {role === 'DM' ? 'Delete campaign' : 'Leave campaign'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {modal === 'profile' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setModal(null);
              }}
            >
              <label>
                Display name
                <input
                  required
                  maxLength={30}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="form-actions">
                <button className="primary">Done</button>
              </div>
            </form>
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
              <p className="notice">Preview campaign · Not saved</p>
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
              {role === 'Player' && (
                <label>
                  Host address
                  <input
                    placeholder="Unavailable"
                    title="Remote joining is unavailable"
                    disabled
                  />
                </label>
              )}
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
              <p>
                {role === 'DM' ? 'Remove' : 'Leave'} “{campaign?.name}” from
                this preview?
              </p>
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
                  {role === 'DM' ? 'Delete' : 'Leave'}
                </button>
              </div>
            </>
          )}
          {modal === 'exit' && (
            <>
              <p>Close the Hakton window to exit the application.</p>
              <div className="form-actions">
                <button className="primary" onClick={() => setModal(null)}>
                  Return to Hakton
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
