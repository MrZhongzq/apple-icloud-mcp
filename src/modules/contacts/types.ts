import type { Contact } from '../../parsers/vcard.js';

/** 某个通讯簿读取失败时出现；其余通讯簿的结果仍然完整返回。 */
export interface PartialFailure {
  address_book_id: string;
  name: string;
  reason: string;
}

export interface SearchContactsParams {
  query?: string;
  address_book_ids?: string[];
  limit?: number;
}

export interface SearchContactsResult {
  /** 按 name.full 的 localeCompare 升序排列，再截断到 limit。 */
  contacts: Contact[];
  /** 命中数超过 limit 时为 true。 */
  truncated?: boolean;
  /** 某个通讯簿读取失败时出现；其余通讯簿的结果仍然完整返回。 */
  partial_failures?: PartialFailure[];
}
