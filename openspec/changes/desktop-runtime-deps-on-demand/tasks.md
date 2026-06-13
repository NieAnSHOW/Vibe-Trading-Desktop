# Implementation Tasks — desktop-runtime-deps-on-demand

> 任务按依赖排序。标注 `[spike]` 的为需先验证才能定稿的探查任务，建议在 comet-design 阶段优先处理。

## 1. 可写依赖目录与 sidecar 模块搜索集成

- [x] 1.1 在 `src-tauri/src/runtime_dir.rs` 扩展 `Layout`，新增 `runtime_libs: ~/.vibe-trading/runtime/libs` 字段及其创建逻辑
- [x] 1.2 实现 `runtime_libs` 在版本升级迁移时被显式保留（与 `.env` 同级，不随 bundle 模板覆盖）
- [x] 1.3 在 Python 入口（`cli` 加载早期）以 `sys.path.append(runtime_libs)` 注入，确保排在 bundle `site-packages` **之后**
- [x] 1.4 编写断言：可写目录中同名包不覆盖核心打包依赖（核心版本优先）

## 2. 包管理器选型与平台 wheel 探查 [spike]

- [x] 2.1 `[spike]` 验证 uv 是否支持 `--target <libs_dir>` 写入指定目录，以及内嵌 uv 的跨架构体积与是否需要联网自举
- [x] 2.2 `[spike]` 对照标准库 pip 的可用性与速度，作出 uv vs pip 的最终选型（决策门槛：uv `--target` 可用且 +20MB 可接受 → uv；否则 pip）
- [x] 2.3 `[spike]` 建立 10+ 券商 SDK 在 macOS arm64 / x86_64 / Windows 的预编译 wheel 可用性矩阵
- [x] 2.4 按选型将包管理器纳入 bundle（`resources.rs` 解析、`tauri.conf.json` 声明 resource）或确认标准库 pip 可用

## 3. 可选依赖清单（registry）

- [x] 3.1 设计 `agent/src/optional_deps/registry.yaml` schema：券商/能力 → PyPI 包名 + 描述 + 平台 wheel 可用性标记 + 推荐镜像
- [x] 3.2 录入初始清单（至少：python-okx、futu-api、ib_async、longbridge、tigeropen、alpaca-py、dhanhq、shoonya、NorenRestApiPy、vnpy_ctp）
- [x] 3.3 实现 registry 加载模块（读取 + 校验包名白名单）

## 4. 后端安装/卸载/列表 API

- [x] 4.1 新增 `agent/src/optional_deps/` 模块：安装、卸载、列表、状态查询
- [x] 4.2 实现 `GET /optional-deps/list`：返回 registry 内容并扫描 `libs/` 的 `.dist-info` 标注已装状态
- [x] 4.3 实现 `POST /optional-deps/install`：registry 白名单校验 → spawn 包管理器子进程写入 `libs/`
- [x] 4.4 实现平台 wheel 预检：目标包在当前平台无预编译 wheel 时返回明确提示，不触发源码构建
- [x] 4.5 实现 `POST /optional-deps/uninstall`
- [x] 4.6 实现安装进度反馈：SSE 推送子进程 stdout / 阶段状态（复用 `sse-starlette`）
- [x] 4.7 实现镜像源配置读写端点（`GET/PUT /optional-deps/mirror`），持久化到用户配置
- [ ] 4.8 将 `/optional-deps` 路由组挂载到 `agent/api_server.py`

## 5. 国内镜像注入

- [ ] 5.1 `sidecar.rs` spawn 时按用户配置注入 `PIP_INDEX_URL` / `UV_INDEX_URL`（及 `*_EXTRA_INDEX_URL`），默认清华源
- [ ] 5.2 镜像配置持久化与读取（写入 `~/.vibe-trading/.env` 或独立配置文件）

## 6. 前端设置页 UI

- [ ] 6.1 新增「可选依赖 / 券商支持」管理组件，按券商分组展示 registry
- [ ] 6.2 一键「安装支持」/「卸载」按钮，显示每个包的已装/未装状态
- [ ] 6.3 接入安装进度 SSE，实时展示安装阶段
- [ ] 6.4 镜像源切换 UI（清华 / 阿里 / 官方 / 自定义 / 关闭）
- [ ] 6.5 接入 `src/lib/api.ts` 与 `src/stores/agent.ts`，并在 `components/layout/Layout.tsx` 或设置页挂载入口

## 7. 打包脚本调整

- [ ] 7.1 `scripts/desktop/assemble.sh` 确认保留 `.dist-info`（包管理器需要其管理已装包）
- [ ] 7.2 `scripts/desktop/install-deps.sh` 适配包管理器选型（若用 uv 则确认内嵌；若 pip 则确认标准库可用）
- [ ] 7.3 将 registry.yaml 与（如选 uv）uv 二进制纳入打包资源

## 8. 验证与测试

- [ ] 8.1 后端 API 单元测试：白名单拒绝、list 已装标注、平台预检
- [ ] 8.2 集成测试：安装 `futu-api` → agent `import futu` → 成功调用
- [ ] 8.3 升级保留测试：版本升级后 `libs/` 内容不被清空，依赖仍可 import
- [ ] 8.4 镜像耗时对比：同一包在清华源 vs 官方 PyPI 的下载耗时记录
- [ ] 8.5 打包后真机验证：macOS arm64 与 Windows 各完成一次「选券商 → 安装 → 调用」全链路
