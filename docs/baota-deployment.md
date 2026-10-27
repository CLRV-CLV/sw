# 宝塔部署与数据保留更新

> **本次特例：** 根据本次升级要求，首次启动会一次性强制清空旧 AI 角色目录、来源资料与角色提示词，并取消旧待执行任务；账号、货币、文章、历史聊天和完成日志保留。先做完整备份。后续重启不重复清空新导入角色。更新后在后台执行“萌娘百科全角色提示词流水线”，不会自动产生真实模型档案。详见 `resident-ai.md`。

## 项目类型

- **Node.js Web 项目**，不是PHP、Java或Python项目。
- 前端：Vue3 / Nuxt4 / TypeScript，生产构建成静态文件。
- 后端：Node.js 原生HTTP服务，ES Module JavaScript（`.mjs`）。后端同时提供API、WebSocket、静态前端。
- 数据库：Node内置SQLite，**不需要MySQL、Redis或单独SQLite服务器**。
- 使用 **Node.js 22.16+，建议22.22+的22.x版本**，因为需要 `node:sqlite` 及在线备份接口。不要选Node18/20。

## 1. 下载代码

安装宝塔的Node项目管理器/Node版本管理、Nginx、Git（Linux还需`flock`，通常由util-linux提供）。确保终端中 `node -v` 和 `npm -v` 是正确版本；宝塔界面选对版本不等于SSH的PATH也选对。

在这次代码已经推送到GitHub后执行（本地未推送修改无法通过clone获得）：

```sh
cd /www/wwwroot
git clone --branch arena/fd457726-sw --single-branch https://github.com/CLRV-CLV/sw.git sw
cd sw
cp .env.example .env
```

编辑 `.env`：

```dotenv
PORT=3000
DATA_DIR=/www/wwwroot/sw/server/data
AUTO_FIRST_ADMIN=1
SECURE_COOKIE=1
SEED_DEMO=0
```

- `DATA_DIR` 必须是绝对路径，后续更新不要更换它。默认路径也是 `server/data`。
- `.env` 只在首次安装时复制；更新时不要再执行cp覆盖配置。
- `SECURE_COOKIE=1` 用于HTTPS网站；纯HTTP临时测试用0，否则浏览器不会发送登录Cookie。
- `SEED_DEMO=0` 不导入演示帖子；不清除已存在帖子。
- `.env`、数据库、backups目录只允许服务运行账号和部署者读取。
- 不要以宝塔项目管理器环境变量和 `.env` 配置两套不同的DATA_DIR。环境变量优先于.env，更新脚本也使用同样的Node解析方式；以.env作为唯一部署配置最容易保持一致。

安装并构建：

```sh
npm ci --prefix server --registry=https://registry.npmjs.org/
npm ci --prefix web --include=dev --registry=https://registry.npmjs.org/
npm run build:web --prefix server
```

构建需安装前端开发依赖，不要先用 `npm ci --omit=dev`。低内存服务器需要额外交换空间或在更高配置机器构建，不能把构建中断当作成功。

## 2. 宝塔新建Node项目

各宝塔插件字段名可能不同，填写原则如下：

| 项 | 值 |
| --- | --- |
| 项目类型 | Node.js项目 |
| 项目名称 | sw-interknot（可自定） |
| 项目/运行目录 | `/www/wwwroot/sw/server` |
| Node版本 | 22.16+（建议22.22+） |
| 启动命令/运行脚本 | `npm start` / package.json中的 `start` |
| 端口 | 3000 |
| 运行账号 | 对项目及DATA_DIR有读写权限的非root账号 |
| 域名 | 自己的域名，配置HTTPS反向代理 |

`npm start` 实际执行：

```sh
node --env-file-if-exists=../.env index.mjs
```

工作目录必须是server。如果插件只允许选择启动文件：选择`server/index.mjs`，并在插件中配置与.env一致的环境变量；直接运行index.mjs不会自行读取.env。不要启动 `nuxt dev`，生产不需要再开一个前端端口。

命令行临时启动：

```sh
cd /www/wwwroot/sw/server
npm start
```

**宝塔进程管理器和独立PM2二选一**，不能两者同时管理同一个3000端口。若已经由宝塔管理，不要再手动开第二个node进程。

## 3. Nginx与WebSocket

将域名所有路径反代到 `http://127.0.0.1:3000`，包括 `/v1/`、`/media/`、`/web/admin`、`/h5/admin`。Nginx示意：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    client_max_body_size 8m;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

使用`$http_host`保留浏览器的实际Host和端口，避免HTTPS同源写入被拒绝；不要拼接`$host:$server_port`。附件通过JSON传输，5MB文件会被base64扩为约6.7MB，所以Nginx需要至少`client_max_body_size 8m`。上面是location示意，不要把它直接覆盖进完整server配置；先用宝塔/Nginx配置测试。

不要将Git仓库根目录作为可公开读取的静态目录，尤其不能开放`.env`、`server/data`、`.git`、`backups`。防火墙不向公网开放3000，只开放80/443。Node虽监听0.0.0.0，公网应经Nginx访问。

## 4. 首位管理员

安装时先通过IP白名单、临时站点密码或仅内网访问限制站点，自己注册第一个账号，再开放公网。空库第一个成功注册用户会成为管理员，没有默认密码。

后台入口：`/web/admin`、`/h5/admin`，也可以 `/admin` 自动适配。

更新已有站点不会自动提权旧账号。若已有用户却没有管理员，在.env设置 `ADMIN_USERNAMES=自己的已注册用户名` 并重启即可恢复，不需要清库。不要删数据库重置管理员。

## 5. 更新，不删除数据

```sh
cd /www/wwwroot/sw
./update.sh                         # 默认 arena/fd457726-sw
./update.sh main                    # 指定远端分支
./update.sh arena/fd457726-sw --restart none
```

脚本将：
1. 检查Node版本、工作树与更新锁。发现本地改动就停止，不强制覆盖。
2. 使用SQLite在线backup API备份数据库（包含WAL中的已提交事务），备份.env与旧commit号。
3. fetch指定分支，只有能fast-forward时才合入；不执行`reset --hard`、`git clean`或删除数据。
4. 重新安装依赖、构建前端。
5. 自动重启已存在的同名PM2进程；若由宝塔管理，则提示回宝塔点击“重启”。

**默认auto不保证识别所有宝塔内部进程名称。**宝塔管理模式推荐 `--restart none`，构建成功后点击项目重启。首次启动和之后更新均使用相同运行账号。

切换指定分支仅选取更新来源，脚本不会切换本地分支标识；目标与当前HEAD分叉时会安全拒绝，需部署者审查分支迁移，不会强制回滚。指定目标分支必须包含相容的数据库及启动逻辑，脚本不能保证任意旧版本兼容。

更新目录要是干净的Git checkout；服务器手改源码会阻止更新，.env/data/backups等被忽略的私有文件不受影响。GitHub私有仓库的SSH/部署密钥应在服务器配置，不能写进脚本或聊天。

### 独立PM2可选方案

如果不使用宝塔Node进程管理器，可用同一个Node22环境安装PM2并执行：

```sh
cd /www/wwwroot/sw
pm2 start ecosystem.config.cjs
pm2 save
# 根据pm2输出配置系统开机自启
./update.sh --restart pm2
```

进程名默认 `sw-interknot`，单实例fork模式（SQLite和内存OAuth状态不适合直接多实例）。自定义名称时运行更新脚本可设置 `PM2_APP_NAME`。

### 备份和失败处理

默认备份在 `backups/UTC时间-进程号/`，可用`BACKUP_DIR`指定仓库外目录。里面含数据库、.env、元信息及旧commit号，不能公开下载。SQLite备份是更新前的快照，更新过程中仍可能产生新数据，恢复旧快照会丢掉快照之后的写入。

脚本不自动删除历史备份，不自动回滚数据库，也不保证依赖安装/构建时完全无中断。失败时停止并保留备份与数据，阅读错误后再处理。数据库结构将来可能升级，不能随意只回滚代码。项目尚无用户上传目录；以后如增加媒体/对象存储，需额外备份，当前脚本只备份SQLite和.env。

原数据库仍保留在原DATA_DIR，update.sh不会用备份覆盖它。不要用重新clone后空的DATA_DIR替换老目录。由于当前前端构建同步到public是就地复制，更新过程中静态页面可能短暂不一致，建议维护窗口更新；此版本不宣称零停机原子部署。

更新后检查：`https://域名/health` 应返回 `{"ok":true}`，再验证登录、原帖子、管理后台及WebSocket。

## npm镜像404 / nuxt找不到

`https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/` 是Node运行时下载镜像，**不是npm包仓库**。不要把它填到npm registry。Node运行时镜像与npm包源是两个独立设置。

安装时使用官方npm源（项目.npmrc已配置，update.sh也显式传入）：

```sh
cd /www/wwwroot/sw
npm ci --prefix server --registry=https://registry.npmjs.org/ && \
npm ci --prefix web --include=dev --registry=https://registry.npmjs.org/ && \
npm run build:web --prefix server
```

用`&&`保证安装失败后不继续构建。无需删除数据库、.env或package-lock.json。`nuxt: command not found`通常是前端依赖安装失败，或生产环境省略了开发依赖；构建时明确`--include=dev`。无需全局安装nuxt。

如官方npm源在服务器网络无法访问，可自行选择可信的npm包镜像（例如`https://registry.npmmirror.com/`），而不是Node二进制镜像目录；设置`NPM_REGISTRY`可覆盖update.sh所用包源。项目不保证第三方镜像的可达性和同步进度。安装日志显示的Node26并非本项目推荐的22.x部署环境，建议同时在宝塔与SSH终端切换到22.22+的22.x版本。

### 已部署到5385端口的项目

上面的3000是首次部署示例。若现有项目使用`PORT=5385`和反代`127.0.0.1:5385`，**保持5385，不要因为更新改成3000**。在`/www/wwwroot/sw`执行：

```sh
node -v  # 建议22.22+，并确保宝塔项目与SSH使用兼容的Node版本
bash ./update.sh --restart none
```

成功后在宝塔Node项目管理里重启现有项目，再执行：

```sh
curl -fsS http://127.0.0.1:5385/health
git rev-parse --short HEAD
```

`/health`应返回`{"ok":true}`。重新打开站点并硬刷新，进入`/web/messages`（手机`/h5/messages`）验证好友和群聊。新表/字段由服务启动时自动增加，无需清库或重新注册；备份目录由脚本输出。若出现本地修改拒绝更新，先用`git status --short`审查，勿直接强制重置或删除数据目录。

本轮附件保存在SQLite内，更新脚本的在线数据库备份包含附件；未来若改用外部对象存储则需要单独备份策略。录音需HTTPS和浏览器麦克风授权，语音消息不等于实时语音通话。

### New API驻站AI（可选）

更新后可在后台“驻站AI / New API”配置，不需要把Key发到聊天里。默认HTTPS，可信内网HTTP部署需额外设置`AI_ALLOW_HTTP=1`。角色仍需Wiki导入、详细档案生成、审核及启用，详见[驻站AI部署与安全边界](resident-ai.md)。

`update.sh`现在备份存在的`DATA_DIR/.ai-config-key`，与SQLite配套保管；使用`AI_CONFIG_SECRET`时保留原环境变量。恢复数据库时不能丢失或更换其加密密钥。
