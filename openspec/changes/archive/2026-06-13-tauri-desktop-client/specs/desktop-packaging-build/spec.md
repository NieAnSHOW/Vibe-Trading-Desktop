## ADDED Requirements

### Requirement: 双平台打包产物
构建流程 SHALL 为 macOS 产出 `.app` / `.dmg`,为 Windows 产出 `.msi` / `.exe`,两者均内嵌对应平台的 Python 运行时与全部资源,实现双击安装即用。

#### Scenario: macOS 产物可安装运行
- **WHEN** 在 macOS 上完成构建
- **THEN** 产出 `.app`(及可分发的 `.dmg`),用户安装后双击即可启动,无需额外依赖

#### Scenario: Windows 产物可安装运行
- **WHEN** 在 Windows 上完成构建
- **THEN** 产出 `.msi` 或 `.exe` 安装包,用户安装后双击即可启动,无需额外依赖

### Requirement: 复用现有前端构建产物
构建流程 SHALL 复用 `frontend` 现有的 `npm run build` 产物(`frontend/dist`)作为 UI,不引入新的前端业务依赖或改写前端业务代码。

#### Scenario: 前端构建复用
- **WHEN** 执行桌面应用构建
- **THEN** 构建使用 `frontend/dist`(由现有 `npm run build` 生成)作为打包的 Web UI,前端业务代码无改动

### Requirement: 跨平台构建环境约束
构建流程 SHALL 明确记录"macOS 包须在 macOS 构建、Windows 包须在 Windows 构建"这一约束(无法交叉编译),并 SHOULD 提供基于 CI 矩阵的双平台产出路径。

#### Scenario: 构建环境匹配目标平台
- **WHEN** 需要产出某平台的安装包
- **THEN** 在该平台对应的构建环境(本机或 CI runner)上执行构建,文档清晰说明此约束

### Requirement: 桌面运行模式不破坏现有用法
桌面打包 SHALL 不改变现有 CLI / Docker 的运行方式;`0.0.0.0` 绑定与固定端口等行为变更仅作用于桌面运行模式。

#### Scenario: 现有 CLI 行为不受影响
- **WHEN** 用户仍以 `vibe-trading serve` / Docker 方式运行项目
- **THEN** 其默认绑定地址与端口行为保持原样,不受桌面封装改动影响
