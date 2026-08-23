import { reactive } from "vue";
import { consoleGetPublicConfig } from "../ipc/commands";

/**
 * 公共配置（默认值 + 服务端覆盖）。
 * 启动时由 App.vue 调用 loadPublicConfig() 拉取 /app/base/comm/publicConfig 动态更新；
 * 拉取失败时静默保留默认值，不阻塞启动。
 * 默认值镜像服务端 comm.ts publicConfig 的 defaults，服务端缺字段时兜底。
 */
export const config = reactive({
    // 静态资源 baseURL（Rust 侧 user_api_url() 填充；本地无服务时为 ""，图片加载失败属预期）
    imgBase: "",
    // 是否启用 login
    enableLogin: true,
    // 是否启用广告 【服务端 comm.ts 统一管理，见 loadPublicConfig】
    enableAd: true,
    // 是否启用检查更新
    checkUpdate: false,
    // 官方链接
    officialUrl: "",
    // 是否启用付费服务（会员）
    enableService: false,
    // 服务购买二维码
    serviceQrCode: "",
    // 客服微信二维码（登录用户「联系客服」弹窗展示）
    kefuQrCode: "",
    // 支持作者二维码（登录用户「支持作者领中级会员」弹窗展示）
    rewardQrCode: "",
});

let publicConfigLoading: Promise<void> | null = null;

export function loadPublicConfig(): Promise<void> {
    if (!publicConfigLoading) {
        publicConfigLoading = (async () => {
            try {
                const remote = await consoleGetPublicConfig();
                Object.assign(config, {
                    officialUrl: remote.officialUrl,
                    enableLogin: remote.enableLogin,
                    checkUpdate: remote.checkUpdate,
                    enableService: remote.enableService,
                    serviceQrCode: remote.serviceQrCode,
                    kefuQrCode: remote.kefuQrCode,
                    rewardQrCode: remote.rewardQrCode,
                    enableAd: remote.enableAd,
                    imgBase: remote.imgBase || config.imgBase,
                });
            } catch {
                // 静默失败：保留默认值
            }
        })();
    }
    return publicConfigLoading;
}
