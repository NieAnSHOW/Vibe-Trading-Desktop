# channel-management-ui Specification

## Purpose
TBD - created by archiving change desktop-runtime-decoupling. Update Purpose after archive.
## Requirements
### Requirement: WebUI 管理消息渠道服务与依赖
WebUI 设置页 SHALL 提供消息渠道的服务启动与依赖安装能力,使普通用户无需打开终端即可启用渠道。设置页 SHALL 复用现有渠道列表展示,并接入后端既有的 `/channels/status`、`/channels/start` REST 接口与可选依赖安装机制。

#### Scenario: 从 WebUI 启动渠道服务
- **WHEN** 用户在设置页点击启动某消息渠道
- **THEN** WebUI 调用后端 `/channels/start`,渠道状态在页面上更新为运行中,全程无需终端

#### Scenario: 从 WebUI 安装渠道依赖
- **WHEN** 目标渠道缺少运行所需依赖
- **THEN** WebUI 触发依赖安装并展示进度,安装完成后该渠道可启动

### Requirement: 微信渠道页面内扫码登录
WebUI SHALL 在页面内呈现微信渠道的扫码登录流程(展示二维码与登录状态),替代 `vibe-trading channels login weixin` 的终端扫码路径,使普通用户在浏览器内完成登录。

#### Scenario: 页面内扫码登录微信
- **WHEN** 用户在设置页发起微信渠道登录
- **THEN** 页面显示登录二维码,用户扫码后页面更新为已登录状态,无需打开终端

#### Scenario: 登录态保留
- **WHEN** 用户已完成微信登录且应用升级
- **THEN** 渠道登录态(`~/.vibe-trading/channels/`、`pairing.json`)被保留,无需重新扫码

### Requirement: CLI 渠道命令保持可用
迁入 WebUI SHALL NOT 移除或破坏既有 CLI 渠道命令;高级用户 SHALL 仍能使用 `vibe-trading channels start` / `channels login weixin` 等命令,与 WebUI 操作等价。

#### Scenario: CLI 与 WebUI 行为一致
- **WHEN** 高级用户通过 CLI 启动渠道
- **THEN** 其效果与 WebUI 启动一致,状态在两处均可见

