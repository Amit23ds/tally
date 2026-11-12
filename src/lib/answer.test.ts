import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { searchStep, textStep } from '../test/models.ts';
import { CitationRewriter, SourceList, answer, citedNumbers } from './answer.ts';
import { estimateTokens } from './budget.ts';
import type { StreamEvent } from './events.ts';
import type { SearchProvider } from './search.ts';

const fakeSearch: SearchProvider = {
  async search({ query }) {
    return [
      { title: 'Neon pricing', url: 'https://neon.com/pricing', content: `About ${query}`, excerpt: 'Launch: $19/month' },
      { title: 'Neon blog', url: 'https://neon.com/blog', content: 'News', excerpt: '' },
    ];
  },
};

async function run(model: MockLanguageModelV4, overrides: Partial<Parameters<typeof answer>[0]> = {}) {
  const events: StreamEvent[] = [];
  const result = await answer({
    messages: [{ role: 'user', content: 'What does Neon cost?' }],
    context: { todayLabel: 'Wednesday 11 November 2026', todayIso: '2026-11-11', timeZone: 'Europe/London' },
    searches: [],
    allowSearch: true,
    search: fakeSearch,
    emit: async (event) => {
      events.push(event);
    },
    signal: new AbortController().signal,
    model,
    ...overrides,
  });
  return { result, events };
}

describe('answer()', () => {
  it('searches, streams the answer, and reports only the cited sources', async () => {
    const model = new MockLanguageModelV4({ doStream: [searchStep('neon pricing'), textStep('Neon Launch is $19/month [1].')] });
    const { result, events } = await run(model);

    assert.deepEqual(events.filter((e) => e.type === 'status').map((e) => e.text), ['Searching: neon pricing', 'Reading 2 sources…']);
    assert.equal(result.text, 'Neon Launch is $19/month [1].');
    assert.deepEqual(result.sources, [{ n: 1, title: 'Neon pricing', url: 'https://neon.com/pricing' }]);
    assert.deepEqual(events.at(-1), { type: 'sources', sources: result.sources });
  });

  it('gives the model numbered results it can cite', async () => {
    const model = new MockLanguageModelV4({ doStream: [searchStep('neon pricing'), textStep('ok')] });
    await run(model);
    const secondCall = JSON.stringify(model.doStreamCalls[1]?.prompt);
    assert.match(secondCall, /\[1\] Neon pricing/);
    assert.match(secondCall, /\[2\] Neon blog/);
  });

  it('puts the date in the user timezone into the prompt', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('Hi!')] });
    await run(model);
    assert.match(JSON.stringify(model.doStreamCalls[0]?.prompt), /in the user's timezone, Europe\/London/);
  });

  it('forbids a third round of searching so the loop always ends in an answer', async () => {
    const model = new MockLanguageModelV4({
      doStream: [searchStep('neon pricing'), searchStep('neon changelog'), textStep('Answer [1].')],
    });
    const { result } = await run(model);
    assert.equal(model.doStreamCalls.length, 3);
    assert.equal(model.doStreamCalls[2]?.toolChoice?.type, 'none');
    assert.equal(result.text, 'Answer [1].');
  });

  it('answers small talk without being allowed to search', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('Hello! How can I help?')] });
    const { result, events } = await run(model, { allowSearch: false });
    assert.equal(model.doStreamCalls[0]?.toolChoice?.type, 'none');
    // The tool is still declared, so the cached prefix is the same for every intent.
    assert.equal(model.doStreamCalls[0]?.tools?.length, 1);
    assert.equal(events.some((e) => e.type === 'status' || e.type === 'sources'), false);
    assert.deepEqual(result.sources, []);
  });

  it('numbers pre-run searches first and continues the sequence for extra searches', async () => {
    const otherSearch: SearchProvider = {
      async search() {
        return [{ title: 'Supabase pricing', url: 'https://supabase.com/pricing', content: '', excerpt: '' }];
      },
    };
    const model = new MockLanguageModelV4({ doStream: [searchStep('supabase pricing'), textStep('Neon [1]; Supabase [3].')] });
    const { result } = await run(model, {
      search: otherSearch,
      searches: [{ query: 'neon pricing', results: await fakeSearch.search({ query: 'neon pricing' }) }],
    });
    const firstPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    assert.match(firstPrompt, /## Query: neon pricing/);
    assert.match(firstPrompt, /\[1\] Neon pricing/);
    assert.deepEqual(result.sources.map((s) => [s.n, s.title]), [
      [1, 'Neon pricing'],
      [3, 'Supabase pricing'],
    ]);
  });

  it('allows at most two extra searches, even when asked for three at once', async () => {
    let calls = 0;
    const counting: SearchProvider = {
      async search(request) {
        calls++;
        return fakeSearch.search(request);
      },
    };
    const model = new MockLanguageModelV4({ doStream: [searchStep('neon pricing', 'supabase pricing', 'render pricing'), textStep('Done [1].')] });
    await run(model, { search: counting });
    assert.equal(calls, 2);
    assert.match(JSON.stringify(model.doStreamCalls[1]?.prompt), /Search limit reached/);
  });

  it('passes the recalled record and the "since" date to the model', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('ok')] });
    await run(model, {
      context: {
        todayLabel: 'Wednesday 11 November 2026',
        todayIso: '2026-11-11',
        timeZone: 'Asia/Kolkata',
        sinceLabel: 'Monday 9 November 2026',
        record: '# Your record of past conversations\nNO RECORD for Monday 9 November 2026',
      },
    });
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    assert.match(prompt, /what changed since Monday 9 November 2026/);
    assert.match(prompt, /NO RECORD for Monday 9 November 2026/);
  });
});

describe('answer(): prompt layout and budgets', () => {
  type Block = { role: string; content: unknown };

  it('keeps the system prompt and history as a stable prefix, with per-request context in the newest user turn', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('ok')] });
    await run(model, {
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'What does Neon cost?' },
      ],
    });
    const call = model.doStreamCalls[0]!;
    const prompt = call.prompt as unknown as Block[];
    assert.deepEqual(prompt.map((b) => b.role), ['system', 'user', 'assistant', 'user']);
    // Only the fixed rules are system text, so they are identical on every request.
    assert.doesNotMatch(JSON.stringify(prompt[0]!.content), /Today is/);
    // Earlier turns are sent exactly as stored, so they repeat byte for byte next turn.
    assert.deepEqual(prompt[1]!.content, [{ type: 'text', text: 'earlier question' }]);
    // The newest turn carries the app's context first, then the user's own words.
    const parts = prompt[3]!.content as Array<{ text: string }>;
    assert.match(parts[0]!.text, /^# Context for this turn\nAdded by the app, not written by the user/);
    assert.equal(parts[1]!.text, 'What does Neon cost?');
    // Our web_search is the only tool: no built-in Google Search grounding.
    assert.deepEqual(call.tools?.map((t) => t.name), ['web_search']);
    assert.equal(JSON.stringify(call.providerOptions?.google ?? {}).includes('google_search'), false);
  });

  it('writes as soon as the extra searches are used up, instead of spending a round trip on a refused search', async () => {
    const model = new MockLanguageModelV4({ doStream: [searchStep('neon pricing', 'neon changelog'), textStep('Done [1].')] });
    await run(model);
    assert.equal(model.doStreamCalls.length, 2);
    assert.equal(model.doStreamCalls[1]?.toolChoice?.type, 'none');
  });

  const longResult = (i: number, url = `https://site${i}.com`) => ({ title: `T${i}`, url, content: 'snippet '.repeat(200), excerpt: 'excerpt '.repeat(400) });

  it('shares one text budget across pre-run results', async () => {
    const promptChars = async (queries: number) => {
      const model = new MockLanguageModelV4({ doStream: [textStep('ok')] });
      const searches = Array.from({ length: queries }, (_, q) => ({ query: `q${q}`, results: [0, 1, 2, 3, 4].map((i) => longResult(q * 10 + i)) }));
      await run(model, { searches });
      return JSON.stringify(model.doStreamCalls[0]!.prompt).length;
    };
    const two = await promptChars(2);
    const six = await promptChars(6);
    // Three times the results, but far less than three times the text.
    assert.ok(six < two * 1.6, `two queries: ${two} chars, six queries: ${six} chars`);
  });

  it('caps all search text near 4,000 tokens, follow-up searches included', async () => {
    const promptTokens = (call: { prompt: unknown }) => estimateTokens(JSON.stringify(call.prompt));
    const bare = new MockLanguageModelV4({ doStream: [textStep('ok')] });
    await run(bare, { allowSearch: false });

    const longSearch: SearchProvider = {
      async search({ query }) {
        return [0, 1, 2, 3, 4].map((i) => longResult(i, `https://${query.replace(/\W/g, '')}${i}.com`));
      },
    };
    const model = new MockLanguageModelV4({ doStream: [searchStep('extra one'), searchStep('extra two'), textStep('ok')] });
    const searches = Array.from({ length: 6 }, (_, q) => ({ query: `q${q}`, results: [0, 1, 2, 3, 4].map((i) => longResult(q * 10 + i)) }));
    await run(model, { searches, search: longSearch });
    const added = promptTokens(model.doStreamCalls[2]!) - promptTokens(bare.doStreamCalls[0]!);
    // 4,000 for results, plus headings, tool-call wrapping and JSON escaping
    // (which this rough count includes).
    // Without the shared budget this would be over 13,000.
    assert.ok(added < 5_000, `search text added ${added} tokens`);
  });

  it('keeps the passages of a long page that match the query when it has to cut', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `Company history paragraph ${i} about offices, teams and culture.`);
    const excerpt = [...filler, 'The Launch plan costs $19 per month with 10 GB of storage included.'].join('\n…\n');
    const model = new MockLanguageModelV4({ doStream: [textStep('ok')] });
    const searches = Array.from({ length: 6 }, (_, q) => ({
      query: 'neon launch plan price',
      results: [0, 1, 2, 3, 4].map((i) => ({ title: `T${q}${i}`, url: `https://n${q}${i}.com`, content: 'Neon pricing', excerpt })),
    }));
    await run(model, { searches });
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    assert.match(prompt, /Launch plan costs \$19 per month/);
    assert.doesNotMatch(prompt, /Company history paragraph 29/);
  });

  it('sends a page found by several queries only once', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('ok')] });
    const shared = longResult(1, 'https://compare.example.com/crm');
    await run(model, { searches: [{ query: 'a', results: [shared] }, { query: 'b', results: [shared] }] });
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    assert.equal(prompt.match(/URL: https:\/\/compare.example.com\/crm/g)?.length, 1);
    assert.match(prompt, /\[1\] T1 \(same page as above\)/);
  });
});

describe('SourceList', () => {
  it('keeps one number per page across searches', () => {
    const list = new SourceList();
    const a = list.add({ title: 'A', url: 'https://a.com/x', content: '', excerpt: '' });
    list.add({ title: 'B', url: 'https://b.com', content: '', excerpt: '' });
    const again = list.add({ title: 'A (again)', url: 'http://www.a.com/x/', content: '', excerpt: '' });
    assert.equal(again.n, a.n);
    assert.equal(list.size, 2);
  });
});

describe('citedNumbers()', () => {
  it('reads [n], [n][m] and [n, m]', () => {
    assert.deepEqual([...citedNumbers('a [1]. b [2][4]. c [3, 5].')].sort(), [1, 2, 3, 4, 5]);
  });

  it('rewrites gpt-oss citations such as 【3†L10-L12】 and leaves other brackets alone', () => {
    const rewriter = new CitationRewriter();
    const out = ['Price $19 【3†L10-', 'L12】 and 【1, 2】; a 【note】 stays.', ' Dangling 【'].map((c) => rewriter.push(c)).join('') + rewriter.flush();
    assert.equal(out, 'Price $19 [3] and [1, 2]; a 【note】 stays. Dangling 【');
  });

  it('turns gpt-oss style 【n】 citations into [n] as they stream, even split across chunks', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        searchStep('neon pricing'),
        {
          stream: textStep('x').stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type !== 'text-delta') return controller.enqueue(part);
                for (const delta of ['Launch is $19/month【', '1】.']) controller.enqueue({ ...part, delta });
              },
            }),
          ),
        },
      ],
    });
    const { result, events } = await run(model);
    assert.equal(result.text, 'Launch is $19/month[1].');
    assert.equal(events.filter((e) => e.type === 'token').map((e) => e.text).join(''), result.text);
    assert.deepEqual(result.sources.map((s) => s.n), [1]);
  });

  it('ignores markdown links and plain brackets', () => {
    assert.deepEqual([...citedNumbers('see [the docs](https://x.com) and [note]')], []);
  });
});
