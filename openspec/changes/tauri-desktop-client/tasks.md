# Tasks: tauri-desktop-client

> 顺序:先攻克头号风险(可重定位性 spike)→ macOS 端到端打通 → 补 Windows 差异 → 双平台构建与验收。
> 平台标注:【mac】仅 macOS,【win】仅 Windows,【双】两平台共用。

## 1. 可重定位性 Spike(头号风险,先行验证)

- [x] 1.1 【mac】选定 python-build-standalone 发行版/版本与架构(mac arm64,确认是否需 x64),下载并解压一份可重定位运行时
- [x] 1.2 【mac】在该运行时中 `pip install` `agent/requirements.txt`(排除 weasyprint),记录安装方式(直接 pip vs uv 锁定)
- [x] 1.3 【mac】把运行时整体移动到另一路径(模拟不同安装目录/用户名),编写并运行原生扩展导入冒烟测试:`numpy / scipy / scikit-learn / duckdb / pandas / Pillow / matplotlib` 均能 import 且无 BLAS/rpath 链接错误
- [x] 1.4 【mac】在迁移后的运行时中以子进程启动 `vibe-trading serve --host 127.0.0.1 --port <port>`,确认 `/health` 可达、SPA 静态资源可加载
- [x] 1.5 记录 spike 结论与任何需要的 rpath/路径修复手段;若不可重定位,回到 design 调整方案(阻塞后续)

## 2. Tauri 脚手架与项目结构【双】

- [x] 2.1 初始化 `src-tauri/`(Tauri 配置 + Rust crate + 图标占位),确认 Rust/Tauri 工具链可构建空壳应用
- [x] 2.2 编写 `tauri.conf.json`:窗口配置、`resources` 声明(Python 运行时目录、`agent/`、`frontend/dist`、`agent/.env`)、bundle 标识
- [x] 2.3 约定资源目录布局与 Rust 侧资源路径解析(开发态 vs 打包态),确保能定位内嵌 python 与 serve 入口

## 3. Sidecar 启动编排(desktop-shell)【双,mac 先实现】

- [x] 3.1 实现空闲端口选取(`127.0.0.1:0` 系统分配或从 8899 起探测)
- [x] 3.2 实现 spawn Python sidecar:以内嵌运行时运行 serve,传入 `--host 127.0.0.1 --port <port>`,设置工作目录与必要环境变量(PYTHONPATH 指向 `agent/`)
- [x] 3.3 实现 `/health` 轮询 + 超时门控;就绪后将 webview 指向 `http://127.0.0.1:<port>`
- [x] 3.4 实现启动期加载态 UI(splash 或加载页),避免空白窗口
- [x] 3.5 实现就绪超时的可读错误提示与退出途径
- [x] 3.6 【mac】实现退出时进程清理(进程组/setsid 风格),验证关闭应用后无残留 Python 进程

## 4. macOS 端到端打通与打包(desktop-packaging-build)

- [x] 4.1 编写 macOS 打包脚本:构建 `frontend`(`npm run build`)→ 准备内嵌运行时与资源 → 资源裁剪(去 tests/`__pycache__`/`*.dist-info`)
- [x] 4.2 产出 `.app` 并验证:全新/无系统 Python 环境下双击启动 → 加载态 → 后端就绪 → UI 加载 → 可正常对话/回测
- [x] 4.3 验证 `agent/.env` 兜底生效、`~/.vibe-trading/` 首启自动创建、状态在重启后保留
- [x] 4.4 验证报告降级:生成影子账户报告 → weasyprint 缺失 → 自动产出 HTML 不报错
- [x] 4.5 产出可分发 `.dmg`

## 5. Windows 差异适配(desktop-shell + bundling)【win】

- [ ] 5.1 选定/制作 Windows x64 python-build-standalone 运行时并预装依赖(排除 weasyprint),跑 1.3 同款导入冒烟测试
- [ ] 5.2 适配 Rust 侧:`python.exe` 路径、路径分隔符、spawn 细节
- [ ] 5.3 实现 Windows 进程清理:Job Object 关联子进程(或退出时 `taskkill /T`),验证关闭后无残留进程(含异常退出场景)
- [ ] 5.4 编写 Windows 打包脚本,产出 `.msi`/`.exe` 并完成与 4.2–4.4 等价的端到端验证

## 6. 双平台构建与收尾

- [ ] 6.1 配置 GitHub Actions 矩阵(macOS + Windows runner)分别构建产物,文档明确"无法交叉编译"约束
- [ ] 6.2 验证桌面运行模式不破坏现有用法:`vibe-trading serve` / Docker 默认绑定与端口行为不受影响
- [ ] 6.3 编写用户向文档:安装、首次启动安全提示处理(mac 右键打开 / Windows SmartScreen)、状态与配置位置说明
- [ ] 6.4 汇总已知限制(体积、未签名、PDF→HTML 降级)到发布说明
