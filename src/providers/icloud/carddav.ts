import { createDAVClient } from 'tsdav';
import type { DAVAddressBook } from 'tsdav';
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';

const SERVER_URL = 'https://contacts.icloud.com';

export interface AddressBookInfo {
  url: string;
  name: string;
  readOnly: boolean;
  syncToken?: string;
}

export interface CardObject {
  url: string;
  etag: string;
  data: string;
}

export interface SyncDelta {
  syncToken?: string;
  created: CardObject[];
  updated: CardObject[];
  deleted: string[];
}

export interface CardDavProvider {
  verify(): Promise<void>;
  listAddressBooks(): Promise<AddressBookInfo[]>;
  fetchAll(bookUrl: string): Promise<{ objects: CardObject[]; syncToken?: string }>;
  syncSince(bookUrl: string, syncToken: string): Promise<SyncDelta>;
  fetchOne(bookUrl: string, cardUrl: string): Promise<CardObject>;
  create(params: { bookUrl: string; filename: string; data: string }): Promise<{ url: string }>;
  update(params: { bookUrl: string; url: string; etag: string; data: string }): Promise<void>;
  remove(params: { bookUrl: string; url: string; etag: string }): Promise<void>;
}

/**
 * 措辞必须领域中立地点名通讯录工具（contacts_*），绝不能出现 calendar_*：
 * 阶段 2a 的整分支审查发现 caldav.ts 的提示全是日历口径，导致提醒事项失败时
 * 指引模型去调一个未注册的日历工具。这里从一开始就只提通讯录。
 */
/** 与 caldav.ts 同一处 tsdav 行为：登录 401 抛的是不带 status 的普通 Error，需从消息认出来。 */
const TSDAV_LOGIN_401 = /^Invalid credentials: .* returned 401\b/;

export function mapCardDavError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const status =
    (err as { status?: number }).status ??
    (err instanceof Error && TSDAV_LOGIN_401.test(err.message) ? 401 : undefined);

  if (status === 401) {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了 CardDAV 访问凭据', {
      hint: '确认 App 专用密码有效；CardDAV 使用 Apple ID 邮箱认证，而不是发信别名',
      cause: err,
    });
  }
  if (status === 403) {
    return new AppError('PERMISSION_DENIED', 'iCloud 拒绝了对该通讯录的写入', {
      hint: '换用 contacts_search 返回的另一个 address_book_id 重试，而不是重试同一个通讯录',
      cause: err,
    });
  }
  if (status === 404) {
    return new AppError('NOT_FOUND', '该联系人或通讯录不存在或已被删除', {
      hint: '重新调用 contacts_search 获取最新的 contact_id',
      cause: err,
    });
  }
  if (status === 412) {
    return new AppError('CONFLICT', '该联系人已被其他客户端修改', {
      hint: '重新读取该联系人后再提交修改',
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return new AppError('UPSTREAM_ERROR', 'iCloud CardDAV 服务暂时不可用', { retryable: true, cause: err });
  }
  return new AppError('UPSTREAM_ERROR', 'CardDAV 操作失败', { retryable: true, cause: err });
}

/** displayName 缺失时（实测账号即如此）用 url 的尾段兜底命名。 */
function addressBookName(book: { url: string; displayName?: string | Record<string, unknown> }): string {
  if (typeof book.displayName === 'string' && book.displayName.length > 0) return book.displayName;
  const trimmed = book.url.replace(/\/+$/, '');
  const tail = trimmed.split('/').pop();
  return tail && tail.length > 0 ? tail : book.url;
}

function toCardObject(raw: { url: string; etag?: string; data?: unknown }): CardObject {
  return {
    url: raw.url,
    etag: raw.etag ?? '',
    data: typeof raw.data === 'string' ? raw.data : '',
  };
}

/** CardDAV 认证用 account.email（Apple ID），与 IMAP 使用的 sender 不同——同 CalDAV，与 IMAP/SMTP 相反。 */
export function createCardDavProvider(deps: {
  account: AccountConfig;
  createClient?: typeof createDAVClient;
}): CardDavProvider {
  const { account } = deps;
  const createClientFn = deps.createClient ?? createDAVClient;
  type DavClient = Awaited<ReturnType<typeof createDAVClient>>;
  let clientPromise: Promise<DavClient> | undefined;

  const getClient = async (): Promise<DavClient> => {
    clientPromise ??= createClientFn({
      serverUrl: SERVER_URL,
      credentials: { username: account.email, password: account.appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'carddav',
    }).catch((err: unknown) => {
      clientPromise = undefined;
      throw mapCardDavError(err);
    });
    return clientPromise;
  };

  return {
    async verify() {
      const client = await getClient();
      try {
        await client.fetchAddressBooks();
      } catch (err) {
        throw mapCardDavError(err);
      }
    },

    async listAddressBooks() {
      const client = await getClient();
      try {
        // 账号下可能不止一个通讯簿，不能假设只有一个（实测账号只有一个，但不代表所有账号都是）。
        const books = await client.fetchAddressBooks();
        return books.map((book) => {
          const info: AddressBookInfo = {
            url: book.url,
            name: addressBookName(book),
            // 这里不做权限探测（不像 CalDAV 的 current-user-privilege-set /
            // applyPrivilegeFallback），永远报 false：真正的把关在写操作触发的
            // 403 走 mapCardDavError 那条路上。这意味着 Task 5 服务层的只读
            // 检查在当前实现下永远不会触发——保留那个检查是为了将来补上探测时
            // 服务层不需要改动，不是遗漏。
            readOnly: false,
          };
          if (typeof book.syncToken === 'string') info.syncToken = book.syncToken;
          return info;
        });
      } catch (err) {
        throw mapCardDavError(err);
      }
    },

    async fetchAll(bookUrl) {
      const client = await getClient();
      try {
        // 绝不能让 tsdav 替我们枚举整个集合：fetchVCards 在缺少 objectUrls 时
        // 内部会调用 addressBookQuery（tsdav.esm.js 里 vcardUrls 的兜底分支），
        // 而 iCloud 对 addressbook-query REPORT 一律返回 400。改用不带 syncToken
        // 的 sync-collection——按 RFC 6578，无 token 的 sync-collection REPORT
        // 会把整个集合当作"created"返回，外加一个新 token，一次往返内完成，
        // 和 syncSince 用的是同一条通路（同样要求 method: 'webdav'，否则
        // smartCollectionSyncDetailed 在 collection.reports 未填充时会默认
        // 退回 'basic'）。collection 必须带 objectMultiGet：tsdav 内部一旦发现
        // 有变更对象且集合没有这个函数就直接抛异常（实测账号已验证：缺了它，
        // 增量同步只要一有变更就炸，token-less 的全量同步反而不受影响，因为它
        // 走的是"全部当 created"分支——但仍然按官方要求补全，不留隐患）。
        const books = await client.fetchAddressBooks();
        const book = books.find((b) => b.url === bookUrl) ?? { url: bookUrl };
        const result = await client.smartCollectionSyncDetailed({
          collection: { ...book, syncToken: undefined, objectMultiGet: client.addressBookMultiGet },
          method: 'webdav',
        });
        const out: { objects: CardObject[]; syncToken?: string } = {
          objects: result.objects.created.map(toCardObject),
        };
        if (typeof result.syncToken === 'string') out.syncToken = result.syncToken;
        return out;
      } catch (err) {
        throw mapCardDavError(err);
      }
    },

    async syncSince(bookUrl, syncToken) {
      const client = await getClient();
      try {
        // objectMultiGet 同样不可省：一旦这次增量同步真的带回变更对象，
        // tsdav 会在没有它时直接抛"collection.objectMultiGet is required"——
        // 这条路径在没有变更时不会触发，容易被无变更的测试/首次运行掩盖。
        const result = await client.smartCollectionSyncDetailed({
          collection: { url: bookUrl, syncToken, objectMultiGet: client.addressBookMultiGet },
          method: 'webdav',
        });
        const delta: SyncDelta = {
          created: result.objects.created.map(toCardObject),
          updated: result.objects.updated.map(toCardObject),
          deleted: result.objects.deleted.map((o) => o.url),
        };
        if (typeof result.syncToken === 'string') delta.syncToken = result.syncToken;
        return delta;
      } catch (err) {
        throw mapCardDavError(err);
      }
    },

    async fetchOne(bookUrl, cardUrl) {
      const client = await getClient();
      try {
        const vcards = await client.fetchVCards({
          addressBook: { url: bookUrl } as DAVAddressBook,
          objectUrls: [cardUrl],
          useMultiGet: true,
        });
        const found = vcards[0];
        if (!found) {
          throw new AppError('NOT_FOUND', '该联系人或通讯录不存在或已被删除', {
            hint: '重新调用 contacts_search 获取最新的 contact_id',
          });
        }
        return toCardObject(found);
      } catch (err) {
        throw mapCardDavError(err);
      }
    },

    async create({ bookUrl, filename, data }) {
      const client = await getClient();
      try {
        const finalFilename = filename.endsWith('.vcf') ? filename : `${filename}.vcf`;
        const response = await client.createVCard({
          addressBook: { url: bookUrl } as DAVAddressBook,
          vCardString: data,
          filename: finalFilename,
        });
        if (!response.ok) throw mapCardDavError({ status: response.status });

        const url = response.url || response.headers.get('location') || `${bookUrl}${finalFilename}`;
        let etag = response.headers.get('etag') ?? '';
        if (!etag) {
          // createVCard 返回的 ETag 头 iCloud 不保证给全，回读一次确认卡片可取，
          // 绝不把空 etag 交给之后的写操作。
          const readback = await client.fetchVCards({
            addressBook: { url: bookUrl } as DAVAddressBook,
            objectUrls: [url],
            useMultiGet: true,
          });
          etag = readback[0]?.etag ?? '';
        }
        if (!etag) {
          throw new AppError('UPSTREAM_ERROR', '创建联系人后无法确认其 etag', {
            hint: '重新调用 contacts_search 确认联系人是否创建成功',
            retryable: true,
          });
        }
        return { url };
      } catch (err) {
        throw mapCardDavError(err);
      }
    },

    async update({ url, etag, data }) {
      const client = await getClient();
      try {
        const response = await client.updateVCard({ vCard: { url, etag, data } });
        if (!response.ok) throw mapCardDavError({ status: response.status });
      } catch (err) {
        throw mapCardDavError(err);
      }
    },

    async remove({ url, etag }) {
      const client = await getClient();
      try {
        const response = await client.deleteVCard({ vCard: { url, etag } });
        if (!response.ok) throw mapCardDavError({ status: response.status });
      } catch (err) {
        throw mapCardDavError(err);
      }
    },
  };
}
