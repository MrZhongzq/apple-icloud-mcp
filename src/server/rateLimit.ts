import type { NextFunction, Request, Response } from 'express';

/**
 * 授权页 `/access-login` 的限流额度。管理页 `/admin/login` 也用同一组数（它的设计就是
 * 「限流同 /access-login」），所以放在这里两边共用，不各写一份让它们悄悄分叉。
 */
export const ACCESS_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60_000;
export const ACCESS_LOGIN_RATE_LIMIT_MAX = 20;

/** 极简固定窗口限流（每个 IP 从第一次请求起计一个窗口）：单进程内存足够——授权页和管理页
 *  都只有寥寥几个人在用（持有访问密钥的使用者，和服务器的主人）。周期性清掉早已过期的桶，
 *  避免不同源 IP 造成 Map 无限增长。
 *  每次调用建一组独立的桶：两个登录端点各用各的，一个端点被刷满不连累另一个。 */
export function createSimpleRateLimit(opts: { windowMs: number; max: number }) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // 顺手清理过期桶：挂这个中间件的只有登录类端点（访问密钥登录、管理页登录），
    // 请求量很低，这里的遍历开销可以忽略。
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }

    const key = req.ip ?? 'unknown';
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    if (bucket.count >= opts.max) {
      res.set('Cache-Control', 'no-store');
      res.status(429).send('登录尝试过于频繁，请稍后再试');
      return;
    }
    bucket.count += 1;
    next();
  };
}
