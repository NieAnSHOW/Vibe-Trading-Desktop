## MODIFIED Requirements

### Requirement: 应用启动时编排 Python 后端 sidecar
桌面应用 SHALL 在启动时拉起内嵌的 Python 后端作为 sidecar 子进程,通过 `vibe-trading serve` 入口启动 FastAPI 服务,并在服务就绪后在桌面壳的**「主页」标签页**(而非整个窗口)中加载 Web UI。sidecar 启动、健康检查、端口选择逻辑 SHALL 保持不变。

#### Scenario: 正常启动并加载 UI
- **WHEN** 用户在已安装应用且无其他实例运行时双击启动
- **THEN** 应用拉起 Python sidecar,轮询后端 `/health` 直至返回成功,随后在桌面壳的「主页」标签页内加载现有 Web UI(`http://127.0.0.1:<port>`),窗口顶部呈现标签栏

#### Scenario: 启动期向用户提供反馈
- **WHEN** Python sidecar 正在启动、后端尚未就绪
- **THEN** 应用(壳)显示加载状态(而非空白窗口),直至健康检查通过或超时

## ADDED Requirements

### Requirement: 顶部标签栏与主页固定标签
桌面壳 SHALL 在窗口顶部(原生标题栏下方)提供一条标签栏,SHALL NOT 展示地址栏。Web UI SHALL 作为固定的第一个「主页」标签,该标签 SHALL NOT 可被用户关闭,且 SHALL 为应用启动后的初始激活标签。

#### Scenario: 启动后顶部出现标签栏且主页为初始激活
- **WHEN** 桌面应用启动、sidecar 就绪、Web UI 加载完成
- **THEN** 窗口顶部出现一条不含地址栏的标签栏,Web UI 作为第一个「主页」标签出现并为初始激活标签

#### Scenario: 主页标签不可关闭
- **WHEN** 用户查看主页标签
- **THEN** 主页标签不呈现关闭按钮,且任何关闭主页标签的尝试都被拒绝,主页标签始终存在

### Requirement: 网格速拨页与资讯快捷入口
桌面壳 SHALL 提供一个可关闭的「网格速拨」标签页,以网格形式展示常用股票/股市资讯网站的快捷入口(初始为新浪财经、同花顺)。快捷入口清单 SHALL 由配置文件驱动以便后续增减。桌面壳 SHALL 提供一个「+」入口用于重新打开/激活网格速拨页。

#### Scenario: 网格速拨页展示资讯入口
- **WHEN** 用户打开网格速拨标签页
- **THEN** 页面以网格形式展示全部配置的资讯网站快捷入口(初始为新浪财经、同花顺),入口显示站点名称

#### Scenario: 快捷入口配置可扩展
- **WHEN** 维护者向配置文件追加新的资讯站点(url/name/icon)
- **THEN** 下次启动后网格速拨页自动出现该新入口,无需改壳代码

#### Scenario: 通过「+」入口重新打开网格
- **WHEN** 网格速拨标签已被关闭,用户点击标签栏的「+」入口
- **THEN** 网格速拨页被重新打开并切换到该标签;若网格标签已存在则切换到它而非重复创建

### Requirement: 资讯站点在同窗口内开新标签
点击网格速拨页中的资讯快捷入口 SHALL 在同一桌面窗口内新开一个标签页,以独立 webview 加载该网站内容;SHALL NOT 弹出独立 OS 级新窗口,也 SHALL NOT 用 iframe 嵌入当前页。对同一站点重复打开 SHALL 切换到已存在的标签而非重复创建(幂等)。

#### Scenario: 点击资讯入口开新标签
- **WHEN** 用户点击网格速拨页中某个资讯快捷入口,且该站点尚无打开的标签
- **THEN** 在同窗口内新开一个标签页,以独立 webview 加载该网站,并自动切到该标签

#### Scenario: 重复打开同站点切到已存在标签
- **WHEN** 用户再次打开一个已有标签的资讯站点
- **THEN** 不创建新标签,而是切换到已存在的同站点标签并置于前台

### Requirement: 标签切换与关闭
标签 SHALL 可在标签栏中切换(点击切换激活的标签)与关闭(关闭按钮销毁对应 webview),主页标签除外。切换标签时 SHALL 仅显示被激活的标签 webview、隐藏其余。标签切换 SHALL NOT 中断 Web UI 的运行态(SSE 会话、流式输出持续)。

#### Scenario: 切换标签不中断 Web UI
- **WHEN** Web UI 主页标签正在流式输出或 SSE 连接活跃,用户切换到另一标签后再切回
- **THEN** Web UI 的会话与流式输出状态保持,未因标签切换而中断或重连

#### Scenario: 关闭标签销毁 webview
- **WHEN** 用户关闭某个资讯标签或网格标签
- **THEN** 对应 webview 被销毁、从标签栏移除;其他标签(含主页)不受影响

#### Scenario: 关闭当前激活标签后焦点回落
- **WHEN** 用户关闭当前正激活的非主页标签
- **THEN** 该 webview 被销毁,激活标签回落到主页标签,其余标签不受影响

### Requirement: 外部资讯站点与本地命令隔离
加载外部资讯网站的子 webview SHALL NOT 注入任何 Tauri IPC / `@tauri-apps/api`,使外部网站的 JavaScript 无法调用本地 Tauri 命令;壳标签栏与资讯站内容 SHALL 处于不同 webview,DOM 与 JS 相互隔离。

#### Scenario: 外部站点无法调用本地命令
- **WHEN** 资讯网站(不可信外部内容)在其页面内执行任意 JavaScript
- **THEN** 该脚本无法访问或调用桌面应用的 Tauri command(如开标签、关标签、进程退出),也无法读写壳标签栏的 DOM

### Requirement: 资讯加载失败的容错
当资讯网站加载失败或网络不可达时,对应标签 SHALL NOT 导致应用崩溃或影响其他标签;用户 SHALL 能正常关闭该失败标签。

#### Scenario: 资讯站加载失败可关闭
- **WHEN** 某资讯网站加载失败(网络不通或站点错误)
- **THEN** 该标签显示站点的错误状态,用户可正常关闭该标签,应用与其他标签(含主页)继续正常工作
