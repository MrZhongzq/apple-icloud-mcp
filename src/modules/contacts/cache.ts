import type { Logger } from '../../core/logger.js';
import { parseVCard, type Contact } from '../../parsers/vcard.js';
import type { CardDavProvider, CardObject } from '../../providers/icloud/carddav.js';

export interface CachedBook {
  url: string;
  name: string;
  readOnly: boolean;
  syncToken?: string;
  /** key 是卡片 url。 */
  cards: Map<string, Contact>;
  loadedAt: number;
}

export interface ContactsCache {
  /** 首次调用做全量拉取；之后带 token 走增量。返回刷新后的全部通讯簿。 */
  refresh(): Promise<CachedBook[]>;
  /** 只读当前快照，不触网。缓存未建立时返回空数组。 */
  snapshot(): CachedBook[];
  /** 写操作之后让某个通讯簿失效，下次 refresh 会重新同步它。 */
  invalidate(bookUrl: string): void;
  size(): number;
}

/** 把一批 CardObject 逐张解析进 cards；单张解析失败就地吞掉计数，绝不拖累同批其它卡片。 */
function parseCardsInto(
  cards: Map<string, Contact>,
  objects: CardObject[],
  bookUrl: string,
  logger: Logger,
): void {
  for (const object of objects) {
    try {
      const contact = parseVCard(object.data, { collectionUrl: bookUrl, resourceUrl: object.url });
      cards.set(object.url, contact);
    } catch (err) {
      logger.warn('联系人卡片解析失败，已跳过', {
        bookUrl,
        cardUrl: object.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function createContactsCache(deps: { carddav: CardDavProvider; logger: Logger }): ContactsCache {
  const { carddav, logger } = deps;
  const books = new Map<string, CachedBook>();

  const fullFetch = async (
    info: { url: string; name: string; readOnly: boolean },
    reason: string,
  ): Promise<CachedBook> => {
    logger.info('通讯簿走全量拉取', { bookUrl: info.url, reason });
    const { objects, syncToken } = await carddav.fetchAll(info.url);
    const cards = new Map<string, Contact>();
    parseCardsInto(cards, objects, info.url, logger);
    const book: CachedBook = {
      url: info.url,
      name: info.name,
      readOnly: info.readOnly,
      cards,
      loadedAt: Date.now(),
    };
    if (syncToken !== undefined) book.syncToken = syncToken;
    return book;
  };

  const incrementalSync = async (
    info: { url: string; name: string; readOnly: boolean },
    existing: CachedBook,
    syncToken: string,
  ): Promise<CachedBook> => {
    const delta = await carddav.syncSince(info.url, syncToken);
    const cards = new Map(existing.cards);
    for (const url of delta.deleted) cards.delete(url);
    parseCardsInto(cards, delta.created, info.url, logger);
    parseCardsInto(cards, delta.updated, info.url, logger);
    const book: CachedBook = {
      url: info.url,
      name: info.name,
      readOnly: info.readOnly,
      cards,
      loadedAt: Date.now(),
    };
    if (delta.syncToken !== undefined) book.syncToken = delta.syncToken;
    return book;
  };

  return {
    async refresh() {
      const infos = await carddav.listAddressBooks();

      const settled = await Promise.allSettled(
        infos.map(async (info) => {
          const existing = books.get(info.url);
          if (existing?.syncToken !== undefined) {
            return incrementalSync(info, existing, existing.syncToken);
          }
          // 服务器没给 syncToken（首次同步，或写操作后被 invalidate）：明确走全量，
          // 不要静默当成"无变更"。
          const reason = existing ? '通讯簿没有可用的 syncToken' : '首次拉取';
          return fullFetch(info, reason);
        }),
      );

      const refreshed: CachedBook[] = [];
      const currentUrls = new Set(infos.map((info) => info.url));
      settled.forEach((outcome, index) => {
        const info = infos[index]!;
        if (outcome.status === 'fulfilled') {
          books.set(info.url, outcome.value);
          refreshed.push(outcome.value);
        } else {
          logger.error('通讯簿同步失败，已跳过', {
            bookUrl: info.url,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
          // 单个通讯簿同步失败不得拖垮其余通讯簿；保留旧快照（如果有）供搜索继续使用，
          // 但不计入本次 refresh 的返回值。
        }
      });

      // 服务器已不再报告的通讯簿从缓存里摘掉，避免搜索命中已经不存在的通讯簿。
      for (const url of [...books.keys()]) {
        if (!currentUrls.has(url)) books.delete(url);
      }

      return refreshed;
    },

    snapshot() {
      return [...books.values()];
    },

    invalidate(bookUrl) {
      const book = books.get(bookUrl);
      if (!book) return;
      // 只清 syncToken，保留 cards：万一下次全量拉取失败，旧数据仍可用于搜索。
      delete book.syncToken;
    },

    size() {
      let total = 0;
      for (const book of books.values()) total += book.cards.size;
      return total;
    },
  };
}
