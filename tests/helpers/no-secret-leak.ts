import { expect } from 'vitest';

/**
 * 把一个错误对象「摊平」成可搜索的字符串。
 *
 * 存在的理由：`Error.prototype.message` 是**不可枚举**属性，所以 `JSON.stringify(err)`
 * 根本看不见它。一条只对 `JSON.stringify` 结果做 `not.toContain` 的泄露检查，因此对
 * 「把密钥原样写进 message」这种最直接的泄露完全失明——测试永远绿，而秘密照样出现在
 * 用户看到的那行报错里。
 *
 * 阶段三 Task 1 的审查发现了这一点。这个辅助函数把 message、hint、stack 与其余可枚举
 * 字段一并纳入，供本阶段后续任务的泄露检查复用，免得每处各写一遍、各漏一处。
 */
export function flattenError(err: unknown): string {
  if (err === undefined || err === null) return '';
  const parts: string[] = [String(err)];
  if (err instanceof Error) {
    parts.push(err.message);
    if (err.stack) parts.push(err.stack);
    if (err.cause !== undefined) parts.push(flattenError(err.cause));
  }
  try {
    parts.push(JSON.stringify(err));
    // 显式带上不可枚举的自有属性，JSON.stringify 会漏掉它们
    for (const name of Object.getOwnPropertyNames(err as object)) {
      const value = (err as Record<string, unknown>)[name];
      if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
    }
  } catch {
    // 循环引用等情况下 stringify 会抛；上面已经取到 message 与 stack，足够断言
  }
  return parts.join('\n');
}

/**
 * 断言一个错误在任何可被人看见的通道里都不包含给定的秘密。
 * `secrets` 里的空串会被忽略，避免 `not.toContain('')` 这种恒假断言悄悄混进来。
 */
export function expectNoSecretLeak(err: unknown, secrets: string[]): void {
  const blob = flattenError(err);
  for (const secret of secrets) {
    if (!secret) continue;
    expect(blob, `错误对象里出现了不该出现的内容：${secret.slice(0, 12)}...`).not.toContain(secret);
  }
}
