import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMailService } from '../modules/mail/service.js';
import { createCalendarService } from '../modules/calendar/service.js';
import { createReminderService } from '../modules/reminders/service.js';
import { registerMailTools } from '../modules/mail/tools.js';
import { registerCalendarTools } from '../modules/calendar/tools.js';
import { registerReminderTools } from '../modules/reminders/tools.js';
import { registerSessionTools } from '../modules/session/tools.js';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { Session, SessionStore } from '../core/session.js';
import type { ToolRegistrar } from './types.js';

export interface ServerDeps {
  config: AppConfig;
  sessions: SessionStore;
  logger: Logger;
}

export function registerAllTools(server: ToolRegistrar, deps: ServerDeps): void {
  const { config, sessions, logger } = deps;

  registerSessionTools(server, { sessions, logger, config });

  const anyMail = config.accounts.some(
    (a) => a.capabilities.mailRead || a.capabilities.mailWrite,
  );
  const anyCalendar = config.accounts.some(
    (a) => a.capabilities.calendarRead || a.capabilities.calendarWrite,
  );
  const anyReminders = config.accounts.some(
    (a) => a.capabilities.remindersRead || a.capabilities.remindersWrite,
  );

  if (anyMail) {
    registerMailTools(server, {
      sessions,
      logger,
      mailFor: (session: Session) =>
        createMailService({
          account: session.account,
          imap: session.providers.imap,
          smtp: session.providers.smtp,
        }),
    });
  }

  if (anyCalendar) {
    registerCalendarTools(server, {
      sessions,
      logger,
      calendarFor: (session: Session) =>
        createCalendarService({ account: session.account, caldav: session.providers.caldav }),
    });
  }

  if (anyReminders) {
    registerReminderTools(server, {
      sessions,
      logger,
      reminderFor: (session: Session) =>
        createReminderService({ account: session.account, caldav: session.providers.caldav }),
    });
  }
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'apple-icloud-mcp', version: '2.0.0' });
  registerAllTools(server, deps);
  return server;
}
