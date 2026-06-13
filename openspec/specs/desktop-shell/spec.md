# desktop-shell Specification

## Purpose
TBD - created by archiving change tauri-desktop-client. Update Purpose after archive.
## Requirements
### Requirement: 应用启动时编排 Python 后端 sidecar
桌面应用 SHALL 在启动时拉起内嵌的 Python 后端作为 sidecar 子进程,通过 `vibe-trading serve` 入口启动 FastAPI 服务,并在服务就绪后才向用户展示 Web UI。

#### Scenario: 正常启动并加载 UI
- **WHEN** 用户在已安装应用且无其他实例运行时双击启动
- **THEN** 应用拉起 Python sidecar,轮询后端 `/health` 直至返回成功,随后 webview 指向 `http://127.0.0.1:<port>` 并加载现有 Web UI

#### Scenario: 启动期向用户提供反馈
- **WHEN** Python sidecar 正在启动、后端尚未就绪
- **THEN** 应用显示加载状态(而非空白窗口),直至健康检查通过或超时

### Requirement: 动态端口分配
桌面应用 SHALL 为后端动态选取一个可用的本机端口,而非固定使用 8899,以规避端口冲突。

#### Scenario: 默认端口被占用
- **WHEN** 启动时 8899 或首选端口已被其他进程占用
- **THEN** 应用自动选取另一个空闲端口并以该端口启动后端,应用仍正常启动

#### Scenario: webview 与后端端口一致
- **WHEN** 后端在动态选取的端口 `<port>` 上就绪
- **THEN** webview 加载的地址与该 `<port>` 一致,前端 API 请求(同源相对路径)指向同一后端

### Requirement: 后端仅绑定本机回环地址
桌面运行模式下,后端 SHALL 绑定 `127.0.0.1`,不得绑定 `0.0.0.0` 或对外暴露端口。

#### Scenario: 后端不对局域网暴露
- **WHEN** 应用启动后端
- **THEN** 后端监听地址为 `127.0.0.1:<port>`,同一网络中的其他设备无法访问该后端

### Requirement: 退出时清理 sidecar 进程
桌面应用 SHALL 在主窗口关闭或应用退出时干净终止 Python sidecar 子进程及其派生进程,不留残留进程。

#### Scenario: 关闭应用终止后端
- **WHEN** 用户关闭应用主窗口
- **THEN** Python sidecar 进程被终止,关闭后系统中不存在由本应用启动的残留 Python 后端进程

#### Scenario: 异常退出也清理
- **WHEN** 应用进程异常终止(崩溃或被强制结束)
- **THEN** 在平台能力允许范围内,sidecar 子进程随之终止(如通过进程组 / Job Object 关联),不长期残留

### Requirement: 启动失败的可见错误处理
当后端在超时时间内未能就绪时,桌面应用 SHALL 向用户显示可读的错误信息,而非静默卡在加载态或崩溃。

#### Scenario: 后端就绪超时
- **WHEN** Python sidecar 启动后,健康检查在约定超时时间内始终未通过
- **THEN** 应用展示明确的启动失败提示(含可定位问题的基本信息),并提供退出途径

### Requirement: 首启与升级时准备可写运行目录
由于后端将数据写入相对代码目录的硬编码位置(`runs`/`sessions`/`uploads`/`.swarm/runs`),而应用 bundle 在 macOS / Windows 上为只读,桌面应用 SHALL 在启动后端前把只读 bundle 中的后端代码复制到一个可写运行目录,并以指向该可写副本的方式启动后端,使所有运行期写入落在可写位置。

#### Scenario: 首次启动准备可写目录
- **WHEN** 应用首次启动(可写运行目录尚不存在)
- **THEN** 应用将 bundle 中的后端代码复制到可写运行目录,并记录已安装版本标记;随后后端从该可写副本启动,`runs`/`sessions`/`uploads`/`.swarm/runs` 均创建在可写位置

#### Scenario: 升级刷新代码但保留用户数据
- **WHEN** 应用版本较已安装版本更新(版本标记不一致)
- **THEN** 应用刷新可写运行目录中的后端代码,但 SHALL 保留既有的 `runs`/`sessions`/`uploads`/`.swarm/runs` 数据子目录与用户配置,不被覆盖或删除

#### Scenario: 种入配置且不覆盖用户配置
- **WHEN** 准备可写目录时,用户家目录配置(`~/.vibe-trading/.env`)不存在
- **THEN** 应用从 bundle 的配置种子复制一份作为初始配置;若用户配置已存在,则 SHALL NOT 覆盖它

#### Scenario: 可写目录准备失败的可读错误
- **WHEN** 准备可写运行目录失败(如磁盘空间不足或权限不足)
- **THEN** 应用展示可读的错误信息(含失败路径与原因),而非静默崩溃或卡在加载态

