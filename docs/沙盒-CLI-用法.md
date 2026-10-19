# 在沙盒里用命令行驱动这台服务器

这份文档写给部署者（你），不是写给 AI 的。AI 读的是 `SKILL.md`——它开头的「Which of these are you?」一节写明了命令行读者和 MCP 客户端的两处差别（工具是 23 个不是 25 个；会话由 CLI 自己管，`apple_login` / `work_done` 在这里不存在），其余内容两种读者通用。

它讲的是第三条路：**沙盒 CLI**。如果你的 Claude Routine 能用 shell（Routine 的云端沙盒就是这样），那么它不需要域名、不需要证书、不需要 OAuth——直接在沙盒里把这个仓库跑起来，用命令行调用同一批工具即可。**但云端沙盒里邮件用不了**，日历、提醒事项、通讯录可以，见下面第〇节的实测结论。远程 HTTP 部署那条路见 [`部署与-Routine-接入.md`](./部署与-Routine-接入.md)。

CLI 最多暴露 **23 个工具**：与 MCP 入口完全相同的那 25 个，减去 `apple_login` 和 `work_done`。实际列出多少取决于账号开了哪些能力——关掉联系人就少 5 个，Apple ID 不是 iCloud 邮箱地址导致邮件工具被自动禁用就少 7 个（见第七节）。`--list` 少于 23 行通常是配置的结果而不是故障，用 `apple_accounts` 看当前的能力表——命令行自己管理会话（见下文「会话去哪了」），这两个在这里没有意义，调用它们只会得到一个"看起来成功了、其实什么都没发生"的结果，所以直接被排除。业务逻辑一行都没变，同一份 `src/modules`。

---

## 〇、先确认沙盒连得上 iCloud

云端沙盒的出网经过代理和域名白名单，而邮件走的 IMAP（993）和 SMTP（587）不是 HTTPS——**能不能连上，取决于环境，不取决于这份代码**。第一次在一个新环境里用之前，先跑一次探针：

```bash
node scripts/probe-network.mjs     # 不需要 npm ci，不需要 .env，不登录、不读凭据的值
```

它分别测直连、经代理 CONNECT、原生 fetch（含 `NODE_USE_ENV_PROXY=1`）三条路，最后给出结论：邮件和日历/提醒/通讯录各自能不能用、要不要改配置或改代码。登录后 CalDAV/CardDAV 会跳到 `pNN-caldav.icloud.com` 这类主机，所以白名单要写 `*.icloud.com` 通配。

### 实测结论：Routine 的云端沙盒

2026-10-18 用这个探针在 Anthropic 的云端 Routine 环境里测过，网络设置的「受限」和「完全」两档都测了，结论相同：

- **邮件用不了。** IMAP 993 和 SMTP 587 在两档下都被拦截，走代理 CONNECT 也不通。
- **日历、提醒事项、通讯录可以用。** CalDAV 和 CardDAV 走 443，用 Node 原生 fetch 直接就能连通。

所以在云端 Routine 里，沙盒 CLI 能用日历、提醒事项、通讯录，但不能用邮件。不是整体不可用。两种处理办法：

- **要用邮件**：改走远程连接器，由服务器替你连 IMAP/SMTP。凭据仍然可以只放在你自己的 Routine 环境里，用加密信封登录，见 [`部署与-Routine-接入.md`](./部署与-Routine-接入.md)「和别人共用一台服务器」一节。
- **不用邮件**：在 `.env` 里设 `ALLOW_MAIL_READ_1=false`（`ALLOW_MAIL_WRITE_1` 本来就默认关闭）。这样 7 个邮件工具从 `--list` 里消失，另外三个模块照常用。不设的话，邮件工具仍然列在那里，可每一次调用都连不上 IMAP/SMTP、只会失败，AI 会把一次运行耗在一个注定连不上的工具上。

## 一、跑起来

沙盒里从零开始，五步：

```bash
git clone <仓库地址> apple-icloud-mcp
cd apple-icloud-mcp
npm ci
npm run build          # 必须——CLI 跑的是 dist/，不是 src/
```

然后准备 `.env`（放在仓库根目录，和 `package.json` 同级）：

```bash
cat > .env <<'ENV'
ICLOUD_ACCOUNT_1=your-name@icloud.com
ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop
# Apple ID 不是 iCloud 邮箱地址时必须补这一项，否则邮件工具会被自动禁用
# ICLOUD_SENDER_1=your-alias@icloud.com

# 读默认开、写默认关。要写就显式打开。
ALLOW_MAIL_WRITE_1=false
ALLOW_CALENDAR_WRITE_1=false
ALLOW_REMINDERS_WRITE_1=false
ALLOW_CONTACTS_WRITE_1=false

LOG_LEVEL=info
ENV
```

App 专用密码在 [appleid.apple.com](https://appleid.apple.com) → 登录与安全 → App 专用密码 生成。完整的变量清单见仓库根目录的 `.env.example`（`MCP_CLI_RUNTIME_DIR` 也在里面，注释掉的，只有常驻模式用得上——见下文第三节）。

跑一条命令验证：

```bash
node dist/bin/cli.js apple_accounts
```

看到自己的账号和权限表，就说明配置读到了。仓库里也有 `npm run cli` 这个别名，但 npm 会吞掉 `--` 之前的参数，所以得写成 `npm run cli -- --list`；本文一律用 `node dist/bin/cli.js`，少一层坑。

**`.env` 不会覆盖已经存在的环境变量。** CLI 读 `.env` 时用的是 `override: false`——如果沙盒已经把凭据注入进了进程环境，一个过期的 `.env` 不会悄悄把它盖掉。

---

## 二、不要打印 `.env`

**不要 `cat .env`，不要 `env`，不要 `echo $ICLOUD_APP_PASSWORD_1`，也不要打印一条把密码写在里面的命令。**

理由不是"有规定"，而是：**没有任何机制在保护这件事**。你的 shell 输出和 Routine 的对话记录之间没有任何脱敏层，没有东西认得出一个 App 专用密码并把它挡下来，更没有东西能把已经打印出去的东西收回来。"密码没有进对话"从来不是这套系统提供的性质，它只是"每一条被执行过的命令碰巧都不是会打印它的那一条"累积出来的结果。

一条 `cat .env` 写进一个每天运行的 routine，就是从此每天的记录里都有一份密码；补救办法不是改代码，是去 appleid.apple.com 把那个密码吊销、重新生成一个。

要确认某个变量有没有设上，测它非空，别打印它的值：

```bash
test -n "$ICLOUD_APP_PASSWORD_1" && echo "已设置" || echo "未设置"
```

---

## 三、两种模式：一次性 和 常驻

### 一次性（默认，什么都不用做）

```bash
node dist/bin/cli.js mail_search --limit 5
```

每条命令自己建一个会话、执行、销毁。进程退出时连接一定是关掉的，不残留。代价是每条命令都要重做一次 TCP + TLS + IMAP 认证握手。

### 常驻（`start` / `stop`）

```bash
node dist/bin/cli.js start     # 启动守护进程，等它真的能连上才返回
node dist/bin/cli.js mail_folders
node dist/bin/cli.js mail_search --limit 5     # 复用上面那个会话，省掉握手
node dist/bin/cli.js stop
```

`start` 之后，普通命令会先去敲守护进程的门；连得上就用它已经建好的会话执行，连不上（没启动、被杀掉、端点文件是僵死的）就自动退回一次性模式，并在 stderr 上说一声——结果照样正确，只是悄悄多付了一次握手，不说清楚没人会知道。`stop` 之后一切退回一次性模式。

**什么时候值得 `start`：** 一次 routine 里要连着调五条以上的命令，或者其中有 `contacts_search`（首次搜索会全量拉取通讯录，实测 1429 张卡片约 4.5 秒；同一会话里之后的搜索约 0.4 秒——这个缓存是**会话内**的，一次性模式下每条命令都会重新付一遍这 4.5 秒）。只跑一两条命令就不必了，`start` 自己的冷启动也要时间。

**守护进程会把配置冻住。** `cli start` 那一刻的工具表、每个账号的读写权限、以及用来登录的凭据，全部停在那一刻；而普通命令每次都会重新读一遍 `.env`。所以改了 `.env`（打开一个 `ALLOW_*_WRITE`、换一个 App 专用密码、加一个账号）之后，必须 `cli stop` 再 `cli start`，否则守护进程还在按旧配置工作。

不用担心记不住：客户端每条请求都会带上当前配置的指纹，守护进程发现和自己启动时的那份对不上就**直接拒绝**并告诉你怎么做——

```
$ cli apple_accounts
这个守护进程是在当前 .env 之前启动的，它的工具表、读写权限和凭据都停在启动那一刻，和你现在的配置已经不一致了。它不会拿旧配置替你回答，因为那样给出的答案是错的却看不出来。
提示：先 cli stop 再 cli start，让守护进程重新读一遍配置；只跑一两条命令的话直接 cli stop，退回一次性模式即可
exit=1
```

它宁可拒绝也不肯拿旧配置回答，是因为那种答案错得看不出来：`--list` 会列出一个守护进程随后说"不认识"的工具；打开写权限之后 `mail_send` 仍然报 `PERMISSION_DENIED`，还叫你去设置那个你刚设好的变量；`apple_accounts`——那个专门用来报告"现在配成什么样"的工具——报告的是旧配置。

守护进程空闲 15 分钟自动退出。它一次只服务一个账号——和一次性模式一样，配了多个账号时它会直接拒绝而不是替你猜，把不同账号拆到各自的 `.env` / 各自的沙盒里去跑。

### `daemon.log`：打开 debug 之前先知道这件事

守护进程把自己的 stderr 写到运行时目录下的 `daemon.log`（运行时目录默认在临时目录里，可用 `MCP_CLI_RUNTIME_DIR` 指定）。这个文件：

- 创建时权限是 `600`；
- **每次 `cli start` 用截断方式重写**（上一次失败的残留日志不会和这一次的诊断信息混在一起）；
- **运行期间不轮转、没有大小上限**——截断本身就是它唯一的轮转机制。

所以：**`LOG_LEVEL=debug` 下要当心**。debug 级别时 IMAP provider 会把 imapflow 的**每一帧协议数据**都记进这个文件，而日志的脱敏是**按键名**做的（遮蔽形如 `pass`/`password`/`secret`/`token` 的字段），它不认识 imapflow 帧内部的字段名。一个常驻很久的守护进程在 debug 下可以把这个文件写得比你预期大得多，而且里面有你的邮件内容。调试完记得把 `LOG_LEVEL` 调回 `info`，并重启守护进程（下一次 `start` 会把日志截断）。

---

## 四、有哪些工具、每个怎么调

```bash
node dist/bin/cli.js --list                # 当前可用的工具（最多 23 个），一行一个：名字 + 描述的第一句
node dist/bin/cli.js mail_search --help    # 某个工具的全部参数
```

`--list` 每行只印描述的**第一句**——工具描述是拼接出来的长段落（`contacts_search` 那段有 798 字符），整段印在一行上就没法扫了。完整描述在 `--help` 里，一个字都没少。

`--help` 的内容是**从工具自己的 schema 生成的**，不是另写一份文档，所以它不会和真实参数漂移。例如：

```
$ node dist/bin/cli.js reminders_update --help
reminders_update
按 reminder_id 修改提醒事项，patch 中只写需要变更的字段。

--reminder_id <string>  必填  reminders_list 返回的 reminder_id
--patch <json>  必填
--expected_etag <string>  可选  乐观锁，可留空
```

参数写法：

| `--help` 里的类型 | 命令行上怎么写 |
|---|---|
| `<string>` | `--folder INBOX` |
| `<number>` | `--limit 20` |
| `--x \| --no-x` | 布尔三态：`--permanent` 是 true，`--no-permanent` 是 false，整个省略表示不传该字段。**不吃下一个 token**——`--permanent true` 会报 `未知参数：true` |
| `<json>` | 整块 JSON 字符串：`--patch '{"title":"新标题"}'` |
| `<a\|b\|c>` | 枚举，直接写取值：`--format both` |

非布尔参数一定吃掉下一个 token 作为值，**哪怕它以短横开头**——那是合法值，不是下一个参数。

`--no-<key>` 那一半不是摆设：有几个参数的 `false` 是一个真正有意义的取值，而不是"不传"的同义词。`reminders_list --completed` 是"只看已完成"，`--no-completed` 才是"只看未完成"（都不写则两者都返回）；`calendar_list_events` 的 `expand_recurring` 默认就是 true，`--no-expand_recurring` 才能拿到重复事件的主体而不是展开后的每一次。

**没有 `--session_id`，永远不会有。** 会话是 CLI 自己的事，见下文。

### 三态字段与 `--unset-<key>`

有些字段是三态的：给一个值 = 设置，给 `null` = **清除**，整个省略 = 不改动。CLI 对这种字段会额外生成一个 `--unset-<key>`，传它等价于传 `null`：

```bash
# 假设某工具有一个可为 null 的顶层参数 nickname
node dist/bin/cli.js some_tool --unset-nickname     # 等价于 nickname: null
```

同一个字段不能又设置又清除，`--nickname x --unset-nickname` 会被直接拒绝。

**但要注意：当前这 23 个工具里，没有任何一个的顶层参数是三态的。** 三态字段全都长在嵌套对象里——`contacts_update` 的 `nickname`/`organization`/`title`/`note`、`reminders_update` 的 `due` 等等，都在 `--patch` 这个 `<json>` 参数**内部**。所以今天你在任何一份 `--help` 里都看不到 `--unset-` 开头的行；要清除这些字段，就在 JSON 里直接写 `null`：

```bash
node dist/bin/cli.js contacts_update \
  --contact_id <id> \
  --patch '{"nickname":null,"organization":"新公司"}'
```

上面这条命令的含义是：清除昵称、把公司改掉、其余字段一概不动。`--unset-` 这套机制是为将来某个工具把三态字段提到顶层时准备的，届时它会自动出现在 `--help` 里，不需要改任何文档。

### 会话去哪了

命令行的会话边界是**进程本身**：每次调用在一个隐式会话里跑完就销毁，`session_id` 从不出现在命令行上，也不会出现在批量操作的 JSON 里。因此 `apple_login` 和 `work_done` 被整体排除——`apple_login` 返回的 `session_id` 在进程退出那一刻就不存在了（一个指向空气的句柄），而 `work_done` 只会销毁 CLI 刚建出来、还没被任何工具用过的空会话，然后返回 `{"success": true}` 让你以为关掉了什么。真要关掉常驻会话，用 `cli stop`。

---

## 五、批量模式

一份 JSON 文件描述一串操作，**整批共用一个会话**跑完：

```bash
node dist/bin/cli.js batch ops.json
node dist/bin/cli.js batch ops.json --stop-on-error
```

`ops.json` 的格式是一个数组，每一条是 `{"tool": "...", "args": {...}}`，`args` 不需要时可以整个省略：

```json
[
  { "tool": "apple_accounts" },
  { "tool": "mail_folders" },
  { "tool": "mail_search", "args": { "folder": "INBOX", "limit": 5, "query": { "unseen": true } } },
  { "tool": "calendar_list_events", "args": { "start": "2026-09-01T00:00:00+08:00", "end": "2026-09-08T00:00:00+08:00" } }
]
```

`args` 里写的是**工具原本的参数结构**（和 MCP 那边一模一样），不是命令行 flag——嵌套对象就直接写嵌套对象，不用像 `--patch` 那样再包一层字符串。

stdout 上是一个 `outcomes` 数组，与操作**一一对应、顺序一致**：

```json
[
  { "tool": "mail_folders", "ok": true,  "value": { "folders": [] } },
  { "tool": "mail_search",  "ok": false, "value": { "error": { "code": "NOT_FOUND", "message": "..." } } }
]
```

几条必须知道的行为：

- **整批先校验，全部合法才开始执行。** 一份把第三条工具名拼错的 `ops.json`，不会先把前两条真的执行掉（可能已经发了信、删了邮件）再报错——它一条都不会跑，报错里会告诉你是第几条、错在哪。这条性质是有意的：否则你会很自然地改完拼写重跑一遍，于是前两条执行了两次。
- **默认不中断。** 某一条失败了，后面的照跑，失败那条的 `ok` 是 `false`。批量里最常见的形态是一串只读查询，其中一条撞上 `NOT_FOUND` 不该让后面十九条都不跑。要「首个失败即停」（写操作串联、后一条依赖前一条成功）就加 `--stop-on-error`，此时返回的数组只到失败那一条为止。
- **每条操作只认 `tool` 和 `args` 两个键**——**包括不能写 `comment`**。JSON 本身没有注释语法，而 ops 文件是手写的，所以这一条迟早会撞上：想给某条操作加说明，写在 ops 文件之外（比如同目录的一个 `.md`，或者文件名本身）。允许无法识别的键就等于放过 `arg`（少个 s）这种拼写错误，而那会让整条操作变成"不带任何参数调用"。
- **`args` 要整体通过该工具的 schema。** 名字写错、类型不对、多一个键、必填的没给，都会让**整批**被拒（退出 1，一条都不跑），而不是跑到坏的那一条才发现——那时前面几条的副作用已经发生了。这条存在是因为拼错的后果是静默的：`arg` 少个 s，整条操作就变成"不带任何参数调用这个工具"，照常执行、照常返回一个像模像样的结果；`limt` 而不是 `limit`，你会拿回默认的 20 条而不是要的 5 条，退出码 0，没有任何提示。
- **`args` 里不能写 `session_id`。** 会话由 CLI 建立和销毁，你传的 id 不会生效——所以这里是**直接拒绝整批**，而不是悄悄覆盖掉它。悄悄覆盖会让你以为自己传的 id 生效了。
- **`apple_login` / `work_done` 同样不能出现在批量里**，理由和命令行上一样。
- 批量模式不走守护进程：它本来就自己建一个会话跑完全部操作，`start` 能省的那次握手它已经省了。守护进程在跑也不冲突，两者各自持有自己的会话。

---

## 六、退出码

| 码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 | 工具正常返回；批量模式下全部操作都成功 |
| `2` | **工具返回了结构化错误** | `PERMISSION_DENIED`、`NOT_FOUND`、`AUTH_FAILED`……；批量模式下至少有一条失败 |
| `1` | **CLI 自己失败了** | 未知子命令 / 未知工具、参数没通过工具 schema 的校验（名字写错、必填缺失、类型不对、有多余的参数）、`.env` 没配好、`ops.json` 读不到或格式非法、批量整批校验没通过、多账号拒绝 |

区分 1 和 2 的意义：**2 是「命令跑通了，iCloud 那边这么回答」，1 是「这条命令根本没跑成」**。1 不该重试（参数不对不会因为重试就变对），2 要看具体错误码——`AUTH_FAILED` 意味着密码失效，重试多少次都一样。

**参数在工具跑起来之前会对着工具自己的 schema 校验一遍**，三条路（flag、批量、守护进程）都一样，失败一律是退出码 1、工具没有被执行：

```
$ cli mail_read --uid 1 --format bogus
工具 mail_read 的参数不合法：format：Invalid option: expected one of "text"|"html"|"both"
提示：用 cli mail_read --help 查看该工具接受哪些参数；参数没通过校验时工具没有被执行
exit=1
```

覆盖的是：参数名写错、必填参数没给、值的类型不对（数字位置给了字符串、枚举给了不存在的取值、嵌套对象里的字段类型不对……）。**多余的参数是拒绝，不是丢掉**——静默丢掉一个参数正是"看起来成功了、其实干了别的事"。

这条检查存在，是因为**命令行这条路上没有别人会做它**：stdio 和远程 HTTP 两个入口的参数校验是 MCP SDK 做的（SDK 拿工具的 schema 解析完才调 handler），而 CLI 直接调同一批 handler，SDK 那一层根本不在路径上。少了它，同一批按"参数已经验过"写出来的 handler 在第三个入口就少了一个前置条件——`{"limit": "five"}` 只是看得见的那一角，真正没有症状的是拿字符串去做算术或索引。

校验用的就是工具自己的 schema（不是 CLI 里另写的一份），所以它和 MCP 入口的行为一致，也不会随着工具改字段而过时。

stdout 上**只有结果 JSON**，日志、报错、进度一律走 stderr。所以下面这样是安全的：

```bash
if out=$(node dist/bin/cli.js mail_search --limit 5 2>/tmp/err.log); then
  echo "$out" | jq '.messages | length'
else
  code=$?
  if [ "$code" -eq 2 ]; then
    echo "iCloud 返回了错误：" >&2; cat /tmp/err.log >&2
  else
    echo "CLI 自身失败（别重试）：" >&2; cat /tmp/err.log >&2
  fi
  exit "$code"
fi
```

批量模式下更常见的是逐条看：

```bash
node dist/bin/cli.js batch ops.json > out.json
code=$?
jq -r '.[] | select(.ok | not) | "失败：\(.tool) \(.value.error.code)"' out.json
exit "$code"
```

注意 `set -e` 下退出码 2 会直接中断脚本——如果你想自己处理失败的那几条，记得像上面那样用 `if`/`||` 把命令包起来。

---

## 七、几条限制

- **一次只服务一个账号。** 配了多个账号时，除 `apple_accounts` 外的所有命令一律拒绝，不替你猜。把不同账号拆到各自的 `.env` 和各自的沙盒里。
- **写权限默认关闭。** `ALLOW_*_WRITE_n` 不显式设为 `true` 的话，所有写操作会以 `PERMISSION_DENIED`（退出码 2）失败，错误里会写明该设哪个变量。
- **Apple ID 不是 iCloud 邮箱地址时，邮件工具会被自动禁用**，除非设置了 `ICLOUD_SENDER_n`。这不是 bug：Apple 的 IMAP 服务器会直接拒绝非 iCloud 域名的用户名，而那个报错长得和"密码被吊销"一模一样，所以宁可在启动时说清楚。启动时 stderr 上会有一条说明。
- 其余与协议本身相关的限制（不支持备忘录、附件不能收发、重复日程的夏令时漂移等）见 [`部署与-Routine-接入.md`](./部署与-Routine-接入.md) 最后一节，两条路完全一样。
