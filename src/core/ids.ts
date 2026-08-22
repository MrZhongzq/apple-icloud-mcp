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
