# DESIGN

A chat agent with one tool: web search. It is built on one observation about the questions it will get. The hard ones aren't "search for X". They are about **time**: *"What did I ask you on 3 November? Is it still correct?"*, *"Has anything changed since Monday?"*. Answering those well takes three things. The agent has to **remember what it claimed, when, and from which source**. It has to work out what "last Tuesday" means. And it has to re-check the old claims against the web.

## How it works

```
message ─► resolve dates (code) ─┬─► plan (fast model, JSON) ──► web search ×N (parallel)
                                 └─► recall (SQLite: date range + full-text search)  │
                                                                                      ▼
                           remember claims ◄── (after reply) ◄── answer (strong model, streamed, cited)
```

1. **Resolve dates in code.** The code turns "Monday", "last Tuesday" and "3 November" into absolute ranges in the user's timezone (sent by the browser). `NOW` can be overridden for testing.
2. **Plan.** A fast model returns a typed plan: `{ intent: chat | lookup | memory | memory_then_verify, needs_search, entities[], since?, queries[] }`. There is no `needs_memory` flag: the intent already says whether memory matters, and a second flag could contradict it. Chit-chat and stable facts skip search entirely. This step runs **in parallel** with a first memory lookup on the raw message.
3. **Recall.** Memory is **not a tool**. The harness fetches past turns and stored claims (by date range plus SQLite FTS5) and adds them to the prompt as *"Your record of past conversations"*. Memory spans all conversations, not just the current one.
4. **Search.** The planned queries run in parallel through Tavily. Results are de-duplicated by URL and cached for 6 hours. Vendor pages (pricing, changelogs) are preferred. Tavily's `start_date` is used only when re-checking old claims (set to the old answer's date), with an unfiltered retry if that returns nothing: pricing pages are often undated, and a date filter would silently drop them, making "no change" answers wrong.
5. **Answer.** A strong model streams the answer. It may call `web_search` itself at most twice more, if gaps remain. Rules: answer first; cite `[n]`; compare *then → now*; keep **"no evidence of change"** separate from **"confirmed unchanged"**; if there is no record for a date, say so and never invent one.
6. **Remember.** After the stream closes, so the user never waits on it, a fast model extracts claims as `{entity, attribute, value, source_url, as_of}`. These go into a `claims` table linked to the message.

**Data:** `conversations`, `messages(created_at)`, `claims`, `search_cache`. This uses Node's built-in `node:sqlite`, which needs no native build, so `npm install` can't fail on a compiler.

## Why this way

- **Storing claims turns "is it still correct?" into a diff.** With transcripts alone, the model has to re-read and re-guess. With claims, it compares *"Neon Pro was $19/mo (3 Nov, source)"* against what the pricing page says today.
- **Fast.** Status events stream at once ("Checking 5 vendors' pricing pages…"). Planning and recall overlap. All searches run at the same time. Claim extraction happens after the reply. The static system prompt is kept as a stable prefix so Gemini's context caching can apply. Two Gemini models: `gemini-3.5-flash-lite` routes and extracts, `gemini-3.8-flash` writes the answers (both configurable).
- **Provider-agnostic, on a budget.** Only `models.ts` knows the provider: Gemini by default, or Groq (`gpt-oss-20b` / `gpt-oss-120b`) with `LLM_PROVIDER=groq`. A Gemini call that hits its quota (429) is retried once on Groq; other errors are not, so outages stay visible. The answer gets a fixed context budget: ~600 tokens per search result (its most query-relevant passages), ~4,000 for all results, ~1,500 for recalled memory. That keeps it inside Groq's free tier (~8k tokens/minute) and shortens time to first token on Gemini too.
- **Correct.** Date arithmetic is done in code, never by the LLM. Every factual sentence carries a citation. Uncertainty is stated explicitly. The agent never pretends to remember something.
- **Good to talk to.** It answers first and stays short by default. It asks at most one clarifying question, and pairs it with an offer ("Which 5 tools? Or I can check the leading CRMs for 20-person teams"). When it was wrong before, it says so plainly.

## Considered and rejected

| Option | Why not |
|---|---|
| Unbounded agent loop (ReAct) | Unpredictable latency and repeated searches. A planned fan-out plus at most 2 follow-up calls is faster and easier to reason about. |
| Gemini's built-in Google Search grounding | Less control over queries and date filters, and we need the source text to store and diff claims later. Our own `web_search` tool keeps search a swappable component. |
| Memory as a second tool | The brief allows one tool. It also adds a round trip, and models forget to call it. The harness injects memory instead. |
| Transcript or summary memory only | Can't diff specific claims, and summaries drop the numbers (prices) that matter most. |
| Embeddings / vector DB first | References here are mostly dates and names, which date filters plus FTS5 handle exactly. Embeddings are next, for vague references. |
| LLM does date math | Unreliable on "last Tuesday" around week boundaries. |
| `start_date` on every search | Undated pages (most pricing pages) silently disappear, so "has X changed?" would wrongly report no change. |
| LangChain / heavy framework | More abstraction than the problem needs. The pipeline is a few hundred lines I can explain line by line. |
| Next.js | Bundling and runtime complexity for a single chat page. Hono plus one static page is enough. |
| Seeding fake history by default | It would mislead testers. The DB starts empty, and `npm run seed` is opt-in and clearly labeled. |

## How it's tested

`npm run eval` runs 29 scripted multi-turn cases with a pinned `NOW`: memory hits, memory misses, date edge cases, "has X changed", chit-chat that must *not* search. An LLM judge scores them against a rubric, and the runner logs time-to-first-token and total time. `npm test` runs 138 unit tests, including the whole pipeline with scripted models, with no keys or network needed.

**Full eval: not yet measured.** The Gemini and Groq free-tier quotas ran out during testing. Spot checks on Groq (`gpt-oss-120b` / `gpt-oss-20b`), 12 Nov 2026:

| Case | Result | First token | Total |
|---|---|---|---|
| `chat-greeting` | pass | 0.6s | 0.7s |
| `lookup-single-price` | pass | 3.4s | 3.9s |
| `lookup-fan-out` | fail | – | – |

The same Gemini `chat-greeting` case passed in 2.6s / 2.8s. On Groq's free tier (8,000 tokens/minute), an answer that needs a follow-up search can hit the rate limit: each step sends about 6,000 tokens.

## With another week

- **Watchlist.** Re-check tracked entities nightly and open with *"Since you last asked, Neon changed its pricing."*
- **Page snapshots.** Store a hash and text of pricing/changelog pages for true diffs, instead of relying on search snippets.
- **Cross-checking.** Require two independent sources for numeric claims, and score source reliability.
- **Embedding recall** for vague references ("that database thing from last week").
- User accounts, and evals in CI with latency budgets that fail the build.
