## ADDED Requirements

### Requirement: PDF 报告系统原生库随包
打包流程 SHALL 将 weasyprint 渲染 PDF 所需的系统原生库（pango、cairo、gdk-pixbuf、glib、fontconfig、freetype、harfbuzz 等）及其配置随包打进应用 bundle，并 SHALL 通过动态库路径修复与运行时环境变量注入，使其在用户机器上无需预装 GTK / Homebrew / MSYS2 即可被 weasyprint 加载。

#### Scenario: PDF 报告在无 GTK 的机器上生成
- **WHEN** 应用安装在一台未安装 GTK / pango / cairo 的全新机器上，并触发影子账户报告生成
- **THEN** weasyprint 成功加载 bundle 内原生库并生成 PDF（非 HTML-only 降级），且 PDF 含中文字体

#### Scenario: 原生库在 bundle 内相对解析
- **WHEN** weasyprint 在运行时加载 pango / cairo 等原生库
- **THEN** 这些库从 bundle 内的相对路径解析（`@rpath` / dll 同级目录），不依赖系统级 dylib / dll

#### Scenario: 原生库随安装路径迁移
- **WHEN** 应用被安装到不同目标路径（不同用户名 / 安装目录）
- **THEN** 原生库仍能被正确加载，不因绝对路径写死而失败

### Requirement: HTML-only 软降级能力保留
打包流程 SHALL 保留 `shadow_account/reporter.py` 既有的软降级行为（weasyprint import 或渲染失败时回退 HTML-only，不抛未捕获异常），以确保即使在原生库异常时影子账户报告仍能产出 HTML。

#### Scenario: 原生库异常时降级 HTML
- **WHEN** weasyprint 因原生库加载或渲染失败
- **THEN** 报告流程降级为 HTML-only 输出，不抛出未捕获异常，HTML 产物正常生成
