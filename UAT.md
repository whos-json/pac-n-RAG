# User acceptance testing

Corpus: `uat/corpus/` (7 topic files, `ambiguous.txt`, `sample.pdf`). Link page: `node uat/serve.js` serves `http://127.0.0.1:4848/`.
Run the app against a throwaway folder: `DATA_DIR=<temp dir> PORT=<port> node server.js`.

Severity: **blocker** (cannot complete the job or loses data), **major** (job completes but wrongly or painfully), **minor** (polish), **note** (observation).

## Scenarios

| ID | Scenario | Pass when |
|---|---|---|
| S1 | First run, empty library | Board shows the empty-maze message, library says nothing is there yet, no console errors, chat greeting present |
| S2 | Drop the 7 topic files on the board (drag and drop) and via Choose files | Each is filed; lease docs share a room, JavaScript docs share a room, recipes share a room, Lisbon has its own; pellets appear in the rooms; status line reports each filing |
| S3 | Add a note, add a link (`http://127.0.0.1:4848/`) | Both file correctly; the link item shows its page title; script text is not indexed |
| S4 | Ask "When can the tenant break the lease?" | Answer quotes the break date with a citation, sources list opens, cyan chomper visits the cited pellets, citation buttons jump to the library item |
| S5 | Ask a follow-up ("what about the notice period?") | Retrieval stays on the lease documents |
| S6 | Ask something not in the library | Plain "nothing matches" reply, no sources, no crash |
| S7 | `extract dates`, `extract amounts from <lease category>`, quick-extract chips, Download CSV | Correct rows with context; scoped result only from that category; CSV opens with the right columns |
| S8 | Feed `ambiguous.txt`; open Ghosts; Keep it; then Sort it elsewhere | Ghost list shows it with the best guess; Keep clears it; Sort moves it and the board updates |
| S9 | Move an item to a brand new category; delete an item (two-step) | Room appears or disappears; delete needs the confirm click and times out if ignored; file and pellet gone |
| S10 | Drop `sample.pdf` | Stored under Unread files, flagged "no text extracted", honest message |
| S11 | Restart the server | Library, categories and pellets all return |
| S12 | Keyboard only (no mouse): add a note, a file, ask, extract, move, delete, open View | Every control is reachable and operable, focus is visible and never lost, dialogs trap and restore focus |
| S13 | `prefers-reduced-motion: reduce` | No continuous or travelling animation; highlights still show the retrieved sources |
| S14 | Narrow viewport (375 px wide) | No horizontal page scroll, board visible, chat usable, nothing overlaps |
| S15 | Robustness: very long note, unicode and emoji, HTML in a note title, double-click Send, two uploads at once, server stopped mid-session | No XSS, no stuck busy state, clear error messages, no lost data |
| S16 | Security: wrong `Host`, missing `x-pacrag`, path traversal on static and `/files/`, oversized bodies | Rejected with 4xx, never 5xx, nothing outside `public/` or `data/files/` readable |

## Round log

Each round: run the scenarios, list defects, fix, re-run. Stop when a full round finds no blocker or major defects and no improvement worth making.

### Round 1 (browser, API/security, code and accessibility review)
About 55 findings: one blocker (hostile HTML froze the server), roughly 15 major (follow-up questions borrowing unrelated context, filler words matching, extract scope hijacked by category names, 500s on `null` bodies, charset mangling, unbounded page reads, weak date/phone/amount patterns, lost focus and errors), the rest minor. All major and blocker items fixed, each with a regression test (`test/hardening.test.js`).

### Round 2
- API/security re-test: all round-1 fixes verified; new findings fixed (impossible dates, `<!DOCTYPE>` junk, values cut at chunk boundaries, phone formats, charset fallback, credentials echoed in errors, duplicate normalisation).
- Code and accessibility re-review: round-1 fixes verified; new findings fixed (focus on group headers, duplicate alerts, live reduced-motion listener, belly kept in view on phones, newest item never hidden, canvas size cap, stale refresh guard).
- Browser re-test: all round-1 defects verified fixed; no blocker or major found. Minor items left open: chat space is tight at 1024x768 when a table is open, the "From" column is narrow at 375 px, a stale delete hint stays in the status line after its timeout, Recent filings can grow long, S13 (reduced motion) was checked by code and the Animation switch but not with OS-level emulation. The stuck "Digesting…" status after a refused duplicate was fixed after this round and not re-tested in the browser.

### Known and accepted
Keyword-only categorising makes many small rooms for short unrelated notes; PDFs and Word files are not read; the index is rebuilt after every change; CSV formula guard adds an apostrophe to values starting with `+`. See README "Known limits".
