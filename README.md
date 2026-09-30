# chatglm-panel —— 智谱清言多账号池面板

一个把多个 **chatglm.cn** 账号聚合成 **OpenAI 兼容 API 网关** 的面板，附带手机号登录、自动签到、自动续期、用量统计。后端零依赖（仅 Node 内置模块），前端为 Vite + Vue 3 + Naive UI，可容器化部署。

---

## 快速开始（Docker）

```bash
# 构建并启动（首次会自动构建镜像并安装前端依赖）
docker compose up -d --build

# 浏览器打开
open http://127.0.0.1:8788/
```

- 服务端口 `8788`，日志与账号数据挂载在 `./data`（`data/config.json`、`data/accounts.json`、`data/requests.log`）。
- **账号通过挂载加载**：把你的 `data/accounts.json`（及可选的 `data/config.json`）放到宿主机的 `./data` 目录即可，容器启动后自动读取；面板内新增的账号也会写回该目录。
- 停止：`docker compose down`。更新：重新 `docker compose up -d --build`。

> 数据目录含账号 token 明文，**请勿提交到版本库、勿外发**。

---

## 本地运行（无 Docker）

```bash
# 1) 构建前端（生成 public/index.html，单文件内联）
cd web && npm install && npm run build && cd ..

# 2) 启动后端
node server.js
```

前端开发模式（热更新，API 已代理到 8788）：

```bash
cd web && npm run dev
```

---

## 添加账号

### 方式一：手机号登录（推荐）
点「账号池」页的 **📱 手机号登录** → 输入手机号 → 获取验证码 → 完成官方滑块验证 → 回填短信码登录，账号自动入池。

### 方式二：手动粘贴 token
登录 <https://chatglm.cn> → F12 → Application → Local Storage → 复制 `chatglm_token`（JWT）；可选复制 `chatglm_refresh_token` 实现自动续期。粘贴到「账号池」页即可。

> token 仅保存在 `data/accounts.json`，面板接口只回传掩码，永不回传明文。

---

## 功能

- **多账号池**：轮询策略 `round_robin` / `least_used` / `failover`；401/403/429/5xx 或连接异常自动换号重试。
- **自动签到**：每日定时批量签到，启动补签当天。
- **自动续期**：临近过期用 `refresh_token` 自动续期。
- **OpenAI 兼容网关**：`GET /v1/models`、`POST /v1/chat/completions`（流式 & 非流式），支持 `glm-5.3`、`glm-5.3-flash`。
- **OAuth2 授权码**：`/oauth/authorize` → `/oauth/token` → `/oauth/userinfo`，供第三方客户端登录。

---

## 配置（`data/config.json`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `8788` | 监听端口 |
| `host` | `127.0.0.1` | 监听地址（容器内默认 `0.0.0.0`，可用环境变量 `HOST`/`PORT` 覆盖） |
| `api_key` | 自动生成 | 网关 Bearer 鉴权密钥，空则不鉴权 |
| `default_model` | `glm-5.3-flash` | 默认模型 |
| `assistant_id` | 内置 | chatglm 助手 ID |
| `rotation` | `round_robin` | 轮询策略 |
| `max_failover` | `3` | 单请求最大换号次数 |
| `checkin_enabled` | `true` | 自动签到 |
| `checkin_time` | `08:05` | 每日签到时间（本地时区） |
| `refresh_enabled` | `true` | 自动续期 |

环境变量（容器/部署场景）覆盖：`HOST`、`PORT`、`PANEL_OPEN_BROWSER`。

---

## 安全提示

- 面板**无后台密码**，默认监听 `127.0.0.1`；Docker 下监听 `0.0.0.0` 时，**请勿直接暴露到公网**，建议加反向代理鉴权。
- `data/` 含账号 token 明文，已加入 `.gitignore`，切勿提交或外发。

---

## 目录结构

```
chatglm-panel/
├─ Dockerfile / docker-compose.yml   容器化部署
├─ server.js                         后端（单文件零依赖）
├─ public/index.html                 前端构建产物（单文件，内联 CSS/JS）
├─ web/                              前端源码（Vite + Vue3 + Naive UI）
│   ├─ package.json / vite.config.js
│   └─ src/  (main.js / store.js / App.vue / components/*)
└─ data/                            运行时数据（挂载卷，含凭据，勿外传）
    ├─ config.json
    ├─ accounts.json
    └─ requests.log
```
