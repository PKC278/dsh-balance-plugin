# dsh-balance-plugin

DSH 客户端插件：在输入框下方的统计行里显示当前模型提供商对应的 DeepSeek 账户余额。

## 功能

- 位置：会话底栏（`conversation.composer.dock`）的第三项，位于自带的两项统计之后、上下文占用环之前
- 内容：卡片图标 +「余额 」+ 金额，随主题使用三级文本色
- 点击整行可强制刷新；请求进行中，金额之后显示旋转指示环
- 仅查询两个 DeepSeek 路由：`deepseek-official`（凭据 `DEEPSEEK_API_KEY`，请求头 `Authorization: Bearer`）与 `deepseek-account`（账户令牌，请求头 `x-dsh-auth-token`）。其他提供商既不显示该行，也不访问其凭据
- 每轮对话结束时自动请求一次

## 请求与缓存

宿主侧以「提供方 + 实际发送的凭据」的 SHA-256 指纹为键维护缓存，有效期 5 分钟：

| 触发 | 行为 |
| --- | --- |
| 点击刷新 | 强制请求平台，并重新开始计时 |
| 本轮完成 | 强制请求平台，并重新开始计时 |
| 新开对话首次显示 | 先读取缓存；仍在有效期内则直接复用，过期才请求平台 |
| 静默 5 分钟 | 定时器到点后读取缓存，已过期才请求平台；仅限当前对话的提供方 |

同一凭据在有效期内的多个会话共享结果。客户端另按提供方在页面生命周期内保留最近一次金额，因此切换对话时不会出现占位状态。

## 状态表现

| 状态 | 显示 |
| --- | --- |
| 请求进行中 | 金额位置显示旋转指示环，不显示 `--` |
| 成功 | `¥213.12` 形式的金额 |
| 请求失败、凭据缺失、账户不可用 | 弱化的 `--`，由行内文字色混出，明暗主题下均清晰可读 |
| 非 DeepSeek 提供商 | 整行不渲染 |

## 安装

包名 `@pkc278/dsh-balance`。可从 npm 安装，也可链接本地目录；两种方式均包含两步：使 profile 能够解析该包名，并将条目插入 profile 的 patch 层。

### 从 npm 安装

```bash
dsh plugin --profile desktop add @pkc278/dsh-balance

cat >> ~/.dsh/profiles/desktop/cordis.patch.yml <<'YAML'
- insert:
    - id: ui-balance
      name: "@pkc278/dsh-balance"
YAML
```

### 从本地目录链接（开发用）

```bash
# 1) 使 profile 解析到本地目录
mkdir -p ~/.dsh/profiles/desktop/node_modules/@pkc278
ln -sfn "$(pwd)" ~/.dsh/profiles/desktop/node_modules/@pkc278/dsh-balance

# 2) 插入 patch 条目
cat >> ~/.dsh/profiles/desktop/cordis.patch.yml <<'YAML'
- insert:
    - id: ui-balance
      name: "@pkc278/dsh-balance"
YAML
```

之后需**完全退出并重新打开** DSH 桌面应用。仅关闭窗口不会生效，客户端插件在应用启动时一次性组装。

卸载：删除 patch 条目与 `node_modules/@pkc278/dsh-balance`，随后重新启动应用。

## 开发与自检

不依赖任何第三方包，可直接使用 Node 执行契约检查：

```bash
node check-client.mjs   # 注册形态、槽位、状态、请求载荷、纯函数
node check-host.mjs     # 宿主路由：凭据解析、缓存命中、强制刷新、错误分支
```

两个脚本均以本地临时 HTTP 端点替代平台接口，不访问网络，也不使用真实凭据。

改动客户端代码后需重新启动应用方可生效。

## 可调项

| 项 | 位置 | 当前值 |
| --- | --- | --- |
| 轮询/静默窗口 | `lib/client.js` `REFRESH_INTERVAL_MS` | 300000（5 分钟） |
| 缓存有效期 | `lib/index.js` `DEFAULT_CACHE_TTL_MS` | 300000；可用 profile 条目的 `config.cacheTtlMs` 覆盖 |
| 失败重试间隔 | `lib/client.js` `RETRY_INTERVAL_MS` | 15000 |
| 点击冷却 | `lib/client.js` `MIN_CLICK_INTERVAL_MS` | 1000 |
| 点击反馈最短时长 | `lib/client.js` `FEEDBACK_FLOOR_MS` | 300 |
| 余额接口根地址 | `lib/index.js` `DEFAULT_BASE_URL` | `https://api.deepseek.com`，可用 `config.baseUrl` 覆盖 |

## 结构

```
lib/index.js    宿主侧：凭据解析、缓存、余额接口请求、同源路由 /api/dsh-balance
lib/client.js   客户端：槽位注册、状态渲染、按提供方请求与保留、旋转指示环
check-client.mjs 客户端契约检查
check-host.mjs   宿主契约检查
```

宿主侧路由以每次启动随机生成的令牌校验调用方；页面通过启动注入获得端点与令牌。凭据仅在宿主进程内使用，不进入页面。
