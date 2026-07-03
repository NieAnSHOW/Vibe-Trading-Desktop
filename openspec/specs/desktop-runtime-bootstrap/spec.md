# desktop-runtime-bootstrap Specification

## Purpose
TBD - created by archiving change desktop-runtime-decoupling. Update Purpose after archive.
## Requirements
### Requirement: 首次运行将后端依赖 bootstrap 到用户目录 venv
系统 SHALL 在首次运行(或依赖缺失)时,于 `~/.vibe-trading/venv` 创建标准 Python 虚拟环境,并将 `agent/requirements.txt` 的后端依赖安装其中,使桌面 sidecar 使用该 venv 的解释器运行,与本地部署(venv + `pip install`)行为一致。

#### Scenario: 全新机器首次 bootstrap
- **WHEN** 用户在无既有 venv 的机器上首次触发依赖安装
- **THEN** 系统在 `~/.vibe-trading/venv` 建立虚拟环境并安装后端依赖,完成后该 venv 的 python 可导入 pandas/scipy/duckdb 等运行时依赖

#### Scenario: venv 已就绪则跳过
- **WHEN** `~/.vibe-trading/venv` 已存在且冒烟验证通过
- **THEN** 系统不重复安装,直接进入可启动服务状态

#### Scenario: 经 CLI 子命令触发 bootstrap
- **WHEN** 用户或桌面控制台调用 `vibe-trading bootstrap`
- **THEN** 该子命令执行 venv 创建 + 依赖安装 + 冒烟验证的同一流程,效果与桌面控制台内触发等价,使 CLI 保持一等公民

### Requirement: 默认国内镜像且可切换
bootstrap 安装 SHALL 默认使用国内 PyPI 镜像(清华源),并 SHALL 允许用户切换镜像源(清华 / 阿里 / 官方)或自定义 index-url。

#### Scenario: 默认清华源
- **WHEN** 用户在默认配置下执行 bootstrap
- **THEN** 安装请求指向清华镜像,国内网络下下载速度显著优于官方 PyPI

#### Scenario: 切换镜像后重试
- **WHEN** 用户切换镜像源并重新触发安装
- **THEN** 后续安装使用新指定的镜像源

### Requirement: 安装进度可见、断点重试与失败可读
bootstrap 过程 SHALL 向用户实时反馈进度与日志;失败 SHALL 给出可读原因并支持重新触发;重试 SHALL 在已下载/已安装的基础上继续,而非从零重来。

#### Scenario: 弱网中断后重试续装
- **WHEN** 安装因网络中断失败,用户点击重试
- **THEN** 系统显示明确失败原因,重试时复用已完成部分继续安装直至成功

#### Scenario: 进度实时可见
- **WHEN** bootstrap 正在下载/安装依赖
- **THEN** 用户可实时看到进度与关键日志,而非无反馈等待

### Requirement: 冒烟验证通过才判定就绪
bootstrap 完成安装后 SHALL 运行 smoke import 冒烟验证(至少覆盖 numpy/scipy/scikit-learn/pandas/duckdb 等关键原生包);仅当验证通过时才将环境标记为"就绪",否则标记为"依赖不全"并提示修复。

#### Scenario: 冒烟通过标记就绪
- **WHEN** 依赖安装完成且关键包 import 冒烟验证全部通过
- **THEN** 环境状态标记为"就绪",允许启动服务

#### Scenario: 冒烟失败不误报就绪
- **WHEN** 安装完成但某关键包 import 失败(如平台缺 wheel / 原生库链接失败)
- **THEN** 环境状态标记为"依赖不全",给出失败包与原因,不允许以残缺环境启动服务

### Requirement: 升级时按需增量同步依赖
应用版本升级导致 `requirements.txt` 变化时,系统 SHALL 检测差异并按需在既有 venv 中增量安装/更新变化的依赖,而非删除重建整个 venv。

#### Scenario: 依赖清单变化触发增量同步
- **WHEN** 新版本的 `requirements.txt` 相比已安装环境新增或升级了依赖
- **THEN** 系统在既有 venv 上增量安装差异部分,已满足的依赖不重复下载

