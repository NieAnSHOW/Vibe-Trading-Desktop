## Context

`shadow_account/reporter.py` 把 weasyprint 当作**软依赖**：`from weasyprint import HTML` 在 try 块内执行，import 或 `write_pdf` 任一失败都降级为 HTML-only 输出（不抛未捕获异常）。`install-deps.sh` 因 cairo/pango 系统库问题排除 weasyprint，故桌面端长期走 HTML-only 分支。

`shadow_account/fonts.py` 已实现跨平台 CJK 字体机制：优先复用系统字体（macOS PingFang、Linux Noto、Windows Fonts），缺失时从 notofonts 下载到 `~/.vibe-trading/fonts`。**字体问题已有解法**，本次不重复解决，仅验证在 weasyprint 可用后中文字体仍正确。

核心难点是 weasyprint 的**系统原生库链**（macOS 下 pango→cairo→glib→fontconfig→freetype→harfbuzz→gdk-pixbuf 的递归 dylib 依赖；Windows 下对应 dll），需要随包并修复查找路径。

## Goals / Non-Goals

**Goals:**
- 桌面端影子账户报告在**用户未安装任何系统库**（无 GTK / Homebrew / MSYS2）的前提下，能成功生成 PDF（含中文字体）。
- 原生库从 bundle 内相对解析，可重定位（随安装路径迁移）。
- macOS（arm64 + x86_64）与 Windows 双平台支持。

**Non-Goals:**
- 不替换 weasyprint 为其他 PDF 库（如 reportlab）——用户明确选择「打包原生库」路线。
- 不改 `reporter.py` 渲染逻辑与 `fonts.py` 字体机制。
- 不解决运行时按需安装券商 SDK（属 change 1）。
- 不做跨平台交叉编译（遵循既有「macOS 包须在 macOS 构建」约束）。

## Decisions

### D1：原生库获取方式 — 平台分化，spike 后定稿
- **macOS**：候选方案 ① `delocate`（Python 生态，可递归收集 wheel 的 dylib 依赖并修 `@rpath`）；② 从 Homebrew `pango`/`cairo` 安装树提取 dylib + `install_name_tool` 手动修链；③ `gtk-mac-bundler`。倾向 ①（与 Python 打包生态一致、自动化程度高），spike 验证 weasyprint 的 wheel 是否携带/可收集完整 dylib 链。
- **Windows**：候选方案 ① GTK for Windows runtime 的 dll 集合；② MSYS2 的 mingw dll。倾向稳定来源的预编译 dll 集，随包置于 bundle 内独立目录。

### D2：动态库查找路径修复
- **macOS**：用 `otool -L` 枚举递归依赖，`install_name_tool -id/-change` 将绝对路径改写为 `@rpath`/`@loader_path` 相对引用；设置运行时 `DYLD_LIBRARY_PATH` 指向 bundle 内 lib 目录（注意 macOS 签名与 SIP 对 `DYLD_*` 的限制，可能需走 `@rpath` 而非环境变量）。
- **Windows**：将 dll 置于与 python.exe 同级或 PATH 可达目录（sidecar spawn 时注入 `PATH` 前缀）。

### D3：运行时环境变量注入
sidecar spawn 时注入：`FONTCONFIG_PATH`、`FONTCONFIG_FILE`、`PANGO_SYSCONF_DIR`、`GDK_PIXBUF_MODULEDIR`、`GDK_PIXBUF_MODULE_FILE`、`XDG_DATA_DIRS`、`XML_CATALOG_FILES` 等，均指向 bundle 内配置。具体清单在 spike 后定稿。

### D4：install-deps.sh 装回 weasyprint
在原生库就位、环境变量可解析后，移除 `install-deps.sh` 对 weasyprint 的排除（`grep -viE '^\s*weasyprint'` 那行），正常安装 weasyprint Python 包。注意：weasyprint wheel 本身不含系统库，需与 D1 的原生库打包配合。

### D5：字体复用
不改动 `fonts.py`；在验证阶段确认 weasyprint 加载 bundle 原生库后，CJK 字体（PingFang/Noto）仍被正确使用；若 fontconfig 配置导致系统字体不可见，则在 bundle 内 fontconfig 配置中显式包含系统字体路径。

## Risks / Trade-offs

- **[体积增大]** → pango/cairo/glib 等约几十 MB；接受（PDF 报告是核心交付）。可在打包后记录体积增量。
- **[dylib 链递归复杂、易遗漏]** → `otool -L` 自动化递归枚举 + 冒烟测试（import + 渲染一页）。
- **[macOS DYLD_* 受 SIP/签名限制]** → 优先 `@rpath` 相对引用，避免依赖 `DYLD_LIBRARY_PATH`；硬编码 entitlements 评估。
- **[签名/公证失败]** → 随包 dylib 纳入 codesign 与 notarization 流程，build 后真机验证。
- **[平台差异导致双份工作]** → 接受；遵循既有「各平台在本机构建」约束。
- **[原生库升级与 weasyprint 版本耦合]** → 记录 weasyprint 与原生库的兼容版本矩阵。

## Migration Plan

1. spike 确定 macOS 原生库获取与修复方式（D1）。
2. 实现打包辅助脚本（收集 + 修 rpath）。
3. `install-deps.sh` 装回 weasyprint（D4）。
4. sidecar 环境变量注入（D3）。
5. 双平台真机验证 PDF 生成 + 中文字体。
6. 回滚：恢复 `install-deps.sh` 排除 weasyprint 即回到 HTML-only 降级（`reporter.py` 已兜底，安全）。

## Open Questions（交 comet-design 阶段 spike / 决策）

- macOS 原生库获取的最终方式（delocate vs Homebrew 提取 vs gtk-mac-bundler）。
- weasyprint wheel 是否已携带部分 dylib、还需补哪些。
- 需注入的环境变量完整清单（D3）。
- 体积增量精确测量。
- macOS 上 `@rpath` 方案与 codesign/notarization 的兼容性验证。
- Windows dll 的稳定来源与版本锁定。
