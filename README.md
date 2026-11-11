# PAC&RAG

A local knowledge base with a circuit-board chomper for an interface. Drop files, notes and links onto the maze and they get digested: text is extracted, split into passages, indexed, and filed under an automatically chosen category. Then chat with it: ask questions (answers cite their passages) or ask it to extract dates, amounts, emails, links and phone numbers into a table you can download as CSV.

```bash
node server.js          # then open http://localhost:4747
npm test                # API and behaviour tests
```

No dependencies to run. Needs Node 18 or newer.

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

- Everything is stored in `data/` next to the server. The server only listens on `127.0.0.1`, rejects requests whose `Host` is not local (DNS rebinding), and requires a custom header on every write (blocks other websites from posting to it).
- Categorizing, indexing, retrieval and extraction run locally.
- **Answers are local by default**: the best sentences from your sources, quoted with citations.
- To get written answers from Claude, run `npm install @anthropic-ai/sdk` and set `ANTHROPIC_API_KEY`. Only the retrieved passages and the recent chat turns are sent to Anthropic with each question, never the whole library. The sidebar says which mode is active. Set `PACRAG_LOCAL_ONLY=1` to force local mode even when a key is present. `CLAUDE_MODEL` overrides the model (default `claude-opus-5-5`).
- Links you add are fetched by the server from your machine, including addresses on your own network.

## Design

- `server.js`: HTTP API, storage (`data/items.json` plus `data/files/`, written atomically), BM25 search, categorizer, extraction, optional Claude answers.
- `public/board.js`: the canvas maze and chompers. Decorative only; everything on it is reachable from the lists and chat.
- `public/app.js`: library, ghosts, dialogs, chat, drag and drop.
- Categorizer: cosine similarity between an item's key terms and each category's centroid. Clearly similar joins the category, borderline joins but goes to Ghosts, unlike anything starts a new category named after its two most distinctive terms. Moving an item teaches it, because categories are derived from their members.
- Accessibility: every action has a keyboard path (the board is never required), results are announced through live regions, dialogs are native, and `prefers-reduced-motion` turns the animation off.

## Known limits

- PDFs and Word files are stored and listed but not read, so they cannot be searched by content. This is the biggest gap.
- Retrieval is keyword-based (BM25 with plural stemming). It misses answers phrased with different words, and it cannot tell that "dentist" and "gym" are both health. Embeddings (a local model such as Ollama or transformers.js) are the next step.
- Categorizing has the same limit: it groups documents that share vocabulary (it keeps three lease documents together) but short unrelated notes each tend to get their own room (24 varied one-line notes made 21 rooms). Category names come from key terms ("Lease & Rent"), so they can be blunt. Move items to a category you name and it learns from that. Using Claude or embeddings to categorize is the main improvement still to make.
- Extraction is pattern-based: dates (validated), amounts, emails, links and grouped phone numbers only. Bare digit strings, `1.2k`, and euro amounts written `1.234,56 €` are not recognised.
- Local answers lead with the best-matching sentence from each source. They quote; they do not summarise or reason across sources.
- Duplicate notes and links are refused (case and spacing ignored). Uploaded files are not de-duplicated.
- Large libraries: the search index is rebuilt after every change and `items.json` is rewritten whole, so with tens of megabytes of text each change can pause the server for about a second.
- The HTML converter ignores quoting inside tag attributes (`<p title="a>b">` leaks `b">`).
- Folders cannot be dropped, only the files in them. Items over 25 MB are rejected; text beyond 2,000,000 characters is cut and flagged.
- Chat history lives in the page and resets on reload.
- The chomper is a generic shape. Pac-Man is a trademark, so use your own character before sharing or selling this.
