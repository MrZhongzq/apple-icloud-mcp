import { AppError } from './errors.js';

export interface ResourceRef {
  collectionUrl: string;
  resourceUrl: string;
}

const SEPARATOR = '|';

const MALFORMED_HINT = '请使用列表类工具返回的 id 原值，不要自行构造或截断';

export function encodeRef(ref: ResourceRef): string {
  return Buffer.from(`${ref.collectionUrl}${SEPARATOR}${ref.resourceUrl}`, 'utf8').toString('base64url');
}

export function decodeRef(id: string): ResourceRef {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const index = decoded.indexOf(SEPARATOR);
  if (index <= 0 || index === decoded.length - 1) {
    throw new AppError('INVALID_INPUT', '资源 ID 格式不正确', { hint: MALFORMED_HINT });
  }

  const collectionUrl = decoded.slice(0, index);
  const resourceUrl = decoded.slice(index + 1);
  if (!collectionUrl.startsWith('http') || !resourceUrl.startsWith('http')) {
    throw new AppError('INVALID_INPUT', '资源 ID 格式不正确', { hint: MALFORMED_HINT });
  }

  return { collectionUrl, resourceUrl };
}

export function encodeUrl(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

/**
 * 集合 id（calendar_id / list_id / address_book_id）的解码。措辞与 decodeRef 一样保持
 * 领域中立：日历、提醒、通讯录三侧都调用这里，而这一层无从知道当前注册了哪些工具——
 * 一个只开提醒的账号收到"请使用 calendar_list 返回的值"就是被指向了一个不存在的工具。
 * 所以 hint 必须把**每一个**调用方所在域的列表类工具都点到；新增调用方时一并补进来
 * （tests/unit/core/ids.test.ts 会按 src/modules 里实际的 decodeUrl 调用方核对这一点）。
 */
export function decodeUrl(id: string): string {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  if (!decoded.startsWith('http')) {
    throw new AppError('INVALID_INPUT', '集合 ID 格式不正确', {
      hint: '请使用 calendar_list、reminders_lists 或 contacts_search 返回的 id 原值，不要自行构造或截断',
    });
  }
  return decoded;
}
