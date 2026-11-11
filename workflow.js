'use strict';
// The item lifecycle as a finite state machine.
//
//   ingest ──> filed ──────────┐  keep (no-op), sort (re-file)
//        │        ▲            │
//        ├──> review ──keep/sort──> filed        review = "ghost": filed, but the categorizer was unsure
//        │
//        └──> unread (no extractable text)       sort keeps it unread; it can never be searched by content
//
//   any state ──delete──> deleted (terminal; the item no longer exists)
//
// The state is derived from the item, never stored, so it cannot drift from the data.
// Every mutation of an existing item goes through transition(), which either returns the
// fields to change or throws a 4xx explaining why the move is not allowed.

const STATES = Object.freeze({ FILED: 'filed', REVIEW: 'review', UNREAD: 'unread', DELETED: 'deleted' });
const EVENTS = Object.freeze({ KEEP: 'keep', SORT: 'sort', DELETE: 'delete' });

const TABLE = Object.freeze({
  [STATES.FILED]: { keep: STATES.FILED, sort: STATES.FILED, delete: STATES.DELETED },
  [STATES.REVIEW]: { keep: STATES.FILED, sort: STATES.FILED, delete: STATES.DELETED },
  [STATES.UNREAD]: { sort: STATES.UNREAD, delete: STATES.DELETED },
});

const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra);

function stateOf(item) {
  if (item.noText) return STATES.UNREAD;
  if (item.needsReview) return STATES.REVIEW;
  return STATES.FILED;
}

// What a UI should offer. "keep" is only offered to ghosts. A filed item still accepts it as a no-op, so a double click or stale tab is harmless; an unread item refuses it.
const allowedEvents = (item) => {
  const from = stateOf(item);
  return Object.keys(TABLE[from]).filter((e) => e !== EVENTS.KEEP || from === STATES.REVIEW);
};

const MAX_CATEGORY = 40;
const INVISIBLE = /[\p{Cf}\p{Cc}\u2028\u2029\u007f-\u009f\u200b-\u200d\u2060\ufeff]/gu;
// The one definition of a valid category name: Unicode-normalised, invisible characters dropped, spaces collapsed, 1 to 40 code points.
function cleanCategory(value) {
  const c = typeof value === 'string' ? value.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim() : '';
  if (!c || [...c].length > MAX_CATEGORY) throw fail(400, `Category must be 1 to ${MAX_CATEGORY} characters.`);
  return c;
}

// Returns { to, patch } for a valid move, otherwise throws.
// payload.category is required for "sort" and is resolved by the caller to an existing spelling where one exists.
function transition(item, event, payload = {}) {
  const from = stateOf(item);
  const row = TABLE[from];
  if (!Object.prototype.hasOwnProperty.call(row, event)) {
    throw fail(409, `An item that is "${from}" cannot be "${event}".`, { allowed: allowedEvents(item) });
  }
  const to = row[event];
  if (event === EVENTS.DELETE) return { to, patch: null };
  if (event === EVENTS.KEEP) return { to, patch: { needsReview: false } };
  return { to, patch: { category: cleanCategory(payload.category), needsReview: false, confidence: 1 } };
}

const isWebUrl = (s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };

// Checks a stored item and returns a repaired copy, or null when it is beyond repair.
// Guards the server against a hand-edited or older items.json crashing every request.
function repair(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[\w-]+$/.test(raw.id)) return null;
  const it = { ...raw };
  it.chunks = Array.isArray(it.chunks) ? it.chunks.filter((c) => typeof c === 'string') : [];
  it.noText = !it.chunks.length || it.noText === true;
  it.title = typeof it.title === 'string' && it.title.trim() ? it.title : 'Untitled';
  try { it.category = cleanCategory(it.category); } catch { it.category = 'Unread files'; }
  it.confidence = Number.isFinite(it.confidence) ? Math.min(1, Math.max(0, it.confidence)) : 1;
  it.added = Number.isFinite(it.added) ? it.added : 0;
  it.needsReview = it.needsReview === true && !it.noText;
  if (typeof it.source !== 'string' || !isWebUrl(it.source)) delete it.source; // a stored link is only ever http(s); anything else (javascript:, file:) is dropped
  return it;
}

module.exports = { STATES, EVENTS, stateOf, allowedEvents, transition, cleanCategory, repair };
