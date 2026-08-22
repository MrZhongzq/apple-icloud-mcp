import { createImapProvider } from './imap.js';
import { createSmtpProvider } from './smtp.js';
import { createCalDavProvider } from './caldav.js';
import type { AccountConfig } from '../../core/config.js';
import type { SessionProviders } from '../../core/session.js';

/** 真实 provider 组装点。测试通过替换 providerFactory 绕开它。 */
export function createProviders(account: AccountConfig): SessionProviders {
  return {
    imap: createImapProvider(account),
    smtp: createSmtpProvider(account),
    caldav: createCalDavProvider(account),
  };
}
