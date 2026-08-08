export const PRODUCT_VIDEO = {
  durationInFrames: 1620,
  fps: 30,
  height: 1080,
  width: 1920,
} as const;

export type Scene = {
  id: "console" | "market" | "agent" | "backtest" | "alpha" | "outro";
  from: number;
  durationInFrames: number;
  image?: string;
  supplementalImages?: readonly string[];
  title: string;
  subtitle?: string;
  safetyLabel?: string;
};

export const SCENES: readonly Scene[] = [
  {
    id: "console",
    from: 0,
    durationInFrames: 210,
    image: "ui/console.png",
    title: "你的 AI 研究工作台",
    subtitle: "本地启动 · 一键进入研究",
  },
  {
    id: "market",
    from: 210,
    durationInFrames: 270,
    image: "ui/market.png",
    supplementalImages: ["ui/anomaly.png", "ui/chart.png"],
    title: "看见市场正在发生什么",
  },
  {
    id: "agent",
    from: 480,
    durationInFrames: 330,
    image: "ui/agent.png",
    title: "用自然语言，开始研究",
  },
  {
    id: "backtest",
    from: 810,
    durationInFrames: 360,
    image: "ui/reports.png",
    title: "让每个想法，经过验证",
    safetyLabel: "回测结果仅供研究参考，不代表未来表现",
  },
  {
    id: "alpha",
    from: 1170,
    durationInFrames: 270,
    image: "ui/alpha-zoo.png",
    title: "探索你的下一条研究线索",
  },
  {
    id: "outro",
    from: 1440,
    durationInFrames: 180,
    title: "Trading Worker",
    subtitle: "从市场信息，到可验证的研究",
  },
];
