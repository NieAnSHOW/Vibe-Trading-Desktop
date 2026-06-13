## ADDED Requirements

### Requirement: 可写的可选依赖目录与 sidecar 模块搜索集成
系统 SHALL 在用户数据目录下维护一个可写的可选依赖目录（`~/.vibe-trading/runtime/libs/`），sidecar 启动时 SHALL 将该目录加入 Python 模块搜索路径且位于 bundle 内 `site-packages` **之后**，使运行时装入的第三方包可被 agent 正常 `import`，同时保证核心打包依赖始终优先。

#### Scenario: 运行时安装的包可被 agent import
- **WHEN** 后端通过安装 API 将 `futu-api` 写入可写依赖目录
- **THEN** sidecar 在不重启、不改动 bundle 的前提下能 `import futu`，并成功调用富途 API

#### Scenario: 核心依赖优先级不被覆盖
- **WHEN** 可写依赖目录中存在与核心打包依赖同名的包（如旧版 `pandas`）
- **THEN** agent 导入该名称时仍加载 bundle `site-packages` 中的核心版本，可写目录不覆盖核心依赖

### Requirement: 可选依赖安装/卸载/列表 API（手动触发）
系统 SHALL 提供 REST API（`/optional-deps` 路由组）支持列出可装/已装依赖、安装、卸载；安装与卸载 SHALL 仅由显式 API 调用触发，agent 运行时 SHALL NOT 具备自主 `pip install` 能力。

#### Scenario: 列出可装与已装依赖
- **WHEN** 调用 `GET /optional-deps/list`
- **THEN** 返回 registry 中全部可装项，并依据可写目录的 `.dist-info` 标注每项当前是否已安装

#### Scenario: 安装券商 SDK
- **WHEN** 调用 `POST /optional-deps/install` 指定包名 `futu-api`
- **THEN** 后端通过包管理器将 `futu-api` 及其依赖写入可写依赖目录，完成后该包可被 `import`

#### Scenario: 卸载已装依赖
- **WHEN** 调用 `POST /optional-deps/uninstall` 指定已安装的包
- **THEN** 该包从可写依赖目录移除，后续不再可 `import`

### Requirement: 安装进度反馈与失败重试
安装过程 SHALL 向前端实时反馈进度（stdout / 阶段状态）；安装失败 SHALL 给出明确原因并支持重新触发。

#### Scenario: 安装进度实时可见
- **WHEN** 触发一次安装
- **THEN** 前端通过 SSE（或等价轮询机制）收到安装过程的进度更新，直至完成或失败

#### Scenario: 断网或失败可重试
- **WHEN** 安装因网络中断或其他错误终止
- **THEN** 前端显示明确的失败状态与原因，用户可重新触发安装

### Requirement: 国内 PyPI 镜像默认启用且可切换
系统 SHALL 默认使用国内 PyPI 镜像（如清华源）执行安装，并 SHALL 允许用户在设置页切换镜像源（清华 / 阿里 / 官方 PyPI / 自定义）或关闭镜像回退官方源。

#### Scenario: 国内镜像默认生效
- **WHEN** 用户在默认配置下安装一个可选依赖
- **THEN** 安装请求指向国内镜像源，国内网络环境下下载速度显著优于官方 PyPI（应可记录耗时对比）

#### Scenario: 切换镜像源
- **WHEN** 用户在设置页切换镜像源并重新安装
- **THEN** 后续安装使用新指定的镜像源

### Requirement: 可选依赖清单（registry 白名单）
系统 SHALL 维护一份可选依赖清单（券商/能力 → PyPI 包名 + 描述 + 平台 wheel 可用性 + 推荐镜像），作为 UI 展示与安装 API 的单一数据源；安装 API SHALL 仅接受清单内声明的包名。

#### Scenario: 仅可安装清单内依赖
- **WHEN** 安装 API 收到不在 registry 内的包名请求
- **THEN** 拒绝安装并返回明确错误，不执行任意包安装

### Requirement: 已装依赖在版本升级后保留
应用版本升级时 SHALL 保留用户已安装的可选依赖目录内容，不随 bundle 模板覆盖或清空。

#### Scenario: 升级后已装依赖仍在
- **WHEN** 应用从旧版本升级到新版本
- **THEN** 用户此前安装的可选依赖依然存在于可写目录且可被 `import`

### Requirement: 平台 wheel 可用性预检
安装前 SHALL 检测目标包在当前平台是否存在预编译 wheel；缺失时 SHALL 给出明确提示而非触发本地编译。

#### Scenario: 目标平台无预编译 wheel
- **WHEN** 待安装的包在当前平台（如 macOS arm64）无预编译 wheel
- **THEN** 安装 API 返回明确提示信息，不尝试需要本地编译器的源码构建
