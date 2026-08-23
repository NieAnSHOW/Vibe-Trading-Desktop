<p align="center">
  <img src="frontend/public/web-icon.png" width="128" alt="Trading Worker logo" />
</p>

<h1 align="center">Trading Worker</h1>

<p align="center">
  <strong>您的专属 AI 理财专家</strong>
</p>

<p align="center">
  双击即用的本地金融研究工作台 —— 把「看市场、问问题、跑回测」装进一个桌面应用，<br />
  数据留在自己电脑上，模型由我们托管，你只需要提问。
</p>

<p align="center">
  <a href="https://github.com/NieAnSHOW/Vibe-Trading-Desktop/releases">下载桌面版</a>
  &nbsp;&middot;&nbsp;
  <a href="#项目定位">项目定位</a>
  &nbsp;&middot;&nbsp;
  <a href="#它解决什么问题">为什么做</a>
  &nbsp;&middot;&nbsp;
  <a href="#功能一览">功能一览</a>
  &nbsp;&middot;&nbsp;
  <a href="#快速开始">快速开始</a>
  &nbsp;&middot;&nbsp;
  <a href="#与上游-vibe-trading-的关系">与上游的关系</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-12%2B-000000?style=flat&logo=apple&logoColor=white" alt="macOS" />
  <img src="https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat&logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/Desktop-Tauri%202.x-FFC131?style=flat&logo=tauri&logoColor=white" alt="Tauri" />
  <img src="https://img.shields.io/badge/Engine-Python%203.12-3776AB?style=flat&logo=python&logoColor=white" alt="Python" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat" alt="MIT license" /></a>
</p>

## English summary

**Trading Worker** is a standalone desktop product for individual investors —
evolved from, but no longer tracking, [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading).
It keeps the upstream research core (LangGraph agent, 70+ finance skills,
multi-market backtesting engines, 450+ alpha factors, live-trading safety
layers) and its WebUI, then rebuilds everything around them for non-developers:
a double-click-to-run Tauri shell with an embedded Python runtime, an account
and membership layer with hosted LLMs (no API keys to manage), an A-share
market workspace (dashboard, anomalies, indices, watchlist, news), and a
transparent LLM usage center. Everything runs locally on `127.0.0.1`.

## 项目定位

本仓库起始于 [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)（31k+ Star 的开源金融智能体框架）的桌面化分支，**如今已是一条独立演进的产品线**，在业务方向上不再跟随上游节奏：

- **保留**了上游经过大规模社区验证的研究核心与 WebUI —— LangGraph ReAct Agent、70+ 金融技能、多市场回测引擎、450+ Alpha 因子库、实盘安全层（mandate / kill switch / 审计账本）；
- **重建**了面向普通投资者的产品层 —— 桌面分发与运行时管理、账户与会员体系、A 股市场工作台、托管模型与用量中心。

上游仍是我们重要的技术基石与致敬对象，许可证与署名完整保留（见 [NOTICE](NOTICE)）。

## 它解决什么问题

个人投资者想做专业级研究，道路被三道墙挡住：

1. **技术墙** —— 专业工具要装环境、开终端、配依赖；聊天式 AI 又给不出数据与验证。
2. **钥匙墙** —— 想用大模型，先得注册、充值、管理 API key，门槛和成本都不透明。
3. **信任墙** —— 云端产品意味着你的自选股、研究记录、对话数据都存在别人的服务器上。

**Trading Worker 的回答：把一位金融专家装进你的电脑里。** 装好、点开、提问，三步开始研究；所有数据只保存在本机。

## 核心竞争力

- **双击即用，不是给开发者的框架。** 安装包内嵌 Python 3.12 运行时，首次运行自动引导安装完整研究环境（支持清华/阿里镜像加速、断点重试），全程图形界面，无需终端。
- **不用自己搞模型。** 会员可直接使用托管模型 —— 密钥由服务端按需注入本地进程、不写入磁盘；进阶用户也可切换为自定义 LLM 配置（OpenRouter、DeepSeek、Gemini、Zhipu 等 13+ 供应商）。
- **数据在你手里。** 研究服务只监听 `127.0.0.1`，会话、回测、自选与配置全部保存在本机 `~/.vibe-trading/`，升级不丢数据，退出即停服务。
- **从看盘到验证的完整闭环。** 市场看板 → 异动跟踪 → 指数详情 → 自选股一键交给 Agent → 资讯筛选 → 自然语言研究 → 回测验证 → 因子探索，一条工作流走完，而不是一堆孤立页面。
- **站在被验证过的核心引擎上。** 继承上游的 ReAct 研究循环、A 股 / 美股 / 港股 / 加密 / 期货 / 外汇回测引擎、Alpha Zoo 因子库与实盘安全层 —— 产品易用，引擎不玩具。
- **为 A 股用户设计。** 中文优先、红涨绿跌、多数据源自动回退（tushare / akshare / 东财等），符合国内投资者的看盘直觉。

## 这是什么

Trading Worker 由一个原生桌面壳和一个嵌入式研究工作区组成：

| 层级 | 技术 | 作用 |
| --- | --- | --- |
| 桌面壳 | Tauri 2.x + Rust + Vue 控制台 | 账户登录、内嵌 Python 运行时、依赖引导安装、服务生命周期与本地日志 |
| 研究工作区 | React 19 + TypeScript + ECharts | Agent 对话、市场数据、资讯、自选股、回测与可视化（嵌入主窗口） |
| 研究引擎 | Python 3.12 + FastAPI + LangGraph | 金融研究、回测、数据源、技能与本地 API 服务（仅监听 127.0.0.1） |

桌面主窗口左侧是常驻导航栏（账户 / 环境 / 研究 / 设置）：**账户** 进登录与个人中心（会员状态、托管模型、用量），**环境** 是运行时控制台（安装依赖、启停服务、看日志），**研究** 直接在主窗口内嵌完整 WebUI。首次运行时控制台会引导安装依赖，就绪后一键启动并进入工作区。

## 功能一览

以下截图按产品工作流顺序展示 Trading Worker 的完整体验。

### 0. 桌面控制台

<p align="center">
  <img src="assets/0.png" alt="Trading Worker 桌面控制台" width="420" />
</p>

安装、修复依赖、启动本地研究服务，全在图形界面完成 —— 不用打开终端。

### 1. 市场看板

<p align="center">
  <img src="assets/1.png" alt="A 股市场看板" width="960" />
</p>

集中查看主要指数、市场宽度、板块和行情概览，先看清今天的市场情绪。

### 2. 市场异动

<p align="center">
  <img src="assets/2.png" alt="市场异动" width="960" />
</p>

聚合值得跟进的价格、成交量与市场信号，即时发现、即时跟踪。

### 3. 指数详情与盘中图表

<p align="center">
  <img src="assets/3.png" alt="指数详情与盘中图表" width="960" />
</p>

在指数详情中查看 K 线、盘中走势、成交量与相关市场数据。

### 4. 自选股

<p align="center">
  <img src="assets/4.png" alt="自选股管理" width="960" />
</p>

维护关注标的，并通过快捷按钮把行情上下文直接交给 Agent 继续研究。

### 5. 投资资讯

<p align="center">
  <img src="assets/5.png" alt="投资资讯中心" width="960" />
</p>

以研究主题与市场线索组织资讯，帮你快速筛出值得跟进的事件。

### 6. AI 研究 Agent

<p align="center">
  <img src="assets/6.png" alt="Trading Worker AI Agent" width="960" />
</p>

从研究模板或自然语言问题开始，像聊天一样完成全方位的个股与策略分析。

### 7. LLM 用量中心

<p align="center">
  <img src="assets/7.png" alt="LLM 用量中心" width="960" />
</p>

按模型与时间维度查看用量，研究成本一目了然。

### 8. 回测报告

<p align="center">
  <img src="assets/8.png" alt="回测报告工作台" width="960" />
</p>

在工作台中查找、筛选和打开已完成的研究与回测结果，让每个想法经过验证。

### 9. Alpha Zoo

<p align="center">
  <img src="assets/9.png" alt="Alpha Zoo 因子库" width="960" />
</p>

高阶玩家的因子实验室：浏览 450+ 内置因子，做检验与对比，探索下一条研究线索。

## 快速开始

### 下载桌面应用

1. 前往 [Releases](https://github.com/NieAnSHOW/Vibe-Trading-Desktop/releases) 下载对应平台安装包。
2. 启动 Trading Worker，登录或注册账号，按提示一键安装研究依赖。
3. 服务就绪后进入研究工作区，开始提问。

支持的平台和空间要求：

- macOS 12.0 及以上（Apple Silicon 原生），Windows 10 及以上（x64）。
- 完整研究环境约需 2 GB 磁盘空间。

当前 macOS 发行包未签名时，浏览器下载后可能带有隔离标记。将应用拖入 `/Applications` 后，可执行：

```bash
xattr -cr "/Applications/Trading Worker.app"
```

该命令仅移除该应用的下载隔离标记，不会修改系统安全设置。完整安装说明、已知限制与运行时说明见 [桌面应用文档](docs/desktop/README.md)。

### 本地开发

```bash
# 后端 API，默认 :8899
pip install -e ".[dev]"
vibe-trading serve

# 前端开发服务器，默认 :5899
cd frontend
npm install
npm run dev
```

构建桌面发行包：

```bash
# macOS
bash scripts/desktop/build-dmg.sh

# Windows PowerShell
.\scripts\desktop\build-windows.ps1
```

更多构建细节见 [桌面构建文档](docs/desktop/README.md) 与 [贡献者指南](AGENT_CONTRIBUTOR_GUIDE.md)。

## 与上游 Vibe-Trading 的关系

| 维度 | 上游 HKUDS/Vibe-Trading | 本仓库 Trading Worker |
| --- | --- | --- |
| 定位 | 面向开发者/研究者的开源智能体框架 | 面向个人投资者的桌面产品 |
| 分发方式 | pip / Docker / CLI / MCP | macOS DMG / Windows MSI 安装包 |
| 使用门槛 | 自备环境、终端与 API key | 双击安装、登录账号、托管模型 |
| 市场数据 | 通用多市场研究 | A 股优先的工作台（看板/异动/自选/资讯） |
| 账户体系 | 无 | 登录、会员、用量中心 |
| 演进策略 | 社区驱动，快速迭代 | 保留上游核心，业务独立演进，选择性同步 |

上游的完整功能说明、多语言 README、Roadmap 与社区信息见 [上游文档](https://github.com/HKUDS/Vibe-Trading#readme) 与 [上游 Wiki](https://vibetrading.wiki/)。

| 本仓库文档 | 内容 |
| --- | --- |
| [桌面应用文档](docs/desktop/README.md) | 安装、系统要求、运行时与构建说明 |
| [贡献者指南](AGENT_CONTRIBUTOR_GUIDE.md) | 开发与高风险交易路径的安全规则 |
| [CHANGELOG](CHANGELOG.md) | 本仓库变更记录 |
| [SECURITY](SECURITY.md) | 安全问题上报方式 |

## 安全说明

- 研究服务仅绑定 `127.0.0.1`，不会直接暴露到局域网或公网。
- 桌面应用在退出时会终止其管理的本地服务进程。
- 涉及登录、会员或托管模型时，应用会与会员服务通信；托管模型密钥按需注入本地进程，不作为用户配置写入磁盘。若启用“记住登录”，登录令牌与会员私钥保存在本机。
- 实盘交易、订单闸门、mandate、kill switch 与审计路径属于高风险功能；使用和贡献前请阅读 [安全贡献指南](AGENT_CONTRIBUTOR_GUIDE.md)。
- 回测与研究输出仅供学习研究参考，不构成投资建议。

## License

本项目采用 [MIT License](LICENSE)，并遵循上游项目 [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) 的许可证与署名约定（见 [NOTICE](NOTICE)）。
