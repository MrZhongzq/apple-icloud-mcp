import { createImapProvider } from './imap.js';
import { createSmtpProvider } from './smtp.js';
import { createCalDavProvider } from './caldav.js';
import type { AccountConfig } from '../../core/config.js';
import type { Logger } from '../../core/logger.js';
import type { SessionProviders } from '../../core/session.js';

export interface CreateProvidersOptions {
  logger?: Logger;
}

/** 真实 provider 组装点。测试通过替换 providerFactory 绕开它。 */
export function createProviders(account: AccountConfig, options: CreateProvidersOptions = {}): SessionProviders {
  return {
    imap: createImapProvider(account, { logger: options.logger }),
    smtp: createSmtpProvider(account),
    caldav: createCalDavProvider(account),
  };
}
