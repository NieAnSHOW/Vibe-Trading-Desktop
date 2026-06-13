# python-runtime-bundling Specification

## Purpose
TBD - created by archiving change tauri-desktop-client. Update Purpose after archive.
## Requirements
### Requirement: 可重定位的内嵌 Python 运行时
打包流程 SHALL 产出一份自包含、可重定位的 Python 运行时(基于 python-build-standalone),使其在被放置到应用资源目录的任意安装路径后仍能正常运行,不依赖用户机器上预装的 Python。

#### Scenario: 无系统 Python 的机器上运行
- **WHEN** 应用安装在一台未安装任何 Python 的全新机器上
- **THEN** 应用使用内嵌运行时启动后端,无需用户安装 Python 或任何依赖

#### Scenario: 运行时随安装路径迁移
- **WHEN** 内嵌运行时被安装到不同的目标路径(不同用户名 / 安装目录)
- **THEN** 运行时仍能正确解析自身路径并启动,不因绝对路径写死而失败

### Requirement: 预装全部后端依赖(排除 weasyprint)
打包流程 SHALL 将 `agent/requirements.txt` 的全部依赖预装进内嵌运行时,但 SHALL 排除 weasyprint 及其系统原生库,以避免引入 cairo/pango/gdk-pixbuf 等非 pip 系统依赖。

#### Scenario: 依赖完整可导入
- **WHEN** 后端在内嵌运行时中启动
- **THEN** 除 weasyprint 外的所有声明依赖(含 numpy/scipy/scikit-learn/pandas/duckdb 等原生扩展)均可正常导入并工作

#### Scenario: 缺失 weasyprint 不阻断启动
- **WHEN** 内嵌运行时未安装 weasyprint
- **THEN** 后端正常启动,影子账户报告生成走 HTML 降级路径(由 `reporter.py` 既有 try/except 处理),不抛出未捕获异常

### Requirement: 原生扩展可重定位性验证
打包流程 SHALL 验证带原生扩展的关键依赖(至少包括 numpy、scipy、scikit-learn、duckdb、pandas、Pillow)在内嵌运行时迁移到目标路径后可成功导入。

#### Scenario: 关键原生包导入冒烟测试
- **WHEN** 在打包产物(或等价的迁移路径)中执行导入冒烟测试
- **THEN** 上述每个包均能成功 `import` 且基本调用不报动态库链接错误(如 BLAS / rpath 问题)

### Requirement: 回测子进程使用内嵌 Python 自包含
回测执行会以子进程方式选取解释器(`agent/src/core/runner.py` 在找不到项目 `.venv` 时回退到 `sys.executable`)。打包流程 SHALL 确保该回退所用的内嵌 Python 自包含,即回测子进程使用内嵌运行时即可加载全部所需依赖。

#### Scenario: 回测子进程在内嵌运行时跑通
- **WHEN** 在打包产物中触发一次回测,且运行环境无项目 `.venv`(回退到内嵌 `sys.executable`)
- **THEN** 回测子进程使用内嵌 Python 成功加载所需依赖并完成执行,不因缺失依赖或解释器不可用而失败

### Requirement: 资源装配与裁剪
打包流程 SHALL 将内嵌运行时与 `agent/` 源码、`frontend/dist`、`agent/.env` 一并装配进应用资源,并 SHALL 裁剪非必要文件(测试、`__pycache__`、`*.dist-info` 等)以控制体积。

#### Scenario: 资源完整可用
- **WHEN** 应用启动并加载资源
- **THEN** 后端能找到 `agent/` 源码与 `agent/.env`,webview 能加载 `frontend/dist`,功能完整

#### Scenario: 体积裁剪生效
- **WHEN** 完成打包
- **THEN** 产物中不包含测试目录、`__pycache__` 等非运行必需文件

