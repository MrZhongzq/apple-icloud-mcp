import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { ToolConfig } from '../server/types.js';

const NEWLINE = String.fromCharCode(10);

/**
 * Schema introspection below reads zod's public classic API (`.type`, `.description`,
 * `instanceof z.ZodOptional`/`z.ZodNullable`, `.unwrap()`, `.options`) instead of the
 * internal `_def`/`_def.innerType` shape. `_def` is undocumented and free to change
 * between zod minors; this project pins zod today but will eventually bump it, and the
 * public surface is the part zod commits to keeping stable. Do not "simplify" this back
 * to `_def` to save the one `as ZodTypeAny` cast below — that cast is the cheaper cost.
 */

export type FlagKind = 'string' | 'number' | 'boolean' | 'json';

export interface FlagSpec {
  /** 参数名，如 `limit`。 */
  key: string;
  /** 命令行上的写法，如 `--limit`。 */
  flag: string;
  kind: FlagKind;
  required: boolean;
  /** 该参数接受 null（三态），因而额外生成 `--unset-<key>`。 */
  nullable: boolean;
  description?: string;
  /**
   * 枚举的合法取值，仅用于 --help 展示。**不要**用它在 parseFlags 里做校验——
   * 工具自己的 zod schema 已经会拒绝非法值并在报错里列出合法取值，
   * 这里再校验一遍就是同一份真相的第二个副本，枚举加一个成员时两边迟早会对不上。
   */
  choices?: string[];
}

interface PeelResult {
  /** 剥掉全部 optional/nullable 包装后剩下的基础 schema。 */
  base: ZodTypeAny;
  required: boolean;
  nullable: boolean;
  description: string | undefined;
}

/**
 * 逐层剥 optional/nullable 包装，边剥边找 description：
 * `.optional().describe()` 的描述在最外层，`.describe().optional()` 的描述在剥开后的内层，
 * 本项目两种写法都有，所以每一层都要看，取第一个非空的。
 */
function peel(schema: ZodTypeAny): PeelResult {
  let current: ZodTypeAny = schema;
  let required = true;
  let nullable = false;
  let description: string | undefined;

  for (;;) {
    if (description === undefined && current.description) {
      description = current.description;
    }
    if (current instanceof z.ZodOptional) {
      required = false;
      // `.unwrap()` 的返回类型以 core 层的 `$ZodType` 为默认泛型参数，
      // 丢失了 classic API 的 `.type`/`.description`/`instanceof` 便利成员；
      // 运行时它就是构造它时传入的那个 classic schema，这里把类型信息接回来。
      current = current.unwrap() as ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      nullable = true;
      current = current.unwrap() as ZodTypeAny;
      continue;
    }
    break;
  }

  return { base: current, required, nullable, description };
}

function kindOf(base: ZodTypeAny): FlagKind {
  switch (base.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
    case 'array':
      // 嵌套结构只能整块传 JSON，没有别的合理命令行表示。
      return 'json';
    default:
      // 其余标量形态（enum、literal 等）在命令行上就是一个原始字符串；
      // 工具自己的 zod schema 才是校验它是否合法的地方。
      return 'string';
  }
}

/** 枚举的合法取值，仅用于 --help 展示（见 FlagSpec.choices 上的注释）。 */
function choicesOf(base: ZodTypeAny): string[] | undefined {
  if (base instanceof z.ZodEnum) {
    return base.options.map((value) => String(value));
  }
  return undefined;
}

/** session_id 由 CLI 隐式注入（见 Task 2），绝不能生成成 flag。 */
const INJECTED_KEYS = new Set(['session_id']);

export function deriveFlags(config: ToolConfig): FlagSpec[] {
  const specs: FlagSpec[] = [];
  for (const [key, rawSchema] of Object.entries(config.inputSchema)) {
    if (INJECTED_KEYS.has(key)) continue;
    const schema = rawSchema as ZodTypeAny;
    const { base, required, nullable, description } = peel(schema);
    const choices = choicesOf(base);
    const spec: FlagSpec = {
      key,
      flag: '--' + key,
      kind: kindOf(base),
      required,
      nullable,
    };
    if (description !== undefined) spec.description = description;
    if (choices !== undefined) spec.choices = choices;
    specs.push(spec);
  }
  return specs;
}

function parseScalar(spec: FlagSpec, raw: string): unknown {
  switch (spec.kind) {
    case 'string':
      return raw;
    case 'number': {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error('参数 ' + spec.flag + ' 必须是数字，实际是：' + raw);
      }
      return value;
    }
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error('参数 ' + spec.flag + ' 不是合法的 JSON：' + raw);
      }
    case 'boolean':
      // 布尔 flag 不吃下一个 token，永远不会走到这里。
      throw new Error('内部错误：布尔 flag ' + spec.flag + ' 不应该消费一个值');
  }
}

export function parseFlags(specs: FlagSpec[], argv: string[]): Record<string, unknown> {
  const byFlag = new Map<string, FlagSpec>();
  const byUnsetFlag = new Map<string, FlagSpec>();
  const byNegatedFlag = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byFlag.set(spec.flag, spec);
    if (spec.nullable) {
      byUnsetFlag.set('--unset-' + spec.key, spec);
    }
    if (spec.kind === 'boolean') {
      byNegatedFlag.set('--no-' + spec.key, spec);
    }
  }

  const result: Record<string, unknown> = {};
  const setKeys = new Set<string>();
  const unsetKeys = new Set<string>();

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;

    // `--unset-<key>` 优先匹配，否则会先被当成未知 flag（或普通 flag 的前缀）处理掉。
    const unsetSpec = byUnsetFlag.get(token);
    if (unsetSpec) {
      unsetKeys.add(unsetSpec.key);
      i += 1;
      continue;
    }

    // `--no-<key>`：布尔参数的 false。没有它的话，三态布尔里"显式 false"这一态
    // 在命令行上根本写不出来——`reminders_list --completed` 是"只看已完成"，
    // 而"只看未完成"（`completed: false`）无从表达，而那是提醒事项最常见的一个
    // 查询。同样地 `calendar_list_events --expand_recurring` 默认就是 true，
    // 想要 false（拿重复事件的主体而不是展开的每一次）也没有写法。
    // 优先于普通 flag 匹配，理由和 `--unset-` 一样：否则会先被当成未知参数。
    const negatedSpec = byNegatedFlag.get(token);
    if (negatedSpec) {
      result[negatedSpec.key] = false;
      setKeys.add(negatedSpec.key);
      i += 1;
      continue;
    }

    const spec = byFlag.get(token);
    if (!spec) {
      throw new Error('未知参数：' + token);
    }

    if (spec.kind === 'boolean') {
      result[spec.key] = true;
      setKeys.add(spec.key);
      i += 1;
      continue;
    }

    // 非布尔 flag 一定吃下一个 token 作为值，不管它是否以短横开头——那是合法值。
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error('参数 ' + spec.flag + ' 需要一个值');
    }
    result[spec.key] = parseScalar(spec, value);
    setKeys.add(spec.key);
    i += 2;
  }

  for (const key of setKeys) {
    if (unsetKeys.has(key)) {
      throw new Error('不能同时设置和清除同一个字段：' + key);
    }
  }

  for (const key of unsetKeys) {
    result[key] = null;
  }

  for (const spec of specs) {
    if (spec.required && !setKeys.has(spec.key) && !unsetKeys.has(spec.key)) {
      throw new Error('缺少必填参数：' + spec.flag);
    }
  }

  return result;
}

export function renderHelp(name: string, config: ToolConfig, specs: FlagSpec[]): string {
  const lines: string[] = [name];
  if (config.description) lines.push(config.description);
  lines.push('');

  for (const spec of specs) {
    const requiredLabel = spec.required ? '必填' : '可选';
    // 布尔参数不吃值——写成 `--x <boolean>` 会被读成"要跟一个值"，照做
    // （`--permanent true`）得到的是 `未知参数：true`。帮助必须印出解析器真正
    // 接受的写法：出现即 true，`--no-x` 即 false。帮助由 schema 生成的意义就在
    // 于它不会和真实行为漂移；一份和解析器矛盾的帮助比没有帮助更糟。
    let line: string;
    if (spec.kind === 'boolean') {
      line = spec.flag + ' | --no-' + spec.key + '  ' + requiredLabel;
    } else {
      // choices 存在时展示具体取值（如 <text|html|both>），否则退回类型名。
      const typeLabel = spec.choices ? spec.choices.join('|') : spec.kind;
      line = spec.flag + ' <' + typeLabel + '>  ' + requiredLabel;
    }
    if (spec.description) line += '  ' + spec.description;
    lines.push(line);
    if (spec.kind === 'boolean') {
      lines.push('  ' + spec.flag + ' 置为 true，--no-' + spec.key + ' 置为 false，整个省略则不传该字段');
    }
    if (spec.nullable) {
      lines.push('  --unset-' + spec.key + '  传此项以清除该字段（设为 null）');
    }
  }

  return lines.join(NEWLINE);
}
