import { describe, it, expect } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { mapImapError, createImapProvider, toImapFlowLogger } from '../../../src/providers/icloud/imap.js';
import { createLogger } from '../../../src/core/logger.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';

const account: AccountConfig = {
  id: 'account_1',
  email: 'user@icloud.com',
  sender: 'user@icloud.com',
  label: 'user@icloud.com',
  appPassword: 'app-specific-password',
  capabilities: {
    mailRead: true,
    mailWrite: true,
    calendarRead: true,
    calendarWrite: true,
    remindersRead: true,
    remindersWrite: true,
    contactsRead: true,
    contactsWrite: true,
  },
};

describe('mapImapError', () => {
  it('maps authentication failures to AUTH_FAILED with an actionable hint', () => {
    const mapped = mapImapError(Object.assign(new Error('Invalid credentials'), {
      authenticationFailed: true,
    }));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe('AUTH_FAILED');
    expect(mapped.retryable).toBe(false);
    expect(mapped.hint).toContain('App 专用密码');
  });

  it('maps network errors to a retryable UPSTREAM_ERROR', () => {
    const mapped = mapImapError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a missing mailbox to NOT_FOUND', () => {
    const mapped = mapImapError(new Error('Mailbox does not exist'));
    expect(mapped.code).toBe('NOT_FOUND');
  });

  it('never leaks the original message for unknown failures', () => {
    const mapped = mapImapError(new Error('LOGIN user pass=abcd-efgh'));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.message).not.toContain('abcd-efgh');
  });
});

describe('createImapProvider connection reuse', () => {
  it('shares one connection attempt across concurrent callers', async () => {
    let built = 0;
    let resolveConnect: (() => void) | undefined;
    const fakeClient = {
      usable: true,
      connect: () => new Promise<void>((resolve) => { resolveConnect = resolve; }),
      noop: async () => undefined,
      logout: async () => undefined,
      close: () => undefined,
    };

    const provider = createImapProvider(account, {
      createClient: () => {
        built += 1;
        return fakeClient as unknown as ImapFlow;
      },
    });

    const both = Promise.all([provider.verify(), provider.verify()]);
    resolveConnect!();
    await both;

    expect(built).toBe(1);
  });
});

/**
 * imapflow signals a server NO/BAD by *returning* false from these commands, not by
 * throwing (verified against the pinned node_modules/imapflow source). A provider that
 * merely awaits-and-discards the return value reports fabricated success on a failed
 * mutation, or a false "empty"/"zero" result on a failed read (search/status).
 */
function makeFakeClient(overrides: Record<string, unknown> = {}) {
  return {
    usable: true,
    connect: async () => undefined,
    noop: async () => undefined,
    logout: async () => undefined,
    close: () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    list: async () => [{ path: 'INBOX', name: 'INBOX', specialUse: undefined }],
    status: async () => false,
    search: async () => false,
    messageFlagsAdd: async () => false,
    messageFlagsRemove: async () => false,
    messageMove: async () => false,
    messageDelete: async () => false,
    fetch: async function* () {
      /* no messages */
    },
    ...overrides,
  } as unknown as ImapFlow;
}

describe('toImapFlowLogger', () => {
  it('never writes directly to stdout/stderr -- everything routes through the project Logger', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (line) => lines.push(line));
    const imapFlowLogger = toImapFlowLogger(logger);

    imapFlowLogger.debug({ msg: 'debug frame' });
    imapFlowLogger.info({ msg: 'info frame', password: 'hunter2' });
    imapFlowLogger.warn({ msg: 'warn frame' });
    imapFlowLogger.error({ msg: 'error frame' });

    expect(lines).toHaveLength(4);
    expect(lines.every((l) => JSON.parse(l).level === 'debug')).toBe(true);
  });

  it('is silent when the logger threshold is above debug (imapflow logs can be verbose)', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (line) => lines.push(line));
    const imapFlowLogger = toImapFlowLogger(logger);

    imapFlowLogger.info({ msg: 'should not surface at info threshold' });

    expect(lines).toHaveLength(0);
  });

  it('redacts credential-shaped fields before they reach the log line', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (line) => lines.push(line));
    const imapFlowLogger = toImapFlowLogger(logger);

    imapFlowLogger.debug({ auth: { pass: 'app-specific-password' } });

    expect(lines[0]).not.toContain('app-specific-password');
  });
});

describe('createImapProvider surfaces imapflow false-return failures', () => {
  it('rejects setFlags when messageFlagsAdd reports failure', async () => {
    const provider = createImapProvider(account, { createClient: () => makeFakeClient() });
    await expect(provider.setFlags('INBOX', [1], ['\\Seen'], true)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('rejects setFlags when messageFlagsRemove reports failure', async () => {
    const provider = createImapProvider(account, { createClient: () => makeFakeClient() });
    await expect(provider.setFlags('INBOX', [1], ['\\Seen'], false)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('rejects moveMessages when messageMove reports failure', async () => {
    const provider = createImapProvider(account, { createClient: () => makeFakeClient() });
    await expect(provider.moveMessages('INBOX', [1], 'Archive')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('rejects expunge when messageDelete reports failure', async () => {
    const provider = createImapProvider(account, { createClient: () => makeFakeClient() });
    await expect(provider.expunge('INBOX', [1])).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('rejects searchUids when SEARCH itself fails (false), rather than reporting zero matches', async () => {
    const provider = createImapProvider(account, { createClient: () => makeFakeClient() });
    await expect(provider.searchUids('INBOX', {})).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('does not confuse a genuinely empty SEARCH result with a failure', async () => {
    const provider = createImapProvider(account, {
      createClient: () => makeFakeClient({ search: async () => [] }),
    });
    await expect(provider.searchUids('INBOX', {})).resolves.toEqual([]);
  });

  it('rejects listFolders when STATUS reports failure, rather than reporting an empty/read folder', async () => {
    const provider = createImapProvider(account, { createClient: () => makeFakeClient() });
    await expect(provider.listFolders()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
