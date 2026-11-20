// Chat history of the AI shell (#612): one row per conversation holding the whole Messages API history. A
// conversation belongs to its owner; another user's ID never loads it.
import type Anthropic from '@anthropic-ai/sdk';

import type { Db } from './db.js';

export type Messages = Anthropic.MessageParam[];

export class ChatStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** The history of this owner's conversation, or null when there is none (or it is someone else's). */
  async load(id: string, owner: string): Promise<Messages | null> {
    const { rows } = await this.db.query<{ messages: Messages }>('select messages from chat_conversations where id = $1 and owner = $2', [id, owner]);
    return rows[0]?.messages ?? null;
  }

  async create(id: string, owner: string): Promise<void> {
    await this.db.query('insert into chat_conversations (id, owner, messages) values ($1, $2, $3::jsonb)', [id, owner, '[]']);
  }

  async save(id: string, owner: string, messages: Messages): Promise<void> {
    await this.db.query('update chat_conversations set messages = $3::jsonb, updated_at = now() where id = $1 and owner = $2', [id, owner, JSON.stringify(messages)]);
  }
}
