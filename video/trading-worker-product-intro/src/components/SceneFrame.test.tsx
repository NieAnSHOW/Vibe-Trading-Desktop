// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("remotion", async () => {
  const actual = await vi.importActual<typeof import("remotion")>("remotion");
  return {
    ...actual,
    // eslint-disable-next-line @remotion/warn-native-media-tag
    Img: ({ src, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img src={src} {...props} />,
  };
});

import { SceneFrame } from "./SceneFrame";
import type { Scene } from "../scenes";

afterEach(cleanup);

const baseScene: Scene = {
  durationInFrames: 360,
  from: 810,
  id: "backtest",
  image: "ui/reports.png",
  safetyLabel: "回测结果仅供研究参考，不代表未来表现",
  title: "让每个想法，经过验证",
};

describe("SceneFrame", () => {
  it("renders approved research copy and safety disclosure", () => {
    const { getByTestId } = render(<SceneFrame frame={0} scene={baseScene} />);
    expect(screen.getByText("让每个想法，经过验证")).toBeInTheDocument();
    expect(screen.getByText("回测结果仅供研究参考，不代表未来表现")).toBeInTheDocument();
    expect(getByTestId("scene-frame")).not.toHaveStyle({ opacity: "0.18" });
    expect(getByTestId("scene-visuals")).toHaveStyle({ opacity: "0.18" });
  });

  it("does not render a disclosure for non-backtest scenes", () => {
    render(<SceneFrame frame={30} scene={{ ...baseScene, id: "agent", safetyLabel: undefined }} />);
    expect(screen.queryByText("回测结果仅供研究参考，不代表未来表现")).not.toBeInTheDocument();
  });

  it("masks the Alpha Zoo factor count while retaining the generic title", () => {
    render(
      <SceneFrame
        frame={30}
        scene={{ ...baseScene, id: "alpha", safetyLabel: undefined, title: "探索你的下一条研究线索" }}
      />,
    );
    expect(screen.getByTestId("alpha-count-mask")).toBeInTheDocument();
    expect(screen.getByText("探索你的下一条研究线索")).toBeInTheDocument();
  });
});
