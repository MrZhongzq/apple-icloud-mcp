import { AppError } from '../../core/errors.js';
import { decodeRef, decodeUrl, encodeUrl } from '../../core/ids.js';
import { capabilityHint, type AccountConfig } from '../../core/config.js';
import {
  applyContactPatch,
  buildVCard,
  parseVCard,
  type Contact,
  type ContactInput,
} from '../../parsers/vcard.js';
import type { AddressBookInfo, CardDavProvider } from '../../providers/icloud/carddav.js';
import type { CachedBook, ContactsCache } from './cache.js';
import type { PartialFailure, SearchContactsParams, SearchContactsResult } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface UpdateOptions {
  expected_etag?: string;
}

export interface ContactService {
  search(params: SearchContactsParams): Promise<SearchContactsResult>;
  read(contactId: string): Promise<Contact>;
  create(input: ContactInput, addressBookId?: string): Promise<Contact>;
  update(contactId: string, patch: Partial<ContactInput>, options?: UpdateOptions): Promise<Contact>;
  remove(contactId: string, options?: UpdateOptions): Promise<{ deleted: true }>;
}

export interface ContactServiceDeps {
  account: AccountConfig;
  carddav: CardDavProvider;
  cache: ContactsCache;
}

function parseLimit(limit?: number): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new AppError('INVALID_INPUT', `limit 必须在 1 到 ${MAX_LIMIT} 之间`);
  }
  return value;
}

/** 去掉所有非数字字符——13800000000 和 +86 138 0000 0000 应当能互相匹配上，这是最常见的查询形态。 */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function includesCI(haystack: string | undefined, needleLower: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needleLower);
}

/**
 * 搜索的匹配范围：name.full/family/given、organization、department、title、
 * nickname、所有 emails[].value、所有 phones[].value、note。大小写不敏感的
 * 子串匹配；电话额外做一次去掉非数字字符后的子串匹配。
 */
function matchesQuery(contact: Contact, query: string): boolean {
  const needle = query.toLowerCase();

  if (includesCI(contact.name.full, needle)) return true;
  if (includesCI(contact.name.family, needle)) return true;
  if (includesCI(contact.name.given, needle)) return true;
  if (includesCI(contact.organization, needle)) return true;
  if (includesCI(contact.department, needle)) return true;
  if (includesCI(contact.title, needle)) return true;
  if (includesCI(contact.nickname, needle)) return true;
  if (includesCI(contact.note, needle)) return true;

  for (const email of contact.emails ?? []) {
    if (includesCI(email.value, needle)) return true;
  }

  const needleDigits = digitsOnly(query);
  for (const phone of contact.phones ?? []) {
    if (includesCI(phone.value, needle)) return true;
    if (needleDigits.length > 0 && digitsOnly(phone.value).includes(needleDigits)) return true;
  }

  return false;
}

export function createContactService(deps: ContactServiceDeps): ContactService {
  const { account, carddav, cache } = deps;

  const requireRead = (): void => {
    if (!account.capabilities.contactsRead) {
      throw new AppError('PERMISSION_DENIED', '该账号的通讯录读取权限未开启', {
        hint: capabilityHint(account, 'ALLOW_CONTACTS_READ'),
      });
    }
  };

  const requireWrite = (): void => {
    if (!account.capabilities.contactsWrite) {
      throw new AppError('PERMISSION_DENIED', '该账号的通讯录写入权限未开启', {
        hint: capabilityHint(account, 'ALLOW_CONTACTS_WRITE'),
      });
    }
  };

  /** 写操作前统一走这里：先解码 id（不发请求），再读回当前状态并校验乐观锁。 */
  const loadForWrite = async (contactId: string, expectedEtag?: string) => {
    const ref = decodeRef(contactId);
    const current = await carddav.fetchOne(ref.collectionUrl, ref.resourceUrl);
    if (expectedEtag !== undefined && current.etag !== expectedEtag) {
      throw new AppError('CONFLICT', '该联系人已被其他客户端修改', {
        hint: '重新调用 contacts_search 读取最新状态后再提交',
      });
    }
    return { ref, current };
  };

  return {
    async search(params) {
      requireRead();
      const limit = parseLimit(params.limit);

      // address_book_ids 是不透明 id，必须先解码成真实 url 再和 CachedBook.url 比对；
      // 直接拿不透明串去比较会静默匹配为空——不报错、不提示，只是返回零条。
      // 任何一个 id 解不开都要在触网之前就失败，而不是悄悄跳过。
      // 能解开但已经不存在的 id 同样不能静默降级成"这个人你没有"：与
      // calendar/service.ts 和 reminders/service.ts 一致，明确点出那个 id 并报 NOT_FOUND。
      const wantedUrls = params.address_book_ids?.map(decodeUrl);

      const { books, failures } = await cache.refresh();

      if (wantedUrls) {
        // 判断"存在"要把本次同步失败的通讯簿也算上（failures）：它确实存在，只是这次没读到，
        // 那属于 partial_failures 要报告的情况，不是"通讯簿不存在"。
        const known = new Set([...books.map((book) => book.url), ...failures.map((failure) => failure.url)]);
        const missing = wantedUrls.filter((url) => !known.has(url));
        if (missing.length > 0) {
          throw new AppError('NOT_FOUND', `以下 address_book_id 不对应任何通讯簿：${missing.map(encodeUrl).join('、')}`, {
            hint: '重新调用 contacts_search（不带 address_book_ids）获取当前有效的 address_book_id',
          });
        }
      }

      const selected = wantedUrls ? books.filter((book) => wantedUrls.includes(book.url)) : books;

      // 缓存层同步失败的通讯簿是 partial_failures 真正的来源：cache.refresh() 已经把
      // 失败原因带出来了，这里只需要转换成对外 id 形状。如果调用方按 address_book_ids
      // 过滤了范围，失败列表也按同样的范围过滤，不去报告调用方根本没问的那些通讯簿。
      const partial_failures: PartialFailure[] = failures
        .filter((failure) => wantedUrls === undefined || wantedUrls.includes(failure.url))
        .map((failure) => ({ address_book_id: encodeUrl(failure.url), name: failure.name, reason: failure.reason }));

      // 跨通讯簿 Promise.allSettled：这是缓存层隔离之外的第二道防线——纵深防御，
      // 不指望它在今天的实现下真的会触发（cache.refresh() 返回的都是已解析好的
      // Contact[]，匹配阶段几乎不会抛），但成本为零，留着以防匹配逻辑将来出错。
      const settled = await Promise.allSettled(
        selected.map(async (book: CachedBook) => {
          const matched: Contact[] = [];
          // 通讯簿内部逐张卡 try/catch：单张卡片的匹配异常只跳过这一张，不拖累整本通讯簿。
          for (const contact of book.cards.values()) {
            try {
              if (params.query === undefined || matchesQuery(contact, params.query)) {
                matched.push(contact);
              }
            } catch {
              // 单张卡片匹配失败，跳过即可。
            }
          }
          return matched;
        }),
      );

      const contacts: Contact[] = [];
      settled.forEach((outcome, index) => {
        const book = selected[index]!;
        if (outcome.status === 'fulfilled') {
          contacts.push(...outcome.value);
        } else {
          const reason = outcome.reason instanceof AppError ? outcome.reason.message : '未知错误';
          partial_failures.push({ address_book_id: encodeUrl(book.url), name: book.name, reason });
        }
      });

      // 排序必须在截断之前：否则 limit 切出来的是任意子集，模型据此回答
      // "我有没有联系人 X" 就可能得到一个自信的错误答案。
      const sorted = [...contacts].sort((a, b) => a.name.full.localeCompare(b.name.full));

      const result: SearchContactsResult = { contacts: sorted.slice(0, limit) };
      if (sorted.length > limit) result.truncated = true;
      if (partial_failures.length > 0) result.partial_failures = partial_failures;
      return result;
    },

    async read(contactId) {
      requireRead();
      const ref = decodeRef(contactId);
      const card = await carddav.fetchOne(ref.collectionUrl, ref.resourceUrl);
      return parseVCard(card.data, ref);
    },

    async create(input, addressBookId) {
      requireWrite();

      const books = await carddav.listAddressBooks();

      let target: AddressBookInfo | undefined;
      if (addressBookId) {
        const url = decodeUrl(addressBookId);
        target = books.find((b) => b.url === url);
        if (!target) {
          throw new AppError('NOT_FOUND', '找不到该通讯簿', {
            hint: '调用 contacts_search 查看可用的 address_book_id',
          });
        }
        if (target.readOnly) {
          throw new AppError('PERMISSION_DENIED', '该通讯簿是只读的，无法写入', {
            hint: '换一个可写的 address_book_id，参考 contacts_search 返回的结果',
          });
        }
      } else {
        target = books.find((b) => !b.readOnly);
        if (!target) {
          throw new AppError('PERMISSION_DENIED', '没有可写入的通讯簿', {
            hint: '先调用 contacts_search 查看可用的 address_book_id',
          });
        }
      }

      const { vcard, uid } = buildVCard(input);
      const created = await carddav.create({ bookUrl: target.url, filename: `${uid}.vcf`, data: vcard });
      cache.invalidate(target.url);
      return parseVCard(vcard, { collectionUrl: target.url, resourceUrl: created.url });
    },

    async update(contactId, patch, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(contactId, options.expected_etag);

      // 原地补丁而非按模型重建——重建会把 PHOTO/X-ABRELATEDNAMES/X-SOCIALPROFILE/
      // X-APPLE-* 等我们的领域模型未覆盖的属性静默丢弃，这是用户的真实联系人数据，
      // 尤其是头像：Contact 只暴露 has_photo 布尔值，模型里压根没有头像数据可用来重建。
      const data = applyContactPatch(current.data, patch);
      await carddav.update({ bookUrl: ref.collectionUrl, url: ref.resourceUrl, etag: current.etag, data });
      cache.invalidate(ref.collectionUrl);

      return parseVCard(data, ref);
    },

    async remove(contactId, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(contactId, options.expected_etag);
      await carddav.remove({ bookUrl: ref.collectionUrl, url: ref.resourceUrl, etag: current.etag });
      cache.invalidate(ref.collectionUrl);
      return { deleted: true };
    },
  };
}
