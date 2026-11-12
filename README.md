# Tally

A chat agent with one tool, web search, that remembers what it told you. Ask it about prices, releases or news and it answers with numbered sources. Days later, ask *"What did I ask you on 3 November? Is that still correct?"* and it finds that conversation, re-checks each claim it made against the web, and tells you what changed.

How it works, and why: [DESIGN.md](DESIGN.md).

## Setup

You need **Node 22.13 or newer** and two API keys: a model key, and [Tavily](https://app.tavily.com/) for web search. The model key is Gemini from [Google AI Studio](https://aistudio.google.com/apikey) by default, or [Groq](https://console.groq.com/keys) with `LLM_PROVIDER=groq`. With both model keys set, Gemini calls that hit their quota are retried on Groq.

```sh
cp .env.example .env      # then paste both keys into .env
npm install
npm run dev               # http://localhost:3000
```

There is no build step and nothing native to compile. The server refuses to start until both keys are set, and says which one is missing. Conversations are stored in `data/tally.db`; delete the `data/` folder to start fresh.

Things to try:

- *What does Neon's Launch plan cost right now?*
- *Compare HubSpot, Pipedrive and Close pricing for a 20-person sales team.*
- *What did I ask you on 3 November?* With an empty history, it should say it has no record rather than invent one.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server and restarts it when code changes. |
| `npm test` | Unit tests, including the full pipeline with scripted models. No keys or network needed. |
| `npm run typecheck` | Type-checks everything. |
| `npm run eval` | Runs the 29 cases in [evals/cases.json](evals/cases.json) against the real server and prints a pass/fail table with timings. Needs both keys, spends API credits and takes several minutes. `-- --list` shows the cases without running them; `-- --only edge` runs the cases whose id contains "edge". |
| `npm run seed` | **Opt-in demo data.** Asks three real questions with the clock set to past dates (the most recent 3 November, last Monday, last Tuesday), so the questions from the brief have something to find. These conversations are titled `[Demo] …`. Delete `data/` to remove them. |
| `npm run latency` | Times 5 typical questions against a running server: first status line, first token, total. |

## Configuration

Set in `.env` (see [.env.example](.env.example)):

| Variable | Required | Purpose |
|---|---|---|
| `LLM_PROVIDER` | no | `gemini` (default) or `groq`. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | with Gemini | Gemini models for planning, answering and claim extraction. |
| `GROQ_API_KEY` | with Groq | Groq models. With Gemini, enables retrying quota-exhausted (429) calls on Groq. |
| `TAVILY_API_KEY` | yes | Web search. |
| `MODEL_FAST` | no | Planner and claim extractor, with low thinking. Default `gemini-3.5-flash-lite`, or `openai/gpt-oss-20b` with Groq. |
| `MODEL_SMART` | no | Writes the answers. Default `gemini-3.8-flash`, or `openai/gpt-oss-120b` with Groq. |
| `NOW` | no | Pins the clock (ISO 8601), e.g. `2026-11-03T09:00:00Z`, to create history "in the past". |
| `PORT` | no | Default `3000`. |

Set `NODE_DEBUG=tally` to log the timing of each stage (plan, recall, search, first token, total) for every message.

## Layout

```
src/server.ts        HTTP routes and the streamed chat endpoint
src/lib/pipeline.ts  one message: dates → plan + recall → search → answer
src/lib/models.ts    providers and models, Gemini → Groq fallback, Groq rate-limit backoff
src/lib/             time, db, plan, recall, search, answer, extract, prompts, budget
public/              the chat page (no framework)
evals/               eval cases, runner, and the HTTP harness it shares with scripts/
scripts/             seed and latency
```
