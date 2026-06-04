// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

// Minimal content gate for strings that land on the projector (participant
// names, chat narration). This is deliberately a SHORT, high-precision list
// of unambiguous English slurs/profanity matched on word boundaries — not a
// general profanity filter. Goals: stop drive-by defacement of a projected
// leaderboard at a public event without false-positiving legitimate names
// (including non-English ones — the event audience is international, so an
// allowlist approach is explicitly NOT used).
//
// The real backstops remain: write access requires the per-event workshop
// key, everything is HTML-escaped at render, and the presenter has a
// one-click board reset.

const BLOCKED = [
  // kept deliberately short and unambiguous; word-boundary matched
  'fuck', 'fucking', 'fucker', 'shit', 'bitch', 'cunt', 'asshole',
  'nigger', 'nigga', 'faggot', 'retard', 'rape', 'rapist',
  'hitler', 'nazi', 'kike', 'spic', 'chink', 'wetback', 'tranny',
];

// Leading word-boundary required (keeps "Scunthorpe" clean — the term must
// START a word), trailing letters allowed (catches compounds like
// "shitpost"). Trade-off chosen for precision over recall.
const PATTERN = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${BLOCKED.join('|')})`,
  'iu',
);

// Collapse common leet/spacing evasions before matching: f.u.c.k, f u c k,
// f-u-c-k. Single-char separators only — anything fancier costs precision.
function normalize(text) {
  const s = String(text || '').toLowerCase()
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a').replace(/[5$]/g, 's').replace(/[7]/g, 't');
  const collapsed = s.replace(/(\w)[.\-_* ](?=\w[.\-_* ]|\w$)/g, '$1');
  return `${s} ${collapsed}`;
}

export function isClean(text) {
  return !PATTERN.test(normalize(text));
}
