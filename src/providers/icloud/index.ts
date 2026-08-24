import { createImapProvider } from './imap.js';
import { createSmtpProvider } from './smtp.js';
import { createCalDavProvider } from './caldav.js';
import { createCardDavProvider } from './carddav.js';
import type { AccountConfig } from '../../core/config.js';
import type { Logger } from '../../core/logger.js';
import type { SessionProviders } from '../../core/session.js';

export interface CreateProvidersOptions {
  logger?: Logger;
  /** IMAP 空闲多久后主动断开重连（毫秒）；缺省沿用 createImapProvider 的 300s 默认值。 */
  imapIdleTimeoutMs?: number;
}

/** 真实 provider 组装点。测试通过替换 providerFactory 绕开它。 */
export function createProviders(account: AccountConfig, options: CreateProvidersOptions = {}): SessionProviders {
  return {
    imap: createImapProvider(account, { logger: options.logger, idleTimeoutMs: options.imapIdleTimeoutMs }),
    smtp: createSmtpProvider(account),
    caldav: createCalDavProvider(account),
    carddav: createCardDavProvider({ account }),
  };
}
