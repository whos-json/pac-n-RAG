# User acceptance testing

Corpus: `uat/corpus/` (7 topic files, `ambiguous.txt`, `sample.pdf`). Link page: `node uat/serve.js` serves `http://127.0.0.1:4848/`.
Run the app against a throwaway folder: `DATA_DIR=<temp dir> PORT=<port> node server.js`.

Severity: **blocker** (cannot complete the job or loses data), **major** (job completes but wrongly or painfully), **minor** (polish), **note** (observation).

## Scenarios

| ID | Scenario | Pass when | Run | Last run |
|---|---|---|---|---|
| S1 | First run, empty library | Board shows the empty-maze message, library says nothing is there yet, no console errors, chat greeting present | manual | |
| S2 | Drop the 7 topic files on the board (drag and drop) and via Choose files | Each is filed; lease docs share a room, JavaScript docs share a room, recipes share a room, Lisbon has its own; pellets appear in the rooms; status line reports each filing | manual step (drag and drop) | |
| S3 | Add a note, add a link (`http://127.0.0.1:4848/`) | Both file correctly; the link item shows its page title; script text is not indexed | | |
| S4 | Ask "When can the tenant break the lease?" | Answer quotes the break date with a citation, sources list opens, cyan chomper visits the cited pellets, citation buttons jump to the library item | | |
| S5 | Ask a follow-up ("what about the notice period?") | Retrieval stays on the lease documents | | |
| S6 | Ask something not in the library | Plain "nothing matches" reply, no sources, no crash | | |
| S7 | `extract dates`, `extract amounts from <lease category>`, quick-extract chips, Download CSV | Correct rows with context; scoped result only from that category; CSV opens with the right columns | manual step (quick-extract chips, Download CSV) | |
| S8 | Feed `ambiguous.txt`; open Ghosts; Keep it; then Sort it elsewhere | Ghost list shows it with the best guess; Keep clears it; Sort moves it and the board updates | manual step (Keep and Sort in the UI) | |
| S9 | Move an item to a brand new category; delete an item (two-step) | Room appears or disappears; delete needs the confirm click and times out if ignored; file and pellet gone | manual step (two-step delete in the UI) | |
| S10 | Drop `sample.pdf` (not a real PDF), then `test/fixtures/report.pdf` and a `.docx` | The fake one is stored under Unread files, flagged "no text extracted", honest message; the real ones are filed by content and answer questions with citations ("How long does the warranty last?") | | |
| S11 | Restart the server | Library, categories and pellets all return | | |
| S12 | Keyboard only (no mouse): add a note, a file, ask, extract, move, delete, open View | Every control is reachable and operable, focus is visible and never lost, dialogs trap and restore focus | manual | |
| S13 | `prefers-reduced-motion: reduce` | No continuous or travelling animation; highlights still show the retrieved sources | manual | |
| S14 | Narrow viewport (375 px wide) | No horizontal page scroll, board visible, chat usable, nothing overlaps | manual | |
| S15 | Robustness: very long note, unicode and emoji, HTML in a note title, double-click Send, two uploads at once, server stopped mid-session | No XSS, no stuck busy state, clear error messages, no lost data | manual step (double-click Send) | |
| S16 | Security: wrong `Host`, missing `x-pacrag`, path traversal on static and `/files/`, oversized bodies | Rejected with 4xx, never 5xx, nothing outside `public/` or `data/files/` readable | | |
| S17 | State machine: Keep a ghost twice; Sort it to `money` when `Money` exists; delete an item in a second tab, then Keep or Sort it in the first | Second Keep changes nothing; one `Money` room only; the stale tab shows the error and refreshes its lists, no dead buttons | manual step (Keep and Sort in the UI, second tab) | |
| S18 | Resilience: make `data/` read-only, add a note, then restore; kill the server mid-upload, restart | Clear error, no phantom item after reload; app recovers once writable; stray files appear in `data/orphans/`, library intact | | |

Run: `manual` means the scenario cannot be automated; `manual step` means only the named step needs a browser or a person. Blank means no manual step is marked here. Last run stays empty until a round is run.

S10: the automated `.docx` is built in memory by `test/docs.test.js`; a browser run may use any real `.docx` instead.

## Round log

Each round: run the scenarios, list defects, fix, re-run. Stop when a full round finds no blocker or major defects and no improvement worth making.

### Round 1 (browser, API/security, code and accessibility review)
About 55 findings: one blocker (hostile HTML froze the server), roughly 15 major (follow-up questions borrowing unrelated context, filler words matching, extract scope hijacked by category names, 500s on `null` bodies, charset mangling, unbounded page reads, weak date/phone/amount patterns, lost focus and errors), the rest minor. All major and blocker items fixed, each with a regression test (`test/hardening.test.js`).

### Round 2
- API/security re-test: all round-1 fixes verified; new findings fixed (impossible dates, `<!DOCTYPE>` junk, values cut at chunk boundaries, phone formats, charset fallback, credentials echoed in errors, duplicate normalisation).
- Code and accessibility re-review: round-1 fixes verified; new findings fixed (focus on group headers, duplicate alerts, live reduced-motion listener, belly kept in view on phones, newest item never hidden, canvas size cap, stale refresh guard).
- Browser re-test: all round-1 defects verified fixed; no blocker or major found. Minor items left open: chat space is tight at 1024x768 when a table is open, the "From" column is narrow at 375 px, a stale delete hint stays in the status line after its timeout, Recent filings can grow long, S13 (reduced motion) was checked by code and the Animation switch but not with OS-level emulation. The stuck "Digesting…" status after a refused duplicate was fixed after this round and not re-tested in the browser.

### Round 3 (hardening)
Fixed, each with a regression test in `test/round3.test.js`: `/files/<id>` with the file missing crashed the process (now 404); a failed save left phantom items and half-done PATCH/DELETE in memory (now rolled back, upload file removed, clear 500, rename retried on EPERM/EBUSY/EACCES); `//` style request targets gave 500 (now 400); truncation split surrogate pairs and broke downloads, and long file names lost their extension; `constructor`/`__proto__` words and category names broke the categorizer; category names are now normalised and matched case-insensitively; a whitespace-heavy `extract` question froze the parser; wrong-shape `items.json` is refused at startup; oversized uploads are refused on `Content-Length`; startup/ops polish (PORT validation, friendly EADDRINUSE, graceful shutdown, `--help`, `/api/version`, SDK-missing fallback, CRLF normalisation, link credentials, scheme-less links); `npm test` was run on Node 24 only.
Not re-run in a browser. SIGINT/SIGTERM graceful shutdown is not automated (Windows cannot deliver SIGTERM to a child process).

### Round 4 (audit and fixes)
Audit areas: README and UAT against the code (privacy and environment wording, data location, Node support, limits, semantic search, `/api/status` fields, `reason` and link duplicates); test isolation (a shell with `ANTHROPIC_API_KEY` or `PACRAG_EMBED_MODEL` set no longer reaches the test or UAT servers); the ambiguous-note assertion; the save-retry and 2,000,000-character regressions; timing bounds.
Changes:
- README: data location for the server and the desktop app; environment table completed; key and `PACRAG_LOCAL_ONLY` rules matched to `llm.js` and `server.js`; Node 24 is the only tested version; question length in UTF-16 units; note limit after decoding; link duplicate rule.
- Tests: `test/round3.test.js` drops `String#isWellFormed` (Node 20+) for a regex; new regressions for the rename retry (EPERM twice) and for the 2,000,000-character cut; timing bound raised to 5 s. `test/api.test.js`: the ambiguous-note test asserts the observed outcome (a ghost with a low-confidence guess) and that Keep clears it; `embedder: null` next to `answerer: null`.
- `uat/drive.js`, `uat/shoot.js`: `answerer: null` and `embedder: null`.
- `package.json` engines: `>=24` (was `>=18.2`).
- UAT: the scenario table has Run and Last run columns; manual steps are marked.
`npm test` was run on Node 24 at the end of this round.
Needs a browser re-run: S1, S2 (drag and drop), S7 (quick-extract chips and CSV download; the CSV guard has no test), S8 and S17 (Keep and Sort in the UI), S9 (two-step delete), S10 (a real `.docx`), S12 to S14 (keyboard, reduced motion, 375 px), S15 (double-click Send), and the unread labels for items with `reason` `no-words`.
Announced by other sessions but not in the code when this round closed: refusing extract qualifiers such as years (`extract amounts in 2026` still returns a table).

### Known and accepted
Keyword-only categorising makes many small rooms for short unrelated notes; scanned/encrypted PDFs and legacy `.doc` files are not read; the index is rebuilt after every change; CSV guard (`csvOf` in `public/app.js`) puts an apostrophe before any value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, and quotes every field. No test covers it, so check the CSV by hand. See README "Known limits".
