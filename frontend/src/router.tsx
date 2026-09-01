import { Suspense, lazy, type ComponentType } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";


const Agent = lazy(() => import("@/pages/Agent").then((m) => ({ default: m.Agent })));
const Usage = lazy(() => import("@/pages/Usage").then((m) => ({ default: m.Usage })));
const RunDetail = lazy(() =>
  import("@/pages/RunDetail").then((m) => ({ default: m.RunDetail })),
);
const Compare = lazy(() =>
  import("@/pages/Compare").then((m) => ({ default: m.Compare })),
);
const Runtime = lazy(() =>
  import("@/pages/Runtime").then((m) => ({ default: m.Runtime })),
);
const Reports = lazy(() =>
  import("@/pages/Reports").then((m) => ({ default: m.Reports })),
);
const Correlation = lazy(() =>
  import("@/pages/Correlation").then((m) => ({ default: m.Correlation })),
);
const AlphaZoo = lazy(() =>
  import("@/pages/AlphaZoo").then((m) => ({ default: m.AlphaZoo })),
);

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const MarketPulse = lazy(() => import("@/pages/MarketPulse"));
const Indices = lazy(() => import("@/pages/Indices"));
const Watchlist = lazy(() => import("@/pages/Watchlist"));



function PageLoader() {
  return (
    <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
      Loading…
    </div>
  );
}

function wrap(Component: ComponentType) {
  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  );
}

export const routes = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: wrap(Dashboard) },
      { path: "/agent", element: wrap(Agent) },
      { path: "/usage", element: wrap(Usage) },
      { path: "/runtime", element: wrap(Runtime) },
      { path: "/reports", element: wrap(Reports) },
      // 旧版设置页路径:页面已更名为运行时,保留别名兼容既有链接。
      { path: "/settings", element: <Navigate to="/runtime" replace /> },
      { path: "/runs/:runId", element: wrap(RunDetail) },
      { path: "/compare", element: wrap(Compare) },
      { path: "/correlation", element: wrap(Correlation) },
      { path: "/alpha-zoo", element: wrap(AlphaZoo) },
      { path: "/alpha-zoo/bench", element: wrap(AlphaZoo) },
      { path: "/alpha-zoo/compare", element: wrap(AlphaZoo) },
      { path: "/alpha-zoo/:alphaId", element: wrap(AlphaZoo) },
      { path: "/dashboard", element: wrap(Dashboard) },
      { path: "/market-pulse", element: wrap(MarketPulse) },
      { path: "/indices", element: wrap(Indices) },
      { path: "/watchlist", element: wrap(Watchlist) },
      // 旧版投资资讯路径：页面已移除（spec 2026-08-30 §2.3），重定向到自选股。
      { path: "/news", element: <Navigate to="/watchlist" replace /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
