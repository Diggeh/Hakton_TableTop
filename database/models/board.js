const parse = (s, fallback = {}) => {
  if (s == null) return fallback;
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return fallback;
  }
};

function hydrate(row) {
  if (!row) return null;
  return {
    campaignId: row.campaign_id,
    campaign_id: row.campaign_id,
    data: parse(row.data),
    revision: row.revision ?? 1,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * Server-generated recovery blueprints, one per campaign.
 *
 * The normalized `maps`/`tokens` tables are authoritative; this document is a
 * denormalized snapshot written by the backend after board mutations. Clients
 * never write it, so token coordinates in the blueprint can always be trusted.
 */
export function createBoardModel(db) {
  const byCampaign = db.prepare('SELECT * FROM board_documents WHERE campaign_id = ?');
  const save = db.prepare(`
    INSERT INTO board_documents (campaign_id, data, revision, updated_by, updated_at)
    VALUES (@campaignId, @data, 1, @updatedBy, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(campaign_id) DO UPDATE SET
      data       = excluded.data,
      revision   = board_documents.revision + 1,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at`);

  return {
    get: (campaignId) => hydrate(byCampaign.get(campaignId)),

    /**
     * Writes a full snapshot and increments the revision.
     * @param {number|string} campaignId
     * @param {object} data
     * @param {string|null} updatedBy
     */
    save(campaignId, data, updatedBy = null) {
      save.run({
        campaignId,
        data: JSON.stringify(data ?? {}),
        updatedBy,
      });
      return hydrate(byCampaign.get(campaignId));
    },

    list: () => db.prepare('SELECT * FROM board_documents ORDER BY campaign_id').all().map(hydrate),
  };
}
