// Balloon visibility checks for the e2e runner (scripts/e2e.mjs).
//
// The agent balloon (src/renderer/agent/balloon.ts) fades out over 170 ms:
// Balloon.hide() removes the 'open' class at once but only sets `hidden` and
// clears the text when the fade ends, and Balloon.open() adds 'open' back
// synchronously. A balloon is therefore visible only when it is not hidden AND
// has the 'open' class; checking `hidden` alone matches the old text while it
// fades (for example the greeting that a new message interrupts).
//
// The decision logic lives in readVisibleBalloon(), a pure function that is
// unit tested and also serialised into the page expression, so the test and the
// e2e run share one implementation.

/**
 * Decides whether a balloon snapshot counts as visible text.
 *
 * snap: { exists, hidden, open, text, spoken } where `spoken` is the text of the
 * speechLog entries recorded since opts.since (null when no `since` was given).
 * opts: { pattern: string | null, since: number | null }
 *
 * Returns the trimmed balloon text, or null when it does not qualify.
 * Must stay self-contained: it is embedded in page code with toString().
 */
export function readVisibleBalloon(snap, opts) {
  if (!snap || !snap.exists || snap.hidden || !snap.open) return null;
  const text = typeof snap.text === 'string' ? snap.text.trim() : '';
  if (!text) return null;
  const pattern = opts && opts.pattern;
  if (pattern && !new RegExp(pattern, 'i').test(text)) return null;
  if (opts && opts.since !== null && opts.since !== undefined) {
    // The balloon must show a line the queue started speaking since `since`, so
    // text left over from before (a fading or stale balloon) never counts.
    const spoken = Array.isArray(snap.spoken) ? snap.spoken : [];
    const flat = text.replace(/\s+/g, ' ');
    const shows = spoken.some((line) => {
      const head = String(line).replace(/\s+/g, ' ').trim().slice(0, 24);
      return head.length > 0 && flat.includes(head);
    });
    if (!shows) return null;
  }
  return text;
}

/**
 * Page expression (for CdpSession.waitFor / evaluate) that returns the visible
 * balloon text or null. With `since` (a Date.now() value taken before the
 * action) the text must contain a line spoken at or after that time, read from
 * window.__bonziDebug.speechLog.
 */
export function balloonTextExpression({ pattern = null, since = null } = {}) {
  const opts = JSON.stringify({ pattern: pattern ?? null, since: since ?? null });
  const sinceLit = since === null || since === undefined ? 'null' : JSON.stringify(Number(since));
  return `(() => {
    const b = document.getElementById('balloon');
    const t = document.getElementById('balloon-text');
    const since = ${sinceLit};
    let spoken = null;
    if (since !== null) {
      const d = window.__bonziDebug;
      spoken = d && Array.isArray(d.speechLog) ? d.speechLog.filter((x) => x && x.at >= since && x.text).map((x) => String(x.text)) : [];
    }
    const snap = { exists: !!b, hidden: !!(b && b.hidden), open: !!(b && b.classList.contains('open')), text: t ? (t.textContent || '') : '', spoken };
    return (${readVisibleBalloon.toString()})(snap, ${opts});
  })()`;
}

/** Human-readable description used in waitFor timeout messages. */
export function balloonTextMessage({ pattern = null, since = null } = {}) {
  let m = 'visible (open, not fading) balloon text';
  if (pattern) m += ` matching /${pattern}/`;
  if (since !== null && since !== undefined) m += ' showing a line spoken since the action';
  return m;
}
