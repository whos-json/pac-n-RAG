# PAC&RAG

A local knowledge base with a circuit-board chomper for an interface. Drop files, notes and links onto the maze and they get digested: text is extracted, split into passages, indexed, and filed under an automatically chosen category. Then chat with it: ask questions (answers cite their passages) or ask it to extract dates, amounts, emails, links and phone numbers into a table you can download as CSV.

On Windows you can double-click `start.bat`. Do not open `public/index.html` from disk: the app needs the server (a page opened as `file://` shows a message saying so).

```bash
node server.js          # then open http://localhost:4747
node server.js --help   # usage and environment, without creating anything
npm test                # API and behaviour tests
```

No dependencies to run. Tested on Node 24 (v24.19.0); other versions are not tested.

## Desktop app (Windows)

The same app in its own window, no browser needed. One Electron process runs the local server (on a random port bound to `127.0.0.1`) and shows it; links open in your default browser.

```bash
npm install                                   # once: installs Electron and electron-builder (dev only)
npm run app                                   # run it from source
npm run dist                                  # builds dist/PAC-RAG.exe (portable, unsigned)
powershell -File uat/smoke-exe.ps1            # starts the built app on a throwaway folder and checks it stays up
```

- Your library is stored in `PAC-RAG-data` next to the portable exe (or `%APPDATA%\pac-rag\data` when run from source). `DATA_DIR` overrides it. Menu: PAC&RAG > Open data folder.
- The exe is unsigned, so Windows SmartScreen shows "More info > Run anyway" the first time. A portable exe unpacks itself on every start, so launching takes a few seconds.
- Only one copy can run at a time (it would share the library); a second launch tells you so.
- Set up the AI model from the "AI model..." button inside the app, exactly as in the browser.

## What it does

| You do | It does |
|---|---|
| Drop or choose files, paste a note, paste a link | Extracts text, chunks it, indexes it (BM25), picks a category |
| Ask a question | Retrieves the best passages, answers with `[n]` citations, shows the sources |
| Ask a follow-up | Short follow-ups reuse your previous question for retrieval |
| Type `extract dates` / `amounts` / `emails` / `links` / `phones` (optionally `from <category>`) | Returns a table of matches with context, downloadable as CSV |
| Open the Ghosts list | Items it was unsure about: keep its guess or sort them yourself |

On the board: rooms are categories, pellets are items, the belly is the drop zone. The orange chomper digests what you drop and delivers a pellet to its room. When you ask a question the cyan chomper runs to the pellets that supplied the answer, so you can see which sources were used.

## Privacy

- Everything you add is stored in the data folder: `data/` next to `server.js` when you run `node server.js`, or the folder in `DATA_DIR` if set. In the desktop app (`npm run app`, or the portable `dist/PAC-RAG.exe`) it is `data/` inside the app's user-data folder (on Windows `%APPDATA%\<app name>\data`) unless `DATA_DIR` is set; the menu item PAC&RAG → Open data folder shows the exact path. The server only listens on `127.0.0.1`, rejects requests whose `Host` is not local (DNS rebinding), and requires a custom header on every write (blocks other websites from posting to it).
- Categorizing, indexing, retrieval and extraction run locally.
- **Written answers need an AI model.** Retrieval is the "R" of RAG and always runs locally; the "G" (writing an answer from the passages) needs an LLM. Until you connect one the app says so (a banner in the chat and the top bar) and answers are only the best passages, quoted with citations.
- **Connect a model in the app** (button "AI model…"): a local **llama.cpp server** (`llama-server -m model.gguf --port 8080`; Ollama, LM Studio and vLLM also work through the same OpenAI-compatible interface), any **OpenAI-compatible cloud API** (OpenAI, OpenRouter, Groq, Together…) or **Anthropic (Claude)**. There is a Test connection button. No SDK or other dependency is needed.
- What is sent to a model: the question, the few best-matching passages (trimmed to about 7,000 characters in total so small context windows are not overflowed) and the last few chat turns. Never the whole library. A server on your own machine keeps everything local; for a cloud address the dialog tells you which host receives the passages. Cloud APIs must use `https://`.
- **Your API key** is saved in plain text in `settings.json` in the data folder (the file is not served and the key is never returned by the API, only its last four characters). Anyone who can read the data folder can read the key, so do not share or sync that folder. A saved key is only ever sent to the address it was saved for: change the address and you must paste the key again.
- If the model fails (server down, key refused, rate limit, context too small), you get the quoted passages and a note saying why.
- Set `PACRAG_LOCAL_ONLY` to `1`, `true` or `yes` (any letter case; spaces around the value are ignored) to never contact any model, even a saved one or `ANTHROPIC_API_KEY`. Any other value leaves it off.
- Environment defaults are used only while no `settings.json` exists; saving settings in the app replaces them. Setting `ANTHROPIC_API_KEY` alone enables Claude-written answers, and no SDK is needed. From then on each question's retrieved passages and recent chat turns are sent to Anthropic. `PACRAG_LLM_URL` (with optional `PACRAG_LLM_MODEL` and `PACRAG_LLM_KEY`) selects a llama.cpp or OpenAI-compatible server instead; if both are set, `PACRAG_LLM_URL` wins.
- Links you add are fetched by the server from your machine, including addresses on your own network.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4747` | Port to listen on (whole number, 1 to 65535). The server binds to `127.0.0.1` only. |
| `DATA_DIR` | `data/` next to `server.js`; in the desktop app, `data/` in its user-data folder | Where `items.json`, `files/` and `settings.json` live. A relative value is resolved against the current working directory. |
| `PACRAG_LLM_URL` | unset | Default llama.cpp / OpenAI-compatible server (e.g. `http://127.0.0.1:8080`). Settings saved in the app win, and it wins over `ANTHROPIC_API_KEY`. |
| `PACRAG_LLM_MODEL` | unset | Model name sent with `PACRAG_LLM_URL` requests (optional for llama.cpp). |
| `PACRAG_LLM_KEY` | unset | API key sent as a bearer token to the `PACRAG_LLM_URL` server. |
| `ANTHROPIC_API_KEY` | unset | Default Anthropic key. Enables Claude-written answers; no SDK needed. |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Claude model used with `ANTHROPIC_API_KEY`. |
| `PACRAG_LOCAL_ONLY` | unset | `1`, `true` or `yes` (any letter case) forces local answers even with a key set. |
| `PACRAG_EMBED_MODEL` | unset | Turns on semantic search with this embedding model (for example `nomic-embed-text`), served by the Ollama-style server at `OLLAMA_URL`. Unset: keyword search only. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Address of the embedding server. Only read when `PACRAG_EMBED_MODEL` is set. |
| `PACRAG_EMBED_ALLOW_REMOTE` | unset | Set to `1` to allow an `OLLAMA_URL` that is not on this machine (your text is then sent there). Without it such an address is refused and semantic search stays off. |

`GET /api/version` reports the version, the Node version and the absolute data folder. Ctrl+C or SIGTERM stops the server cleanly.

## Your data

- **Where:** the data folder (the server prints it at startup; see Privacy for the desktop app): `items.json` (the library and its index source), `files/` (the original uploads), `settings.json` (AI model settings, including any API key) and, only with semantic search on, `embeddings.json` (cached vectors).
- **Back up:** stop the server (or wait until it is idle) and copy `items.json` and `files/` together.
- **Uninstall, server:** delete the project folder, including its `data/` folder (or your `DATA_DIR` folder). The browser also keeps display choices such as the 2D/3D view in its local storage for this address; clear them in the browser if you want them gone.
- **Uninstall, desktop app:** delete `PAC-RAG.exe` and the `data` folder in the user-data folder (or your `DATA_DIR` folder). That user-data folder also holds Electron's own cache and storage, so deleting the whole folder removes everything the app wrote.
- If `items.json` cannot be read or has an unexpected shape the server refuses to start and leaves the file untouched. If a save fails (for example the folder is locked) the change is rolled back and you get an error.

## Limits

- Uploads, and fetched pages: 25 MiB each (an upload that declares more is refused before it is read).
- Notes: 1 MiB of UTF-8 text, measured after JSON decoding, so escapes in the request (such as `\n` or `\u0001`) do not count against it. Questions: 1000 characters (UTF-16 units, so an emoji counts as two; surrounding spaces are trimmed first). Extract tables: 500 rows. Titles 120, file names 200 and category names 40 characters.
- Indexed text per item: 2,000,000 characters.

## Design

- `server.js`: HTTP API, storage (`items.json` plus `files/` in the data folder; `items.json` is written atomically via a temp file and rename, uploaded files are written directly), BM25 search, categorizer, extraction, the AI-model settings endpoints (`/api/llm`).
- `llm.js`: written answers over plain `fetch` to llama.cpp / OpenAI-compatible / Anthropic endpoints; settings validation and storage, prompt budget, key redaction, response caps and timeouts.
- `workflow.js`: the item lifecycle as a finite state machine. States `filed`, `review` (a ghost), `unread` (no extractable text, or no words the index can use; the item's `reason` is `no-text` or `no-words`) and the terminal `deleted`; events `keep`, `sort`, `delete`. State is derived from the item, never stored. Every PATCH or DELETE goes through `transition()`, which refuses invalid moves with `409` and the list of allowed actions. Items in API responses carry `state` and `actions`.
- Defensive storage: refused requests change nothing; a failed save rolls memory back so it never runs ahead of disk; `keep` on a filed item and `sort` to the current category change nothing, so repeating them is safe, while `keep` on an unread item is refused with `409`; category names reuse an existing spelling (`money` joins `Money`); damaged records in `items.json` are repaired or skipped; at startup, files with no record are moved to `data/orphans/` (never deleted, and never touched when there is no `items.json`); a record whose file has vanished cannot crash the server; SIGINT and SIGTERM shut down cleanly. `/api/status` reports `repaired` and `orphaned`, the counts from that startup check.
- Semantic search (optional), `embed.js`: set `PACRAG_EMBED_MODEL` (for example `nomic-embed-text`) to use a local Ollama-style server at `OLLAMA_URL` (default `http://127.0.0.1:11434`). Chunk vectors are computed in the background, cached in `embeddings.json` in the data folder, and fused with BM25 by reciprocal rank fusion. A non-loopback URL is refused unless `PACRAG_EMBED_ALLOW_REMOTE=1`, because your text would leave the machine. If the server is down or slow (3 s query timeout) search is plain BM25. `/api/status` reports `semantic` (`off`, `indexing`, `ready`, `unavailable`) with `embedded` and `total`; `indexing` lasts until every chunk has a usable vector.
- `public/boot.js`, `board3d.js`, `board3d.css`: the default holographic 3D grid (three.js r187, vendored in `public/vendor/three`, MIT, so nothing is fetched from the web). The module is chosen at load: WebGL and no opt-out gives 3D, anything else gives the flat board. `?view=2d` or the "3D view" switch changes it and is remembered. Same API as `board.js`, so `app.js` does not know which is running. Idle cost is low: animation pauses when the tab is hidden and bloom renders at most 1.5x.
- Layout: two sections. The stage (the board, filling the top) and the console (bottom) with three tabs: Ask, Add, Library (with a badge for items and for ghosts). `public/stage.css` holds the layout, `console.js` the tabs (`window.PacUI.show('lib')`), `feedback.js` the motion feedback: whatever you drop, paste, type or choose flies from where it came from into the core as a chip with a glowing trail, a ring bursts where it lands and the core chomps, then the item travels to its room. It is purely additive and skipped when animation is off or the system asks for reduced motion.
- Max-graphics 3D (`board3d.js` plus `fx3d.js`): ACES tone mapping, HDR bloom, SMAA, a cinematic pass (edge chromatic aberration, vignette, film grain, teal and orange grade), a glossy mirror floor (three.js `Reflector`), holographic glass rooms (fresnel rim, climbing scanline) with one neon hue per category, a light shaft above each room that brightens as it fills, glowing pellet halos, orbiting data motes and a camera shake when something arrives at the core, and a far skyline of lit towers. Quality tiers: `?quality=low|high|ultra` (default ultra; touch devices start at high, without the mirror). `?adaptive=0` turns off adaptive resolution, `?hud=1` shows tier, fps, render size and cost. **Adaptive resolution** (our stand-in for DLSS, not DLSS: that needs NVIDIA hardware and a native engine): about once a second it compares frame time to budget and steps the render scale between 1.0x and 0.55x, then drops SMAA, then bloom and the mirror, and climbs back when there is headroom. Tested only on a software renderer, not on a real GPU.
- `public/onboard.js`: first-run card (three steps, Choose files, Try a sample note) and paste-anywhere.
- `uat/shoot.js`, `uat/drive.js`: dependency-free screenshot and DevTools driver for headless Chrome or Edge, seeded with `uat/corpus` (output goes to the git-ignored `uat/out/`).
- `public/board.js`: the flat canvas maze and chompers (fallback). Decorative only; everything on it is reachable from the lists and chat.
- `public/app.js`: library, ghosts, dialogs, chat, drag and drop.
- Categorizer: cosine similarity between an item's key terms and each category's centroid. Clearly similar joins the category, borderline joins but goes to Ghosts, unlike anything starts a new category named after its two most distinctive terms. Moving an item teaches it, because categories are derived from their members.
- Accessibility: every action has a keyboard path (the board is never required), results are announced through live regions, dialogs are native, and `prefers-reduced-motion` turns the animation off.

## Known limits

- Documents: PDF, `.docx`, `.pptx`, `.xlsx` (text cells only) and OpenDocument (`.odt`, `.ods`, `.odp`) are read by `docs.js` with no dependencies. Scanned PDFs (images), encrypted PDFs, PDFs whose fonts have no Unicode map, old `.doc`/`.xls`/`.ppt` and password-protected Office files are stored but flagged "no text extracted", never shown as gibberish. Files with other extensions (for example `.srt`, `.toml`, `.ps1`) are read as text when their content has no control characters apart from tab, line feed and carriage return. PDF text comes out in content-stream order, so multi-column layouts and tables can read out of order.
- Retrieval is keyword-based (BM25) unless semantic search is switched on (see Design). It folds accents, stems plurals, `-ing`, `-ed` and `-ly` (baked/baking/bake), keeps `4.25%` as one word, forgives a one-letter typo in a word the library has never seen, knows a handful of synonyms (degree/MSc, salary/pay, cost/price/fee) and treats "without eggs" as a reason to demote passages that mention eggs. Everything else is exact words: without semantic search "dentist" and "gym" are not known to both be health. The synonym list is tiny and fixed, and the stemmer is rule-based, so odd forms (`cancelling`, `leasing`) can still miss. Semantic search is used for chat answers only; categorizing stays keyword-based.
- A question is refused ("I couldn't find that") when the best passage matches fewer than two of its words or under half their weight, so a stray word such as "number" no longer cites the wrong document. This also refuses some answerable questions that use a word the library never says ("what degree does she hold" when the CV says "MSc" and not "hold"); rephrase with fewer words. The same guard applies with semantic search on, because it reads the keyword match counts. A short follow-up after a question may borrow that question even without a pointer word, so it can answer from the previous topic.
- Categorizing has the same limit: it groups documents that share vocabulary (it keeps three lease documents together) but short unrelated notes each tend to get their own room (24 varied one-line notes made 21 rooms). A short note now also joins the room of its single nearest member, not only the average of the room, which helps related notes find each other. Room names come from key terms, prefer words in the title or file name and skip filler such as `http`, `title` or `minutes`; a second word is added only when it is nearly as strong as the first. An automatically named room is renamed once, when it reaches three members, unless someone has moved an item into it (a room that existed before this feature is never renamed). Names can still be blunt. Move items to a category you name and it learns from that. An item filed with low confidence (under 0.2) counts for less when the categorizer learns, even after you press Keep, but Keep still marks it as reviewed. Using Claude or embeddings to categorize is the main improvement still to make.
- Extraction is pattern-based: dates (validated; English, Spanish, German and French month names, day-month dates without a year are flagged "no year", and `03/04/25` is flagged ambiguous because it could be day/month or month/day), amounts (`1.234,56 €`, `8 400 €`, `£5k`, `2.4 million euros`), emails, links (including addresses behind link text on pages you add) and grouped phone numbers (with extensions). Bare digit strings are not phones, a lowercase "may" after a number is not a month, and amounts without a currency sign or unit are not recognised. The "ambiguous" and "no year" flags are appended to the row's context (and so to the CSV) because the page has no spare column. `extract dates and amounts` shows the first table and names how many of the others were found; the API response carries them all under `also`, but the page shows only the first. Phrases like "list the dates in my lease documents" work, but only when what follows the verb is plainly a kind of value; anything else is treated as a question.
- Local answers lead with the best-matching sentence from each source, skipping headings, the title and very short lines, and favouring a date, amount, email or phone number when the question asks "when", "how much", "who" or "call". They quote; they do not summarise or reason across sources.
- Duplicate notes are refused (case and spacing ignored). A link is refused before it is fetched if the same address is already in the library, and again on its final address after redirects, which is the address it is stored under. Uploaded files are not de-duplicated.
- Large libraries: the search index is rebuilt after every change and `items.json` is rewritten whole, so with tens of megabytes of text each change can pause the server for about a second.
- The HTML converter ignores quoting inside tag attributes (`<p title="a>b">` leaks `b">`).
- Folders cannot be dropped, only the files in them. Items over 25 MB are rejected; text beyond 2,000,000 characters is cut and flagged.
- Chat history lives in the page and resets on reload.
- The mascot, "Byte" (a chip with a hinged lid, teeth and eyes), is an original character, drawn in both boards. The name PAC&RAG and the maze-with-pellets idea still echo Pac-Man, so check the name and branding with a trademark search before selling this.
