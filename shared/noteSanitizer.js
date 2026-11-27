const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'br',
  'h1',
  'h2',
  'h3',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
]);

const STRIP_CONTENT_TAGS = /<(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Escapes plain text for safe embedding inside HTML.
 * @param {string} value
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitizes rich-text HTML down to a strict whitelist of formatting tags with no
 * attributes, event handlers, or executable URLs. Safe in both Node and browser.
 * @param {string} rawHtml
 * @returns {string}
 */
export function sanitizeNoteHtml(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml) return '';
  let cleaned = rawHtml.replace(STRIP_CONTENT_TAGS, '');
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');
  cleaned = cleaned.replace(/<\/?([a-zA-Z0-9-]+)(?:\s+[^>]*)?>/g, (match, tagName) => {
    const lower = tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(lower)) return '';
    if (match.startsWith('</')) {
      return lower === 'br' ? '' : `</${lower}>`;
    }
    return `<${lower}>`;
  });
  return cleaned.trim();
}

/**
 * Converts legacy plain-text notes (e.g. DM session notes) into sanitized `<p>` paragraphs.
 * @param {string} text
 * @returns {string}
 */
export function plainTextToHtml(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const blocks = text.split(/\r?\n\s*\r?\n/);
  const html = blocks
    .map((block) => {
      const lines = block.split(/\r?\n/).map((line) => escapeHtml(line));
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('');
  return sanitizeNoteHtml(html);
}
