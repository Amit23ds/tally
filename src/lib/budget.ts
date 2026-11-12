// How much text the answer model is given. Input size drives time to first
// token on every provider, and Groq's free tier allows only ~8,000 tokens a
// minute, so the prompt has to stay well under that.
export const TOKEN_BUDGET = {
  // One search result: its snippet plus the most relevant part of the page.
  searchResult: 600,
  // All search results in one answer, planned and follow-up searches together.
  searchContext: 4_000,
  // The "record of past conversations" section.
  memory: 1_500,
} as const;

// English prose with some markup averages about four characters per token on
// both Gemini's and Groq's tokenizers. Close enough for a budget; an exact
// count would need each provider's tokenizer and a round trip.
const CHARS_PER_TOKEN = 4;

export const tokensToChars = (tokens: number): number => tokens * CHARS_PER_TOKEN;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);
