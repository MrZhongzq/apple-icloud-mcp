// make-envelope.mjs 的类型声明：脚本本身是零依赖的纯 JS，这份声明只给 tests/** 的类型检查用。

/** 解析 .env 文本：`\r?\n` 分行，跳过空行与 `#` 注释行，允许 `export ` 前缀，去掉一对引号，未加引号的值在 ` #` 处截断。 */
export declare function parseDotenv(text: string): Record<string, string>;

/** 只取 12 个白名单变量里非空的那些；缺账号/密码或配置了 ICLOUD_ACCOUNT_2..5 时抛错。 */
export declare function collectEnvelopeEnv(source: Record<string, string | undefined>): Record<string, string>;

/** 用服务端公钥（`amp1_…`）把 env 封成一行信封（`ame1.…`）。`now` 默认 `Date.now()`，作为载荷的 iat。 */
export declare function sealEnvelope(publicKeyText: string, env: Record<string, string>, now?: number): string;
