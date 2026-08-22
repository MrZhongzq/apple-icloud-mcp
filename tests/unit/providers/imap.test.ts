import { describe, it, expect } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { mapImapError, createImapProvider, toImapFlowLogger, toImapQuery } from '../../../src/providers/icloud/imap.js';
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

describe('toImapQuery', () => {
  it('maps unseen: true to seen: false', () => {
    expect(toImapQuery({ unseen: true })).toMatchObject({ seen: false });
  });

  it('maps unseen: false to seen: true, instead of dropping the criterion', () => {
    expect(toImapQuery({ unseen: false })).toMatchObject({ seen: true });
  });

  it('maps flagged: true to flagged: true', () => {
    expect(toImapQuery({ flagged: true })).toMatchObject({ flagged: true });
  });

  it('maps flagged: false to flagged: false, instead of dropping the criterion', () => {
    expect(toImapQuery({ flagged: false })).toMatchObject({ flagged: false });
  });

  it('falls back to {all: true} only when no criterion at all was given', () => {
    expect(toImapQuery({})).toEqual({ all: true });
  });
});

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

describe('createImapProvider idle timeout (I7)', () => {
  /**
   * Spec §4.2 requires an idle IMAP connection to close and transparently reconnect.
   * Implemented lazily: on the next operation, if the connection has been idle longer
   * than idleTimeoutMs, close it before reconnecting -- there is no background timer.
   */
  function makeCountingClient(onLogout: () => void) {
    return {
      usable: true,
      connect: async () => undefined,
      noop: async () => undefined,
      logout: async () => onLogout(),
      close: () => undefined,
    };
  }

  it('closes and transparently reconnects once idle longer than idleTimeoutMs', async () => {
    let built = 0;
    let closed = 0;
    let now = 0;
    const provider = createImapProvider(account, {
      createClient: () => {
        built += 1;
        return makeCountingClient(() => {
          closed += 1;
        }) as unknown as ImapFlow;
      },
      idleTimeoutMs: 1_000,
      now: () => now,
    });

    await provider.verify();
    expect(built).toBe(1);

    now += 500; // well within the 1000ms idle timeout
    await provider.verify();
    expect(built).toBe(1);
    expect(closed).toBe(0);

    now += 1_500; // idle past the timeout since the last operation
    await provider.verify();
    expect(built).toBe(2);
    expect(closed).toBe(1);
  });

  it('does not reconnect when operations stay within the idle window', async () => {
    let built = 0;
    let now = 0;
    const provider = createImapProvider(account, {
      createClient: () => {
        built += 1;
        return makeCountingClient(() => undefined) as unknown as ImapFlow;
      },
      idleTimeoutMs: 1_000,
      now: () => now,
    });

    await provider.verify();
    for (let i = 0; i < 5; i++) {
      now += 400; // each step is under the timeout, resets the idle clock
      await provider.verify();
    }
    expect(built).toBe(1);
  });

  it('defaults to a 300s idle timeout when none is configured', async () => {
    let built = 0;
    let now = 0;
    const provider = createImapProvider(account, {
      createClient: () => {
        built += 1;
        return makeCountingClient(() => undefined) as unknown as ImapFlow;
      },
      now: () => now,
    });

    await provider.verify();
    now += 299_000; // just under the documented 300s default, measured from the last op
    await provider.verify();
    expect(built).toBe(1);

    now += 300_001; // now past 300s since *that* last operation
    await provider.verify();
    expect(built).toBe(2);
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

  it('isolates a single folder whose STATUS fails, rather than reporting it as empty/read (I1)', async () => {
    // I1: listFolders isolates per folder -- a bad STATUS for one folder is reported as
    // a failure for that folder specifically, not silently zeroed and not a blanket
    // rejection that would also hide every other, healthy folder's status.
    const provider = createImapProvider(account, {
      createClient: () =>
        makeFakeClient({
          list: async () => [
            { path: 'INBOX', name: 'INBOX', specialUse: undefined },
            { path: 'Broken', name: 'Broken', specialUse: undefined },
          ],
          status: async (path: string) =>
            path === 'Broken' ? false : { path, messages: 3, unseen: 1 },
        }),
    });

    const result = await provider.listFolders();

    expect(result.folders).toEqual([{ path: 'INBOX', name: 'INBOX', total: 3, unseen: 1 }]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.path).toBe('Broken');
    expect(result.failures[0]!.reason).toBeTruthy();
  });

  it('reports every folder as a failure when STATUS fails for all of them, without throwing', async () => {
    const provider = createImapProvider(account, { createClient: () => makeFakeClient() });
    const result = await provider.listFolders();
    expect(result.folders).toEqual([]);
    expect(result.failures).toEqual([{ path: 'INBOX', reason: expect.any(String) }]);
  });

  it('still throws when the connection itself cannot list folders at all', async () => {
    const provider = createImapProvider(account, {
      createClient: () =>
        makeFakeClient({
          list: async () => {
            throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
          },
        }),
    });
    await expect(provider.listFolders()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
