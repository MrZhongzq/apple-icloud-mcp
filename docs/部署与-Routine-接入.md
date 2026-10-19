# 部署这台 MCP 服务器，并接到 Claude Routine

这份文档写给部署者（你），不是写给 AI 的。AI 读的是 `SKILL.md`。

---

## 先决定一件事：你需要哪种部署

这台服务器有三个入口：本地 stdio、远程 HTTP、沙盒 CLI。**它们共用同一套业务代码和同样那批工具**，区别只在怎么被驱动。远程 HTTP 又分两种登录方式：账号写在服务器的 `.env` 里，或者每个人用加密信封带上自己的账号。所以下表有四列：

| | 本地 stdio | 远程 HTTP（服务器 `.env` 账号） | 远程 HTTP + 信封 | 沙盒 CLI |
|---|---|---|---|---|
| 谁来启动 | 客户端把它当子进程拉起来 | 你自己在服务器上常驻运行 | 服务器主人在服务器上常驻运行（可以是你，也可以是你的朋友） | Routine 自己在沙盒 shell 里跑命令 |
| 怎么连上 | MCP over stdio | MCP over Streamable HTTP | MCP over Streamable HTTP，登录时交一个加密信封 | 不连——直接命令行调用 |
| 需要域名和证书 | 不需要 | **需要** | **需要**（服务器主人那边） | 不需要 |
| 需要 OAuth | 不需要 | 需要（服务器自带授权服务器，每人一把访问密钥） | 需要（同左） | 不需要 |
| 凭据放在哪 | 你自己电脑上 | **常驻在服务器上** | **每个人自己的 Routine 环境** | **每个人自己的沙盒里** |
| 能用于 Claude Code / 桌面端 | 可以 | 可以 | 可以，前提是 AI 能在仓库里跑 `node` | 不适用（它不是 MCP 连接器） |
| **能用于 Claude Routine** | **不能** | **能** | **能——前提是 Routine 有 shell，并拉取了这个仓库** | **能——前提是 Routine 有 shell；云端沙盒里邮件用不了** |

**Routine 在 Anthropic 的服务器上运行，不在你的电脑上**——它没法拉起你本机的一个子进程，所以本地 stdio 那条路对 Routine 走不通。剩下三条都能用于 Routine：

- **Routine 有 shell（Routine 的云端沙盒就是这样），只用日历、提醒事项、通讯录** → 走沙盒 CLI，最省事的一条，见第「八」节。云端沙盒拦掉了邮件端口，实测结论见 [`沙盒-CLI-用法.md`](./沙盒-CLI-用法.md) 第〇节。
- **Routine 有 shell，还要用邮件；或者想和别人共用一台服务器** → 走远程 HTTP + 信封。服务器替你连 IMAP/SMTP，凭据仍然只放在你自己的 Routine 环境里。先按第「二」节部署，再看第「四」节。
- **只能挂 MCP 连接器、没有 shell** → 走远程 HTTP，账号写在服务器的 `.env` 里，也就是第「二」「三」节讲的东西。这种方式只适合服务器只有你一个人用。

如果你只是想在自己电脑的 Claude Code 里用，那 stdio 更简单，看仓库 `README.md` 的 Install 一节即可，这份文档的后半部分你用不上。

---

## 一、准备工作（三条路都要）

### 1. Apple ID 与 App 专用密码

在 [appleid.apple.com](https://appleid.apple.com) → 登录与安全 → App 专用密码，生成一个。格式形如 `abcd-efgh-ijkl-mnop`。

**你的 Apple ID 必须开启双重认证**，否则 Apple 不提供 App 专用密码。

### 2. 确认你的 iCloud 邮箱地址

这一步最容易出错，值得单独说。

IMAP/SMTP 用 `ICLOUD_SENDER_n` 认证，CalDAV/CardDAV 用 `ICLOUD_ACCOUNT_n` 认证——**这是两个不同的字段**。如果你的 Apple ID 是 Gmail 或其他第三方地址（老账号常见），你必须额外设置 `ICLOUD_SENDER_n` 为你的 iCloud 邮箱地址（`@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn`）。

不设的话，服务器会**自动关闭该账号的邮件工具**并说明原因（`.env` 账号在启动时打印到 stderr；信封账号在 `apple_login` 返回的 `notices` 里），日历、提醒事项、通讯录不受影响。这是有意的保护——因为 Apple 的 IMAP 服务器会直接拒绝非 iCloud 用户名，而报出的 `AUTHENTICATIONFAILED` 看起来和"密码被吊销"一模一样，很容易误诊。

### 3. `.env` 存成 UTF-8

`.env` 必须是 UTF-8 编码。Windows PowerShell 5.1 里用 `>` 重定向写出来的文件是 UTF-16，读的一方看到的是一堆乱码，报出来的却是「缺少环境变量 ICLOUD_ACCOUNT_1」——变量明明写在里面。遇到这句报错而你确定写了，先查文件编码，在编辑器里另存为 UTF-8。

---

## 二、远程 HTTP 部署

这一节是服务器主人做的事。不论账号写在服务器 `.env` 里，还是每个人用信封登录，部署步骤都一样。

### 1. 你需要什么

- 一台能装 Docker 的服务器（1 核 1G 足够，实测容器常驻占用约 66MB）
- 一个域名，A 记录指向那台服务器的 IP
- 服务器的 80 和 443 端口可以从公网访问（Caddy 申请证书要用）。如果 80/443 已经被宝塔或别的 nginx 占用，看第「五」节。

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

记住你输入的**明文口令**——待会儿登录管理页 `/admin` 要用它，不是用哈希。管理员口令只用来登录管理页；连接器授权时用的是访问密钥（见第 7 步），管理员口令在授权页上不管用。

### 5. 写 `.env`

```bash
cat > .env <<'EOF'
# --- HTTP 入口（远程部署必填）---
PUBLIC_URL=https://mcp.你的域名.com
ADMIN_PASSWORD_HASH=上一步生成的哈希
TOKEN_ENCRYPTION_KEY=上一步生成的密钥

# --- iCloud 账号（可选）---
# 只有「服务器 .env 账号」那种用法才需要。每个人都用信封登录的话，这一段整个不写。
# 写了也不会自动生效：要在 /admin 页面「.env 账号」一节点「打开」。
# ICLOUD_ACCOUNT_1=你的AppleID@example.com
# ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop
# 如果 Apple ID 不是 iCloud 邮箱地址，必须设置这一项，否则邮件工具会被自动禁用
# ICLOUD_SENDER_1=你的iCloud邮箱@icloud.com

# --- 权限（读默认开、写默认关）---
# ALLOW_MAIL_READ_1=true
# ALLOW_MAIL_WRITE_1=false
# ALLOW_CALENDAR_READ_1=true
# ALLOW_CALENDAR_WRITE_1=false
# ALLOW_REMINDERS_READ_1=true
# ALLOW_REMINDERS_WRITE_1=false
# ALLOW_CONTACTS_READ_1=true
# ALLOW_CONTACTS_WRITE_1=false
EOF
chmod 600 .env
```

关于**写权限默认关闭**：这是有意的。上一版实现里写权限默认开启，一个拼错的变量名就静默放开了删除邮件的权限。现在你要一项项显式打开——想让 Routine 建日程就开 `ALLOW_CALENDAR_WRITE_1`，只想让它读邮件就全部保持 `false`。信封账号也守同一条规则，只不过变量写在每个人自己的环境里。

关于**代理信任**：`docker-compose.yml` 里已经给 app 服务写死了 `TRUST_PROXY: "true"`，你不用在 `.env` 里重复设置。它必须开着的原因是——Caddy 在前面，所有请求都从同一个容器 IP 进来；不开的话限流会把所有访客算成同一个来源，任何人都能耗尽授权页（`/access-login`）和 `/token` 的额度、把所有人锁在外面。

反过来，如果你**不用 compose**、把这台服务器直接暴露在公网上（不推荐），那就**不要**开 `TRUST_PROXY`——那种情况下 `X-Forwarded-For` 是调用方自己填的，信它等于让任何人伪造来源 IP。

### 6. 改域名并启动

编辑 `Caddyfile`，把示例域名换成你自己的，然后：

```bash
docker compose up -d
```

确认活着（这个端点不需要认证）：

```bash
curl https://mcp.你的域名.com/health     # 期望 {"status":"ok"}
```

第一次启动时，服务器会在令牌存储旁边生成一对信封密钥，存在 `envelope-key.json.enc`（容器里是 `/app/data/envelope-key.json.enc`，和令牌存储在同一个 `token_store` 卷里），用同一个 `TOKEN_ENCRYPTION_KEY` 加密。想放到别处，设 `ENVELOPE_KEY_PATH`。

### 7. 进管理页，给自己建一把访问密钥

浏览器打开 `https://mcp.你的域名.com/admin`，输入第 4 步的明文管理员口令。管理页上有四样东西：

- **访问密钥**：一张表，列出每把密钥的名字、创建时间、状态、上次使用时间，每行有「停用」/「启用」和「销毁」。
- **新建访问密钥**：填一个名字（1–64 个字符，只用来区分是谁的），点「新建」。页面会显示一次 `amk_…` 开头的明文密钥，**只显示这一次**，服务器只存它的哈希。现在就复制下来。
  - **复制完不要刷新这个页面。** 那个页面是「新建」这次提交的结果，刷新会把表单再提交一次，又建出一把同名的新密钥（浏览器会先弹窗问你是否重新提交）。要回到列表，点地址栏重新打开 `/admin`。万一多建了一把，在列表里把多出来的那把销毁即可。
- **.env 账号**：一个开关，默认「已关闭」。打开后，**任何一把有效的访问密钥**都能登录服务器 `.env` 里配置的账号。服务器只有你一个人用、又想用 `.env` 账号时才打开；关掉时，已经用 `.env` 账号建立的会话会一并销毁。
- **信封公钥**：一行 `amp1_…` 开头的文本，给用信封登录的人写进他的 `MCP_ENVELOPE_PUBKEY`，见第「四」节。

管理页的登录 30 分钟不操作就过期，服务器重启后也要重新登录。

先给你自己建一把，下一节连接器授权要用。

---

## 三、接到 Claude Routine

### 1. 先把它加成连接器

在 claude.ai 的设置里添加自定义连接器 / 远程 MCP 服务器，地址填 **`https://mcp.你的域名.com/mcp`**（注意末尾的 `/mcp`）。

然后会发生这些事，全自动：

1. Claude 读取 `/.well-known/oauth-authorization-server` 发现授权方式
2. 动态注册自己为一个客户端
3. 打开浏览器跳到你这台服务器的**「输入访问密钥」页面**
4. **你粘贴上一节建的那把访问密钥**（`amk_…`）
5. 跳回 Claude，拿到令牌，连接建立

授权页只认访问密钥，不认管理员口令。每个人用自己的那一把，所以你在管理页上能看到每把密钥上次连接是什么时候，也能单独停掉其中一个人。

### 2. 在 Routine 里使用

连接器加好之后，在创建 Routine 时把它选上，Routine 运行时就能调用那 25 个工具。

**登录用哪个 iCloud 账号，取决于你选的方式：**

- 账号写在服务器 `.env` 里：先在 `/admin` 打开「.env 账号」，AI 按 `SKILL.md` 用 `apple_login` 登录即可。
- 用信封登录：Routine 还要有 shell、要拉取这个仓库、环境里要有你的 iCloud 变量和 `MCP_ENVELOPE_PUBKEY`。步骤见第「四」节的「使用者要做的事」，你自己也按那几步做。

**Routine 是无人值守的，有几件事值得你在写指令时想清楚：**

- **它每次运行都是全新的会话。** AI 会按 `SKILL.md` 在开头登录、结束时登出，信封也是每次运行现生成一个，你不用管。
- **写操作会真的改你的数据，而且没人在旁边看。** 如果指令是"每天早上把今天的日程整理成提醒"，那它每天都会真的创建提醒。建议第一次先用只读的指令跑几天，确认它理解得没错，再开写权限。
- **重复运行不会自动去重。** 服务器不做这件事。`SKILL.md` 里已经要求 AI 在创建前先搜索、已存在就跳过，但你的指令写得越具体，它做对的概率越高。
- **第一次调用通讯录搜索会慢几秒**（实测 1429 个联系人约 4.5 秒），因为 iCloud 不支持服务端过滤，只能整份拉下来在会话内缓存。这不是卡住了。

### 3. 想撤销授权的时候

**撤销某一个人**：在 `/admin` 的密钥表里点那把密钥的「停用」或「销毁」。

- **停用**：立刻吊销这把密钥签出的全部令牌，销毁它建立的全部会话（连同底层的 iCloud 连接），关掉它的 MCP 连接。密钥记录保留，以后可以「启用」；启用后要重新在 claude.ai 里授权一次，旧令牌不会复活。
- **销毁**：先做和停用一样的切断，再删掉这条记录。销毁前有一个确认页，删掉的不能恢复；那个人要再连，你得另发一把新的。

切断是当场生效的，其他人的连接不受影响。

**一次清掉所有人**（比如你怀疑 `TOKEN_ENCRYPTION_KEY` 泄露了）：

```bash
docker compose down
docker volume rm apple-icloud-mcp_token_store     # 卷名是「项目名_token_store」，用 docker volume ls 确认
docker compose up -d
```

这会清空卷里的两个文件：

- 令牌存储 `tokens.json.enc`：全部访问密钥、已授权的客户端、「.env 账号」开关（回到关闭）；
- 信封密钥 `envelope-key.json.enc`：服务器会生成新的一对，所有用信封的人都要换新的 `MCP_ENVELOPE_PUBKEY`。

之后要回 `/admin` 重新建密钥、重新分发。**你的 iCloud 数据完全不受影响**。

---

## 四、和别人共用一台服务器（信封登录）

这一节讲的模式是：

- **服务器主人管「谁能连上这台 MCP」。** 给每个人发一把访问密钥。
- **每个人管「连上以后用哪个 iCloud 账号、开哪些权限」。** 这些写在他自己 Routine 环境的 `.env` 或环境变量里，写法和平时一样。服务器上不预先存任何人的 iCloud 密码。
- **凭据装在加密信封里交给服务器。** Routine 在沙盒里跑一个脚本，把 iCloud 变量封进一个只有服务器私钥能打开的信封；AI 把信封作为 `apple_login` 的参数交给服务器。明文密码不进对话。

信封必须走工具参数，是因为 Routine 里的连接器调用不是从沙盒发出的：是 claude.ai 的后端在连服务器，OAuth 授权也只在浏览器里做一次。沙盒里的 `.env` 碰不到那条连接，凭据唯一能走的路就是「沙盒脚本输出密文 → 模型把密文交给 `apple_login` → 服务器解密」。

### 主人要做的事

1. 按第「二」节部署好服务器。
2. 进入 `/admin`，为对方新建一把访问密钥，名字写成能认出是谁的。复制完不要刷新页面（原因见第「二」节第 7 步）。
3. 把两样东西发给对方：
   - 那把访问密钥（`amk_…`），用于连接器授权；
   - 管理页上的信封公钥（`amp1_…`），写进他的 `MCP_ENVELOPE_PUBKEY`。

   访问密钥要走私密渠道发，它就是对方连上服务器的凭证。公钥不怕公开，但要确保对方拿到的是完整的一行。

「.env 账号」开关保持关闭。开着的话，对方不带信封调 `apple_login`，登录进的是**你**的 iCloud。

### 使用者要做的事

1. 从主人那里拿到访问密钥和信封公钥。
2. 在 claude.ai 添加连接器，地址是主人给的 `https://<主人的域名>/mcp`。授权页上输入你的访问密钥。
3. 在 Routine 的环境里设置你自己的 iCloud 变量（环境变量，或者仓库根目录的 `.env`，存成 UTF-8），并加上 `MCP_ENVELOPE_PUBKEY`：

   ```bash
   ICLOUD_ACCOUNT_1=your-name@icloud.com
   ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop
   # Apple ID 不是 iCloud 邮箱地址时必须补这一项，否则邮件工具会被自动禁用
   # ICLOUD_SENDER_1=your-alias@icloud.com

   # 读默认开、写默认关。要写就显式打开。
   ALLOW_MAIL_WRITE_1=false
   ALLOW_CALENDAR_WRITE_1=false
   ALLOW_REMINDERS_WRITE_1=false
   ALLOW_CONTACTS_WRITE_1=false

   MCP_ENVELOPE_PUBKEY=amp1_主人给你的那一行
   ```

   信封只装账号 1 的这 12 个变量：`ICLOUD_ACCOUNT_1`、`ICLOUD_APP_PASSWORD_1`、`ICLOUD_SENDER_1`、`ICLOUD_LABEL_1` 和八个 `ALLOW_*_1`，其余变量一概不装。配了 `ICLOUD_ACCOUNT_2` 及以上，脚本会直接拒绝：一个信封只装一个账号。
4. 让 Routine 拉取这个仓库，并在指令里告诉它读仓库根目录的 `SKILL.md`。AI 会按里面「Envelope login」一节的三步做：
   1. 运行 `node scripts/make-envelope.mjs`，把输出的那一整行作为 `apple_login` 的 `envelope` 参数；
   2. 正常调用工具；
   3. 最后 `work_done`。

   Routine 如果在**别的仓库**里、不想带上整个本仓库：只复制 `scripts/make-envelope.mjs` 这一个文件，再把几行规则贴进 Routine 的指令，就够了。做法见 [`远程连接-单脚本接入.md`](远程连接-单脚本接入.md)。

关于那个脚本：

- 不需要 `npm ci`，也不需要 `npm run build`。它零依赖，只要 Node 20 以上。
- 不带参数时读当前目录的 `.env`（有的话）和进程环境变量，**进程环境变量优先**。
- 要读指定文件，写成 `node scripts/make-envelope.mjs -- --env-file <路径>`。中间那个 `--` 不能省：Node 24 起，`node` 自己会抢先处理命令行上的 `--env-file`，文件不存在时直接以退出码 9 退出，轮不到脚本报错。
- stdout 只有一行 `ame1.…` 开头的信封。出错时退出码 1，stderr 上一行中文原因，只提变量名，从不打印任何变量的值。
- 不联网。公钥来自你的配置，所以沙盒能不能访问服务器域名都不影响它。
- 信封从生成起 5 分钟内有效，并且只能用一次。服务器一收下它就作废，**即使接下来的 iCloud 登录失败了也一样**——所以看到「这个信封已经用过」时，重新生成一个再试一次就好。

你的权限由你自己的 `ALLOW_*_1` 决定，服务器不另设上限。想打开某项写权限，改你自己的环境变量，下一次运行生成的信封就带上了。

### 信任说明：使用者必须信任服务器主人

服务器要替你连接 iCloud，所以**会话期间，你的 App 专用密码以明文形式存在服务器的内存里**，直到会话结束。服务器主人，或者攻破了这台服务器的人，可以读到所有活动会话的密码。

能保护的：

- 服务器磁盘上不存任何人的 iCloud 密码。
- 对话记录里只有密文。
- 截获的信封 5 分钟后失效，5 分钟内也只能用一次。
- 每个人只能用自己的会话：别人拿到你的 `session_id`，用他自己的密钥也用不了。
- 撤销一个人不影响其他人，而且是当场切断。

### 已知风险

- **服务器内存里有明文密码。** 见上面的信任说明。
- **服务器磁盘加上截获的信封，就等于密码。** 信封私钥在 `envelope-key.json.enc` 里，解开它的 `TOKEN_ENCRYPTION_KEY` 在同一台机器的 `.env` 里。如果有人同时拿到服务器的磁盘和某段对话记录里的信封，即使信封早已过期，他也能解出里面的密码。
- **服务器进程重启会清空「用过的信封」记录。** 重启前 5 分钟内用过的信封，在重启后剩下的有效期内可以再被用一次。前提是对方同时持有一把有效的访问密钥，因为连 `/mcp` 先要过 OAuth。

第一版不做信封密钥轮换。

### 服务器泄露了怎么办

1. **每个使用者**到 [appleid.apple.com](https://appleid.apple.com) 吊销旧的 App 专用密码，重新生成一个，更新自己的环境变量。
2. **主人**重建信封密钥对：删除 `envelope-key.json.enc`，然后重启。

   ```bash
   docker compose exec app rm /app/data/envelope-key.json.enc
   docker compose restart app
   ```

   重启时服务器发现文件不在，会生成新的一对。访问密钥、已授权的客户端都不受影响。
3. **主人**把 `/admin` 上的新公钥发给每个人，换掉他们的 `MCP_ENVELOPE_PUBKEY`。在换之前，用旧公钥封的信封会被拒绝，报「信封是用另一把公钥加密的」。

如果怀疑整台机器都被攻破了，再换掉 `TOKEN_ENCRYPTION_KEY` 和管理员口令。换了 `TOKEN_ENCRYPTION_KEY` 之后，令牌存储和信封密钥都解不开了，要按第「三」节第 3 步把卷整个清掉、从头建密钥。

---

## 五、放在宝塔或已有的 nginx 后面

仓库自带的 `docker-compose.yml` 让 Caddy 占用 80/443 并自动签证书。如果这两个端口已经被宝塔（BT-Panel）或你自己的 nginx 占着，就不用 Caddy，改用 `deploy/` 下的两个模板：

- `deploy/compose.vps.yml.example`：只跑 app，端口只绑 `127.0.0.1:17733`；
- `deploy/nginx-site.conf.example`：nginx 站点配置，把 `https://mcp.example.com` 反代到 `127.0.0.1:17733`。

步骤：

1. 按第「二」节第 1–5 步准备好仓库和 `.env`。`TRUST_PROXY` 由 compose 模板设置，不用写进 `.env`。
2. 启动 app：

   ```bash
   cp deploy/compose.vps.yml.example compose.vps.yml
   docker compose -f compose.vps.yml up -d --build
   curl http://127.0.0.1:17733/health          # 期望 {"status":"ok"}
   ```

   镜像在本机构建。小内存机器上要几分钟、会吃 swap，属正常。
3. 把 `deploy/nginx-site.conf.example` 里的 `mcp.example.com` 全部换成你的域名，放进 nginx 的站点目录。宝塔上放在 `/www/server/panel/vhost/nginx/<你的域名>.conf`，**手写，不要在宝塔面板里建站**：面板会覆盖它，或者让它不生效。
4. 签证书。证书文件不存在时，nginx 会因为 443 那段配置加载失败。所以第一次先只保留 80 的 server，把其中的 `return 301` 临时换成 `return 404`，用 certbot 的 webroot 方式签证书（webroot 就是模板里 `/.well-known/acme-challenge/` 那个 `root`），签下来以后再换回完整的配置。续期时用 deploy hook 重载 nginx。
5. 重载 nginx，确认 `curl https://mcp.你的域名.com/health` 返回 `{"status":"ok"}`，然后接着做第「二」节第 7 步。

模板里每一项覆盖都有原因，不要删：

- **`proxy_cache off`**：宝塔的全局 `proxy.conf` 打开了 `proxy_cache`。OAuth 和 MCP 的响应是发给特定某个人的，被缓存下来再交给下一个人，就是把一个人的令牌或数据交给了另一个人。
- **`proxy_next_upstream off`**：全局配置对 500/503/404 会换一个上游重试。这里只有一个上游，"重试"等于把同一个请求再发一次——重放一个 `mail_send` 就是发两封信。
- **`proxy_set_header X-Forwarded-For $remote_addr`**：用**覆盖**，不用 `$proxy_add_x_forwarded_for` **追加**。app 开着 `TRUST_PROXY`，express 取这个头的最左端当客户端地址；追加的话，调用方自己写的值留在最左端，等于让任何人自选限流桶，不限次数地试访问密钥和管理员口令。
- **`proxy_buffering off` / `proxy_request_buffering off`**：MCP 的 SSE 流要逐块送达，不能攒在 nginx 里。
- **`proxy_read_timeout` / `proxy_send_timeout 3600s`**：全局是 60 秒，会把 `GET /mcp` 的长连接掐断。

`TRUST_PROXY=true` 在这里安全，前提是两条同时成立：端口只绑 `127.0.0.1`，公网到不了 17733；nginx 覆盖了 `X-Forwarded-For`。少一条都不能开。

两个宝塔特有的坑：

- **`nginx -s reload` 之后要等几秒。** 新 worker 接手需要时间（WAF 插件会拖慢它），reload 之后立刻测，打到的可能还是旧 worker，看起来像配置没生效。
- **宝塔 WAF 是全局挂载的**，也会检查这个站点的流量。MCP 出现莫名的 403，先查 WAF。

用这套 compose 时，这份文档里其他地方的 `docker compose …` 命令都要加上 `-f compose.vps.yml`；卷名也跟着项目名变，用 `docker volume ls` 确认。

---

## 六、从旧版本升级

引入访问密钥之前的版本，授权页输入的是管理员口令。升级之后：

- **已有的连接器授权全部失效。** 那时签出的令牌不属于任何一把访问密钥，升级后一律拒绝，连接器会收到 401。处理办法：用原来的管理员口令登录 `/admin`，给自己建一把访问密钥，然后在 claude.ai 里重新连接这个连接器（不行就删掉重新添加），在授权页输入新密钥。
- **服务器 `.env` 里的账号默认不可用。** 「.env 账号」开关默认关闭，启动日志里会有一条警告，说配置了账号但没有启用。还想像以前那样用 `.env` 里的账号，就在 `/admin` 打开它；改用信封登录的话，可以把这些账号从服务器的 `.env` 里删掉。
- **管理员口令不再能用于授权**，只用来登录 `/admin`。

本地 stdio 和沙盒 CLI 不受影响，升级后什么都不用改。

---

## 七、出问题时

以下几种情况的表面症状都有误导性，值得单独记住：

### 所有请求都返回 401，令牌明明是刚发的

客户端注册时用的 `PUBLIC_URL` 和现在配置的不一致，元数据里的 issuer 对不上。

**去查域名，不是去查令牌。** 把 `PUBLIC_URL` 改成客户端实际访问的那个域名，然后在 Claude 里**重新添加连接器**——已有的注册记录改不了 issuer，只能重新注册。

如果是刚升级完就 401，那是旧令牌被拒绝了，见第「六」节。如果只有某一个人 401，看看他的密钥是不是在 `/admin` 里被停用了。

### 授权页提交之后没反应，或者说「登录请求不存在或已过期」

待授权请求过期了。它只在内存里留 10 分钟，从你第一次打到 `/authorize` 算起。

**不要反复重试那个表单**——它绑定的 `request_id` 已经没了。回到 Claude 重新发起一次连接。

同一张授权页已经成功提交过、又提交一次（刷新、双击、回退重发）时，显示的是「授权已完成」：授权其实成功了，关掉页面回 Claude 即可。

授权页说「访问密钥不正确或已停用」：密钥贴错了（多了空格、少了一截），或者已经在 `/admin` 里被停用、销毁；也可能是你贴的是管理员口令，授权页不认它。这句话不会让授权请求失效，改好之后在同一张页面上再提交就行。提交太多次会被限流一段时间（每个来源地址 15 分钟内 20 次）。

### 服务器起来了，但没有任何客户端能完成授权；或者根本起不来

令牌存储解不开，几乎总是因为 `TOKEN_ENCRYPTION_KEY` 变了。启动日志会说是哪个文件解不开（「令牌存储无法解密」或「信封密钥文件无法解密」）。

`TOKEN_ENCRYPTION_KEY` 变了的话，两个文件都解不开，恢复办法是把卷整个清掉：

```bash
docker compose down
docker volume rm apple-icloud-mcp_token_store
docker compose up -d
```

代价：全部访问密钥、已授权的客户端和「.env 账号」开关都没了，要重新建密钥、重新授权；信封密钥对也是新的，所有用信封的人都要换 `MCP_ENVELOPE_PUBKEY`。**你的 iCloud 数据完全不受影响**——这两个文件里没有 iCloud 数据，也没有 iCloud 密码。

如果密钥没变、只是某一个文件坏了，只删那一个文件：

- 令牌存储坏了：`docker compose run --rm app rm /app/data/tokens.json.enc`，然后 `docker compose up -d`。信封密钥对不受影响。
- 信封密钥坏了：`docker compose run --rm app rm /app/data/envelope-key.json.enc`，然后 `docker compose up -d`。访问密钥与令牌不受影响，但所有用信封的人都要换新公钥。

### 信封登录失败

`apple_login` 的报错会说清楚是哪一种：

- **「信封已过期」/「这个信封已经用过」**：重新运行脚本生成一个新的，再试一次。信封只能用一次，iCloud 登录失败也会把它用掉。
- **「信封是用另一把公钥加密的」/「信封无法解密」**：`MCP_ENVELOPE_PUBKEY` 和服务器当前的公钥对不上。多半是主人重建过密钥对，向他要 `/admin` 上的当前公钥。
- **「这台服务器只接受加密信封登录」**：没带信封、「.env 账号」开关又是关的。这是预期行为，按第「四」节用信封登录。
- **脚本报「缺少环境变量 ICLOUD_ACCOUNT_1」，可变量明明写了**：先查 `.env` 是不是 UTF-8（见第「一」节第 3 步）。

### 邮件工具凭空少了

多半是 `ICLOUD_SENDER_n` 没设而 Apple ID 不是 iCloud 邮箱地址（见准备工作第 2 步）。服务器 `.env` 里的账号，启动时会在 stderr 打印说明：

```bash
docker compose logs app | head -20
```

信封账号的说明不在服务器日志里，在 `apple_login` 返回的 `notices` 里。

---

## 八、另一条路：Routine 能用 shell 的时候

如果你的 Routine 跑在一个能执行 shell 命令的沙盒里（Routine 的云端沙盒就是这样），那么上面这一整套——买域名、配证书、装 Docker、生成 `ADMIN_PASSWORD_HASH` 和 `TOKEN_ENCRYPTION_KEY`、走一遍 OAuth 授权——**一条都不需要**。沙盒里直接 `git clone` + `npm ci` + `npm run build`，然后用命令行调用同一批工具（`apple_login` / `work_done` 除外，命令行自己管会话，所以是 23 个）。

完整步骤见 **[`沙盒-CLI-用法.md`](./沙盒-CLI-用法.md)**。

**先知道一个限制：云端沙盒里邮件用不了。** 2026-10-18 实测，IMAP 993 和 SMTP 587 在「受限」「完全」两档网络下都被拦截；日历、提醒事项、通讯录走 443，可以用。要用邮件，就走第「四」节的远程连接器加信封；不用邮件，就在 `.env` 里设 `ALLOW_MAIL_READ_1=false`，让 CLI 只用另外三个模块。详见 `沙盒-CLI-用法.md` 第〇节。

值得单独说一句的是**凭据放在哪**这条差别，它不是省事与否的问题：

远程 HTTP 用服务器 `.env` 账号时，有一个绕不开的约束——**凭据必须常驻在服务器上**。那台服务器要在任意时刻替任意一个已授权的客户端去连 iCloud，所以 App 专用密码必须一直放在它的 `.env` 里、一直可用。这意味着你得信任那台机器和管它的人；也意味着一台服务器服务多个人时，所有人的凭据都堆在同一个地方，一次入侵就是全部。这份文档前面所有关于 `TOKEN_ENCRYPTION_KEY`、`.dockerignore`、令牌吊销的讲究，本质上都是在处理这个约束带来的后果。

信封登录把这个约束缩小了：凭据平时只在每个人自己的环境里，只在会话期间以明文存在服务器内存里（见第「四」节的信任说明）。沙盒 CLI 则**根本没有这个约束**：**每个人带自己的 `.env`**，凭据只存在于那个人自己的沙盒里，随沙盒销毁而消失，不需要任何一台共享的机器持有它，哪怕是暂时的。没有需要吊销的令牌，因为压根没发过令牌；没有要保护的加密密钥，因为没有要加密的令牌库。

代价是这条路只在 Routine 有 shell 时才存在，而且在云端沙盒里用不了邮件。

---

## 九、几条限制，先知道比后来发现好

- **远程 HTTP 入口在会话期间持有明文 App 专用密码。** 信封登录也一样：服务器要替你连 iCloud，会话结束前密码就在它的内存里。用别人的服务器，就得信任它的主人。见第「四」节。
- **不支持 iCloud 备忘录。** Apple 没有能配合 App 专用密码使用的标准协议。
- **附件不能下载也不能发送。** `mail_read` 只返回附件的元信息。
- **联系人头像取不到。** 只能知道有没有，取不到图。
- **重复日程会在夏令时切换时漂移一小时。** 创建的事件以 UTC 锚定，没有 `timezone` 参数。单次事件不受影响。如果你在有夏令时的时区、又需要固定本地时间的重复日程，用 Apple 自带客户端建。
- **通讯录搜索是会话内缓存匹配**，不是服务端查询。见上文第「三」节第 2 步。
