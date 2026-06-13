## Why

`scripts/desktop/install-deps.sh` 明确「排除 weasyprint」，原因是 weasyprint 依赖 cairo / pango / gdk-pixbuf 等系统原生 C 库——这些非 pip 系统依赖无法用 pip/uv 装入 `site-packages`，在用户机器上也通常不存在（除非用户自行安装 GTK / Homebrew）。结果是：桌面端影子账户（`shadow_account`）的 HTML→PDF 报告永远走 `reporter.py` 的 try/except 软降级，降级为 HTML-only，**用户拿不到 PDF 产物**。这与桌面端「双击即用、零系统依赖」的目标相悖。

## What Changes

- 将 weasyprint 渲染所需的系统原生库链（pango、cairo、gdk-pixbuf、glib、fontconfig、freetype、harfbuzz 等）及其配置随包打进应用 bundle。
- 修复这些原生库的动态库查找路径（macOS 的 `install_name` / `@rpath` / `@loader_path`，Windows 的 dll 查找路径），使其在 bundle 内相对解析，不依赖用户系统。
- sidecar 启动时注入相关环境变量（如 `FONTCONFIG_PATH`、`PANGO_SYSCONF_DIR`、`GDK_PIXBUF_MODULEDIR`、`XDG_DATA_DIRS`）指向 bundle 内配置。
- `install-deps.sh` 在原生库就位后**不再排除 weasyprint**，正常安装 weasyprint Python 包。
- 复用 `shadow_account/fonts.py` 既有的 CJK 字体机制，确保 PDF 含中文字体。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `desktop-packaging-build`: 新增「PDF 报告系统原生库随包」requirement——打包流程 SHALL 将 weasyprint 所需系统原生库随包并提供给运行时，使影子账户 PDF 报告无需用户安装任何系统库即可生成；并 SHALL 保留既有 HTML-only 软降级作为兜底。

## Impact

- **代码**：
  - `scripts/desktop/install-deps.sh`、`assemble.sh`：原生库收集、weasyprint 装回、配置文件随包
  - `src-tauri/src/sidecar.rs`：注入原生库相关环境变量
  - `src-tauri/src/resources.rs`：原生库资源目录解析
  - 可能新增打包辅助脚本（dylib 收集 / `install_name` 修复，如 `scripts/desktop/collect-native-libs.sh`）
- **依赖与体积**：bundle 增大（pango/cairo/glib 等约几十 MB，随平台不同）；weasyprint Python 包本身较小。
- **平台**：macOS（arm64 + x86_64）+ Windows；两平台的原生库获取与布局方式不同（macOS 多用 Homebrew 提取 / delocate；Windows 多用 GTK runtime / MSYS2 dll）。
- **签名/公证**：macOS 上随包的 dylib 须经 codesign 与 notarization；需在 build 流程验证。
- **不改**：`shadow_account/reporter.py` 的渲染与降级逻辑、`fonts.py` 的字体机制。
