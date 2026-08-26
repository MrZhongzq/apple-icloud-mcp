import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const NEWLINE = String.fromCharCode(10);

/**
 * `src/bin/cli.ts` 是这个仓库里唯一一个"加载即执行"的面：它没法被 import 进
 * 测试，所以此前一个测试都没有——task-3 的审阅把它称为"剩下的唯一一条边界
 * （不是洞）"，而它里面确实有一个洞（dotenv 往 stdout 打横幅）。
 *
 * 所以这里真的把它当子进程跑起来。`node --import tsx` 直接跑 TypeScript 源码，
 * 不依赖 dist/——测试不该要求先 build。
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'bin', 'cli.ts');
// 必须解析成绝对路径再传给 `--import`：子进程的 cwd 是那个临时目录（
// loadDotEnvIfPresent 读的就是 cwd 下的 .env），裸写 `--import tsx` 会从那里
// 去找包，找不到。
const TSX_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
      cwd,
      // 只保留必要的宿主环境：把当前进程的 ICLOUD_* 之类带进去会让被测的 .env
      // 行为变得不可预测（loadDotEnvIfPresent 用的是 override: false）。
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-bin-'));
  writeFileSync(
    join(dir, '.env'),
    ['ICLOUD_ACCOUNT_1=smoke@icloud.com', 'ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop', ''].join(NEWLINE),
    'utf8',
  );
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bin/cli.ts as a real process', () => {
  it(
    'writes nothing but result JSON to stdout when a .env is loaded',
    async () => {
      // 这条性质在这一阶段的散文里被断言过四次，一次都没有被断言进代码——
      // 而真正违反它的是 dotenv 的一个默认值：`import 'dotenv/config'` 默认
      // quiet，显式的 `dotenv.config({...})` 不默认 quiet，于是每一次带 .env
      // 的调用都往 stdout 打一行 `◇ injected env (2) from .env …`，
      // `out=$(cli …); echo "$out" | jq` 直接 SyntaxError。
      const res = await runCli(dir, ['apple_accounts']);
      expect(res.code).toBe(0);
      expect(() => JSON.parse(res.stdout), `stdout 必须整体是合法 JSON，实际开头是：${res.stdout.slice(0, 80)}`).not.toThrow();
      const parsed = JSON.parse(res.stdout) as Array<{ email: string }>;
      expect(parsed[0]?.email).toBe('smoke@icloud.com');
    },
    60_000,
  );

  it(
    'stop works when .env is broken — closing a socket needs no credentials',
    async () => {
      // SKILL.md 让无人值守的 agent 把 cli stop 无条件放在收尾处。stop 若排在
      // loadConfig 之后，一个坏掉的 .env（改了一半、变量名打错、密码轮换中）
      // 就会让一个仍然活着、仍握着已认证 IMAP 连接的守护进程再也停不掉。
      writeFileSync(join(dir, '.env'), 'ICLOUD_ACCOUNT_1=smoke@icloud.com' + NEWLINE, 'utf8');
      const res = await runCli(dir, ['stop'], { MCP_CLI_RUNTIME_DIR: join(dir, 'rt') });
      expect(res.code, '配置坏了不该妨碍 stop').toBe(0);
      expect(res.stdout).toContain('没有正在运行的守护进程');
      expect(res.stderr, '不该抱怨缺少 ICLOUD_APP_PASSWORD_1').not.toContain('ICLOUD_APP_PASSWORD_1');
    },
    60_000,
  );

  it(
    'accepts the batch flag before the ops path, and blames the right token when it is wrong',
    async () => {
      writeFileSync(join(dir, 'ops.json'), '[{"tool":"apple_accounts"}]', 'utf8');
      const ok = await runCli(dir, ['batch', '--stop-on-error', 'ops.json']);
      expect(ok.code, 'flag 写在路径前面是完全合理的写法').toBe(0);
      expect(() => JSON.parse(ok.stdout)).not.toThrow();

      const bad = await runCli(dir, ['batch', '--bogus', 'ops.json']);
      expect(bad.code).toBe(1);
      expect(bad.stderr, '报错必须指着真正错的那个 token，不是唯一写对的那个').toContain('--bogus');
      expect(bad.stderr).not.toContain('未知参数：ops.json');
    },
    60_000,
  );
});
