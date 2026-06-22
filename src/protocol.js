'use strict';

// Wire protocol shared between server and browser.
//
// Every legitimate message (streaming frame OR JSON reply) is a single line of
// JSON that begins with the exact prefix `{"m":"WT1"`. The corporate proxy's
// interstitial ("reminder") page is HTML, so the client can reliably tell our
// data apart from an injected acknowledgement page by checking this prefix.
// This is detection, not security: confidentiality/integrity of the actual
// shell session is irrelevant here (approved + monitored usage), we only need
// to know "is this our payload or the nag page?".

const MAGIC_PREFIX = '{"m":"WT1"';

// Build one newline-delimited frame. `m` (magic) is always first so the
// serialized string starts with MAGIC_PREFIX.
function frame(obj) {
  return JSON.stringify({ m: 'WT1', ...obj }) + '\n';
}

module.exports = { MAGIC_PREFIX, frame };
