import { randomUUID } from 'node:crypto';
import { openDb, type Db } from '../lib/db.ts';

// Runs `write` with the clock pinned, so stored timestamps are predictable.
export function at<T>(iso: string, write: () => T): T {
  const original = process.env.NOW;
  process.env.NOW = iso;
  try {
    return write();
  } finally {
    if (original === undefined) delete process.env.NOW;
    else process.env.NOW = original;
  }
}

export interface History {
  db: Db;
  currentConversation: string;
  // The message being answered, sent on Wednesday 11 November 2026 (IST).
  currentMessageId: number;
}

// Past conversations at known times, as seen from India:
// - Tue 3 Nov 14:30: Postgres hosting, with claims about Neon and Supabase
// - Mon 9 Nov 10:00: a CRM shortlist, without claims
// - Wed 11 Nov 12:00: the conversation currently being answered
export function seedHistory(message = 'What did I ask you on 3 November?'): History {
  const db = openDb(':memory:');
  const postgres = randomUUID();
  const crm = randomUUID();
  const currentConversation = randomUUID();

  at('2026-11-03T09:00:00Z', () => {
    db.ensureConversation(postgres, 'Postgres hosting');
    db.addMessage(postgres, 'user', 'Which Postgres hosting is cheapest for a side project?');
    const answerId = db.addMessage(postgres, 'assistant', 'Neon Launch costs $19 per month [1]. Supabase Pro is $25 per month [2].');
    db.addClaims(answerId, [
      { entity: 'Neon', attribute: 'Launch plan price', value: '$19 per month', source_url: 'https://neon.com/pricing', as_of: '2026-11-03' },
      { entity: 'Supabase', attribute: 'Pro plan price', value: '$25 per month', source_url: 'https://supabase.com/pricing', as_of: '2026-11-03' },
    ]);
  });
  at('2026-11-09T04:30:00Z', () => {
    db.ensureConversation(crm, 'CRM shortlist');
    db.addMessage(crm, 'user', 'Shortlist CRM tools for a 20-person sales team');
    db.addMessage(crm, 'assistant', 'HubSpot, Pipedrive, Close, Attio and Salesforce [1].');
  });
  const currentMessageId = at('2026-11-11T06:30:00Z', () => {
    db.ensureConversation(currentConversation, message);
    return db.addMessage(currentConversation, 'user', message);
  });
  return { db, currentConversation, currentMessageId };
}
