import type { EmailAddress } from '../../parsers/mime.js';
import type { SearchCriteria } from '../../providers/icloud/imap.js';

export interface MessageSummary {
  uid: number;
  date: string;
  from?: EmailAddress;
  to: EmailAddress[];
  subject: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface SearchResult {
  messages: MessageSummary[];
  nextCursor?: string;
}

export interface SearchParams {
  folder?: string;
  query?: SearchCriteria;
  limit?: number;
  cursor?: string;
}
