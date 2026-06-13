# Implementation Tasks — desktop-weasyprint-native-libs

> 任务按依赖排序。标注 `[spike]` 的探查任务建议在 comet-design 阶段优先处理。

## 1. 原生库链探查 [spike]

- [ ] 1.1 `[spike]` 在 macOS 上用 `otool -L` 枚举 weasyprint 依赖的完整 dylib 链（pango/cairo/glib/fontconfig/freetype/harfbuzz/gdk-pixbuf 及其递归依赖）
- [ ] 1.2 `[spike]` 确定 macOS 原生库获取方式：`delocate` 能否自动收集 vs 从 Homebrew 提取 vs `gtk-mac-bundler`（D1）
- [ ] 1.3 `[spike]` 确定 Windows dll 的稳定来源（GTK for Windows runtime / MSYS2）与版本锁定
- [ ] 1.4 `[spike]` 确认 weasyprint wheel 本身是否携带部分 dylib，明确仍需补齐的清单

## 2. 打包辅助脚本（收集与路径修复）

- [ ] 2.1 新增 macOS 原生库收集脚本（如 `scripts/desktop/collect-native-libs.sh`）：递归收集 dylib 到 bundle lib 目录
- [ ] 2.2 实现 dylib 路径修复：`otool -L` 枚举 + `install_name_tool -id/-change` 改写为 `@rpath`/`@loader_path` 相对引用
- [ ] 2.3 新增 Windows dll 收集与布局（置于与 python.exe 同级或 PATH 可达目录）
- [ ] 2.4 编写冒烟测试：在内嵌运行时 `import weasyprint` + 渲染一页 PDF 不报动态库错误

## 3. install-deps.sh 装回 weasyprint

- [ ] 3.1 移除 `install-deps.sh` 中 `grep -viE '^\s*weasyprint'` 的排除逻辑（在原生库就位后）
- [ ] 3.2 验证 weasyprint Python 包安装成功且 import 不因缺系统库失败

## 4. 运行时环境变量注入

- [ ] 4.1 `src-tauri/src/resources.rs` 解析 bundle 内原生库与配置目录路径
- [ ] 4.2 `src-tauri/src/sidecar.rs` spawn 时注入环境变量（`FONTCONFIG_PATH`/`FONTCONFIG_FILE`/`PANGO_SYSCONF_DIR`/`GDK_PIXBUF_MODULEDIR`/`XDG_DATA_DIRS`/`XML_CATALOG_FILES` 等，最终清单依 spike）
- [ ] 4.3 Windows 下注入 `PATH` 前缀指向 dll 目录

## 5. 字体与配置

- [ ] 5.1 准备 bundle 内 fontconfig 配置（含系统字体路径，确保 PingFang/Noto 可见）
- [ ] 5.2 验证 weasyprint 可用时 CJK 中文字体仍被正确加载（复用 `fonts.py`）

## 6. 集成与打包流程

- [ ] 6.1 `assemble.sh` 将原生库目录与配置纳入打包资源
- [ ] 6.2 `tauri.conf.json` 声明原生库资源
- [ ] 6.3 记录 weasyprint 与原生库的兼容版本矩阵

## 7. 验证与测试

- [ ] 7.1 macOS 真机验证：未安装 GTK 的机器上影子账户报告生成 PDF（含中文字体）
- [ ] 7.2 Windows 真机验证：同上
- [ ] 7.3 原生库随安装路径迁移的可重定位性验证
- [ ] 7.4 降级兜底验证：故意破坏原生库，确认 `reporter.py` 降级 HTML-only 不抛异常
- [ ] 7.5 codesign / notarization 流程纳入随包 dylib 并验证通过
- [ ] 7.6 记录 bundle 体积增量
