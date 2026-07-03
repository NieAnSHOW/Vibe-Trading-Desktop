# desktop-control-console Specification

## Purpose
TBD - created by archiving change desktop-runtime-decoupling. Update Purpose after archive.
## Requirements
### Requirement: 桌面窗口作为环境/服务控制台
桌面应用窗口 SHALL 作为环境与服务的管理控制台,而非业务 WebUI 宿主。控制台 SHALL 展示环境状态(venv 未安装 / 就绪 / 依赖不全)与服务状态(serve 运行中 / 已停止),并提供触发依赖安装、启停服务、在默认浏览器打开 WebUI、打开日志目录等操作入口。

#### Scenario: 展示环境与服务状态
- **WHEN** 用户打开桌面控制台
- **THEN** 控制台显示当前环境状态与服务状态,状态与实际磁盘/进程情况一致

#### Scenario: 环境未就绪时引导安装
- **WHEN** 环境状态为"未安装"或"依赖不全"
- **THEN** 控制台突出显示安装/修复入口,且在就绪前禁用"启动服务"

### Requirement: 通过控制台启停后端服务
控制台 SHALL 能启动与停止后端服务(使用 venv 解释器运行 `vibe-trading serve`),并在服务状态变化时更新展示。

#### Scenario: 启动服务
- **WHEN** 环境就绪,用户点击"启动服务"
- **THEN** 控制台使用 venv 解释器拉起 serve,健康检查通过后状态更新为"运行中"

#### Scenario: 停止服务干净退出
- **WHEN** 用户点击"停止"或关闭应用
- **THEN** 后端及其派生进程被干净终止,不留残留进程

### Requirement: 在默认浏览器打开 WebUI
控制台 SHALL 提供"在浏览器打开 WebUI"入口,在系统默认浏览器中打开 `http://127.0.0.1:<port>`,由浏览器而非桌面 webview 承载业务 UI。

#### Scenario: 打开 WebUI
- **WHEN** 服务处于"运行中",用户点击"在浏览器打开 WebUI"
- **THEN** 系统默认浏览器打开对应端口的 WebUI,页面功能完整可用

### Requirement: 打开日志目录
控制台 SHALL 提供入口打开用户目录下的日志位置(`~/.vibe-trading/logs/`),便于用户与维护者定位问题。

#### Scenario: 打开日志目录
- **WHEN** 用户点击"打开日志目录"
- **THEN** 系统在文件管理器中打开 `~/.vibe-trading/logs/`

