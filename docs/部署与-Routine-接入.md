# 部署这台 MCP 服务器，并接到 Claude Routine

这份文档写给部署者（你），不是写给 AI 的。AI 读的是 `SKILL.md`。

---

## 先决定一件事：你需要哪种部署

这台服务器有三条路，**共用同一套业务代码和同样那批工具**，区别只在怎么被驱动。

| | 本地 stdio | 远程 HTTP | 沙盒 CLI |
|---|---|---|---|
| 谁来启动 | 客户端把它当子进程拉起来 | 你自己在服务器上常驻运行 | Routine 自己在沙盒 shell 里跑命令 |
| 怎么连上 | MCP over stdio | MCP over Streamable HTTP | 不连——直接命令行调用 |
| 需要域名和证书 | 不需要 | **需要** | 不需要 |
| 需要 OAuth | 不需要 | 需要（服务器自带授权服务器） | 不需要 |
| 凭据放在哪 | 你自己电脑上 | **常驻在服务器上** | **每个人自己的沙盒里** |
| 能用于 Claude Code / 桌面端 | 可以 | 可以 | 不适用（它不是 MCP 连接器） |
| **能用于 Claude Routine** | **不能** | **能** | **能——前提是 Routine 有 shell** |

**Routine 在 Anthropic 的服务器上运行，不在你的电脑上**——它没法拉起你本机的一个子进程，所以本地 stdio 那条路对 Routine 走不通。剩下两条都能用于 Routine，选哪条取决于你的 Routine 能不能用 shell：

- **能用 shell（cowork 沙盒就是这样）** → 走沙盒 CLI，最省事的一条。见下面第「五」节。
- **只能挂 MCP 连接器** → 走远程 HTTP 部署，也就是这份文档第「二」「三」节讲的东西。

如果你只是想在自己电脑的 Claude Code 里用，那 stdio 更简单，看仓库 `README.md` 的 Install 一节即可，这份文档的后半部分你用不上。

---

## 一、准备工作（三条路都要）

### 1. Apple ID 与 App 专用密码

在 [appleid.apple.com](https://appleid.apple.com) → 登录与安全 → App 专用密码，生成一个。格式形如 `abcd-efgh-ijkl-mnop`。

**你的 Apple ID 必须开启双重认证**，否则 Apple 不提供 App 专用密码。

### 2. 确认你的 iCloud 邮箱地址

这一步最容易出错，值得单独说。

IMAP/SMTP 用 `ICLOUD_SENDER_n` 认证，CalDAV/CardDAV 用 `ICLOUD_ACCOUNT_n` 认证——**这是两个不同的字段**。如果你的 Apple ID 是 Gmail 或其他第三方地址（老账号常见），你必须额外设置 `ICLOUD_SENDER_n` 为你的 iCloud 邮箱地址（`@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn`）。

不设的话，服务器会在启动时**自动关闭该账号的邮件工具**并在 stderr 打印说明，日历、提醒事项、通讯录不受影响。这是有意的保护——因为 Apple 的 IMAP 服务器会直接拒绝非 iCloud 用户名，而报出的 `AUTHENTICATIONFAILED` 看起来和"密码被吊销"一模一样，很容易误诊。

---

## 二、远程 HTTP 部署（没有 shell 的 Routine 需要这条）

### 1. 你需要什么

- 一台能装 Docker 的服务器（1 核 1G 足够，实测容器常驻占用约 66MB）
- 一个域名，A 记录指向那台服务器的 IP
- 服务器的 80 和 443 端口可以从公网访问（Caddy 申请证书要用）

**为什么必须有域名**：配置层强制 `PUBLIC_URL` 使用 https（`localhost` 除外）。这不是可以绕过的选项——OAuth 的元数据要求 https 的 issuer，而裸 IP 拿不到公信证书。

### 2. 装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# 重新登录一次让组生效
```

### 3. 拉代码

```bash
git clone https://github.com/MrZhongzq/apple-icloud-mcp.git
cd apple-icloud-mcp
```

### 4. 生成密钥材料

两条命令，都在服务器上跑，产物不要外传。

```bash
# 令牌加密密钥（32 字节 base64）
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

管理员口令的哈希：先构建，再用构建产物生成。

```bash
npm ci && npm run build
node -e "const r=require('node:readline').createInterface({input:process.stdin,output:process.stderr});r.question('password: ',p=>{r.close();import('./dist/auth/crypto.js').then(m=>console.log(m.hashPassword(p)))})"
```

**这条命令特意从标准输入读口令，而不是当命令行参数。** 写成参数的话，口令会留在 shell 历史里和进程列表里，同机的其他用户能看到。

记住你输入的**明文口令**——待会儿在浏览器登录页要用它，不是用哈希。

### 5. 写 `.env`

```bash
cat > .env <<'EOF'
# --- iCloud 账号 ---
ICLOUD_ACCOUNT_1=你的AppleID@example.com
ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop
# 如果 Apple ID 不是 iCloud 邮箱地址，必须设置这一项，否则邮件工具会被自动禁用
# ICLOUD_SENDER_1=你的iCloud邮箱@icloud.com

# --- 权限（读默认开、写默认关）---
ALLOW_MAIL_READ_1=true
ALLOW_MAIL_WRITE_1=false
ALLOW_CALENDAR_READ_1=true
ALLOW_CALENDAR_WRITE_1=false
ALLOW_REMINDERS_READ_1=true
ALLOW_REMINDERS_WRITE_1=false
ALLOW_CONTACTS_READ_1=true
ALLOW_CONTACTS_WRITE_1=false

# --- HTTP 入口（只有远程部署需要）---
PUBLIC_URL=https://mcp.你的域名.com
ADMIN_PASSWORD_HASH=上一步生成的哈希
TOKEN_ENCRYPTION_KEY=上一步生成的密钥
EOF
chmod 600 .env
```

关于**写权限默认关闭**：这是有意的。上一版实现里写权限默认开启，一个拼错的变量名就静默放开了删除邮件的权限。现在你要一项项显式打开——想让 Routine 建日程就开 `ALLOW_CALENDAR_WRITE_1`，只想让它读邮件就全部保持 `false`。

关于**代理信任**：`docker-compose.yml` 里已经给 app 服务写死了 `TRUST_PROXY: "true"`，你不用在 `.env` 里重复设置。它必须开着的原因是——Caddy 在前面，所有请求都从同一个容器 IP 进来；不开的话限流会把所有访客算成同一个来源，任何人都能耗尽授权配额、把你自己锁在外面。

反过来，如果你**不用 compose**、把这台服务器直接暴露在公网上（不推荐），那就**不要**开 `TRUST_PROXY`——那种情况下 `X-Forwarded-For` 是调用方自己填的，信任它等于让任何人伪造来源 IP。

### 6. 改域名并启动

编辑 `Caddyfile`，把示例域名换成你自己的，然后：

```bash
docker compose up -d
```

确认活着（这个端点不需要认证）：

```bash
curl https://mcp.你的域名.com/health     # 期望 {"status":"ok"}
```

---

## 三、接到 Claude Routine

### 1. 先把它加成连接器

在 claude.ai 的设置里添加自定义连接器 / 远程 MCP 服务器，地址填 **`https://mcp.你的域名.com/mcp`**（注意末尾的 `/mcp`）。

然后会发生这些事，全自动：

1. Claude 读取 `/.well-known/oauth-authorization-server` 发现授权方式
2. 动态注册自己为一个客户端
3. 打开浏览器跳到你这台服务器的**管理员登录页**
4. **你输入第 4 步记住的那个明文口令**
5. 跳回 Claude，拿到令牌，连接建立

登录页只有一个口令输入框——因为这台服务器只有一个用户，就是你。它不是在验证"你是谁"，是在验证"你是这台服务器的部署者"。

### 2. 在 Routine 里使用

连接器加好之后，在创建 Routine 时把它选上，Routine 运行时就能调用那 25 个工具。

**Routine 是无人值守的，有几件事值得你在写指令时想清楚：**

- **它每次运行都是全新的会话。** 服务器端会自动处理登录和登出，你不用管。
- **写操作会真的改你的数据，而且没人在旁边看。** 如果指令是"每天早上把今天的日程整理成提醒"，那它每天都会真的创建提醒。建议第一次先用只读的指令跑几天，确认它理解得没错，再开写权限。
- **重复运行不会自动去重。** 服务器不做这件事。`SKILL.md` 里已经要求 AI 在创建前先搜索、已存在就跳过，但你的指令写得越具体，它做对的概率越高。
- **第一次调用通讯录搜索会慢几秒**（实测 1429 个联系人约 4.5 秒），因为 iCloud 不支持服务端过滤，只能整份拉下来在会话内缓存。这不是卡住了。

### 3. 想撤销授权的时候

删掉服务器上的令牌存储卷，所有已授权的客户端都需要重新授权：

```bash
docker compose down
docker volume rm apple-icloud-mcp_token_store
docker compose up -d
```

**这个操作会立刻断开**——不只是让令牌不能续期，正在进行的会话和它持有的 iCloud 连接会被一起销毁。

本版本**没有**"列出所有已连接客户端、单独踢掉某一个"的管理界面。如果你只连了 Claude 一个客户端，上面这条就等于撤销它。

---

## 四、出问题时

以下三种情况的表面症状都有误导性，值得单独记住：

### 所有请求都返回 401，令牌明明是刚发的

客户端注册时用的 `PUBLIC_URL` 和现在配置的不一致，元数据里的 issuer 对不上。

**去查域名，不是去查令牌。** 把 `PUBLIC_URL` 改成客户端实际访问的那个域名，然后在 Claude 里**重新添加连接器**——已有的注册记录改不了 issuer，只能重新注册。

### 登录页出来了，提交之后没反应

待授权请求过期了。它只在内存里留 10 分钟，从你第一次打到 `/authorize` 算起。

**不要反复重试那个表单**——它绑定的 `request_id` 已经没了。回到 Claude 重新发起一次连接。

### 服务器起来了，但没有任何客户端能完成授权

令牌存储解不开，几乎总是因为 `TOKEN_ENCRYPTION_KEY` 变了。

**删掉存储文件就是预期的恢复手段，不是最后的手段**：

```bash
docker compose down
docker volume rm apple-icloud-mcp_token_store
docker compose up -d
```

代价只有一个：所有客户端要重新授权。**你的 iCloud 数据完全不受影响**——那个文件里只有 OAuth 客户端和令牌。

### 邮件工具凭空少了

服务器启动时会在 stderr 打印说明。多半是 `ICLOUD_SENDER_n` 没设而 Apple ID 不是 iCloud 邮箱地址（见准备工作第 2 步）。

```bash
docker compose logs app | head -20
```

---

## 五、另一条路：Routine 能用 shell 的时候

如果你的 Routine 跑在一个能执行 shell 命令的沙盒里，那么上面这一整套——买域名、配证书、装 Docker、生成 `ADMIN_PASSWORD_HASH` 和 `TOKEN_ENCRYPTION_KEY`、走一遍 OAuth 授权——**一条都不需要**。沙盒里直接 `git clone` + `npm ci` + `npm run build`，然后用命令行调用同一批工具（`apple_login` / `work_done` 除外，命令行自己管会话，所以是 23 个）。

完整步骤见 **[`沙盒-CLI-用法.md`](./沙盒-CLI-用法.md)**。

值得单独说一句的是**凭据放在哪**这条差别，它不是省事与否的问题：

远程 HTTP 部署有一个绕不开的约束——**凭据必须常驻在服务器上**。那台服务器要在任意时刻替任意一个已授权的客户端去连 iCloud，所以 App 专用密码必须一直放在它的 `.env` 里、一直可用。这意味着你得信任那台机器和管它的人；也意味着一台服务器服务多个人时，所有人的凭据都堆在同一个地方，一次入侵就是全部。这份文档前面所有关于 `TOKEN_ENCRYPTION_KEY`、`.dockerignore`、令牌吊销的讲究，本质上都是在处理这个约束带来的后果。

沙盒 CLI 这条路**根本没有这个约束**：**每个人带自己的 `.env`**，凭据只存在于那个人自己的沙盒里，随沙盒销毁而消失，不需要任何一台共享的机器长期持有它。没有需要吊销的令牌，因为压根没发过令牌；没有要保护的加密密钥，因为没有要加密的令牌库。

代价是这条路只在 Routine 有 shell 时才存在。如果你的 Routine 只能挂 MCP 连接器，那就还是走远程 HTTP，回到上面第「二」节。

---

## 六、几条限制，先知道比后来发现好

- **不支持 iCloud 备忘录。** Apple 没有能配合 App 专用密码使用的标准协议。
- **附件不能下载也不能发送。** `mail_read` 只返回附件的元信息。
- **联系人头像取不到。** 只能知道有没有，取不到图。
- **重复日程会在夏令时切换时漂移一小时。** 创建的事件以 UTC 锚定，没有 `timezone` 参数。单次事件不受影响。如果你在有夏令时的时区、又需要固定本地时间的重复日程，用 Apple 自带客户端建。
- **通讯录搜索是会话内缓存匹配**，不是服务端查询。见上文第 2 节。
