import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
} from "remotion";
import type { CSSProperties } from "react";
import type { Scene } from "../scenes";
import { sceneOpacity } from "./Motion";

const FPS = 30;
const OUTRO_IMAGES = ["ui/console.png", "ui/market.png", "ui/agent.png", "ui/reports.png", "ui/alpha-zoo.png"] as const;

export const SceneFrame = ({ frame, scene }: { frame: number; scene: Scene }) => {
  const entrance = spring({
    frame,
    fps: FPS,
    config: { damping: 200, mass: 0.9, stiffness: 120 },
  });
  const titleY = interpolate(entrance, [0, 1], [42, 0], {
    easing: Easing.out(Easing.cubic),
  });
  const imageScale = interpolate(frame, [0, scene.durationInFrames], [1.03, 1.12], {
    extrapolateRight: "clamp",
  });
  const visualOpacity = sceneOpacity(frame, scene.durationInFrames);
  const accentProgress = interpolate(frame, [12, 96], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const outroOpacity = interpolate(frame, [0, 36, 132, scene.durationInFrames], [0.04, 0.28, 0.18, 0.04], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const titleStyle: CSSProperties = {
    color: "#f8fafc",
    fontSize: 86,
    fontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1.08,
    maxWidth: 1320,
    textShadow: "0 3px 18px rgba(2, 6, 23, 0.45)",
    transform: `translateY(${titleY}px)`,
  };

  return (
    <AbsoluteFill
      data-testid="scene-frame"
      style={{
        backgroundColor: "#080b16",
        backgroundImage: scene.image
          ? undefined
          : "linear-gradient(rgba(148, 163, 184, 0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.055) 1px, transparent 1px)",
        backgroundSize: scene.image ? undefined : "72px 72px",
      }}
    >
      <AbsoluteFill data-testid="scene-visuals" style={{ opacity: visualOpacity }}>
        {scene.image ? (
          <Img
            src={staticFile(scene.image)}
            style={{ height: "100%", objectFit: "cover", transform: `scale(${imageScale})`, width: "100%" }}
          />
        ) : null}
        {scene.supplementalImages?.map((image, index) => (
          <Img
            key={image}
            src={staticFile(image)}
            style={{
              bottom: 88 + index * 54,
              position: "absolute",
              right: 88 + index * 72,
              transform: `scale(${0.28 - index * 0.04}) rotate(${index === 0 ? 2 : -2}deg)`,
              transformOrigin: "bottom right",
              width: 760,
            }}
          />
        ))}
        {scene.id === "alpha" ? (
          <div
            data-testid="alpha-count-mask"
            style={{ backgroundColor: "#f8fafc", height: 82, left: 88, position: "absolute", top: 0, width: 920 }}
          />
        ) : null}
        {scene.id === "agent" ? (
          <div style={{ bottom: 330, display: "flex", gap: 18, position: "absolute", right: 108 }}>
            {["解析问题", "检索数据", "生成研究"].map((label, index) => (
              <div
                key={label}
                style={{
                  backgroundColor: "rgba(8, 22, 49, 0.82)",
                  border: "1px solid rgba(96, 165, 250, 0.72)",
                  borderRadius: 22,
                  color: "#dbeafe",
                  fontSize: 22,
                  opacity: interpolate(accentProgress, [index * 0.28, index * 0.28 + 0.2], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                  padding: "14px 22px",
                  transform: `translateY(${interpolate(accentProgress, [index * 0.28, index * 0.28 + 0.2], [24, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
                }}
              >
                {label}
              </div>
            ))}
          </div>
        ) : null}
        {scene.id === "backtest" ? (
          <div style={{ backgroundColor: "rgba(148, 163, 184, 0.32)", height: 4, left: 104, position: "absolute", right: 104, top: 122 }}>
            <div
              style={{
                background: "linear-gradient(90deg, #38bdf8, #a78bfa)",
                boxShadow: "0 0 18px rgba(56, 189, 248, 0.82)",
                height: "100%",
                width: `${interpolate(accentProgress, [0, 1], [0, 100])}%`,
              }}
            />
          </div>
        ) : null}
        {scene.id === "alpha" ? (
          <div style={{ display: "flex", gap: 14, left: 110, position: "absolute", top: 128 }}>
            {["因子库", "质量筛选", "已选"].map((label, index) => (
              <div
                key={label}
                style={{
                  backgroundColor: index === 2 ? "rgba(14, 116, 144, 0.9)" : "rgba(15, 23, 42, 0.82)",
                  border: "1px solid rgba(125, 211, 252, 0.62)",
                  borderRadius: 18,
                  color: "#e0f2fe",
                  fontSize: 20,
                  opacity: interpolate(accentProgress, [index * 0.24, index * 0.24 + 0.22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                  padding: "10px 18px",
                  transform: `translateX(${interpolate(accentProgress, [index * 0.24, index * 0.24 + 0.22], [-20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
                }}
              >
                {label}
              </div>
            ))}
          </div>
        ) : null}
        {scene.id === "outro" ? (
          <>
            {OUTRO_IMAGES.map((image, index) => (
              <Img
                key={image}
                src={staticFile(image)}
                style={{
                  border: "1px solid rgba(148, 163, 184, 0.3)",
                  height: 260,
                  left: 170 + (index % 3) * 520,
                  objectFit: "cover",
                  opacity: outroOpacity,
                  position: "absolute",
                  top: 96 + Math.floor(index / 3) * 300,
                  transform: `scale(${interpolate(frame, [0, scene.durationInFrames], [0.84, 1.08], { extrapolateRight: "clamp" })})`,
                  width: 440,
                }}
              />
            ))}
            <AbsoluteFill
              style={{
                backgroundImage: "linear-gradient(rgba(148, 163, 184, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.1) 1px, transparent 1px)",
                backgroundSize: "72px 72px",
              }}
            />
          </>
        ) : null}
        <AbsoluteFill style={{ backgroundColor: "rgba(3, 7, 18, 0.28)" }} />
        <AbsoluteFill
          style={{
            background: "linear-gradient(100deg, rgba(37, 99, 235, 0.7), rgba(124, 58, 237, 0.12) 68%, transparent)",
            height: 260,
            top: "auto",
          }}
        />
      </AbsoluteFill>
      <div style={{ bottom: 96, left: 96, position: "absolute", right: scene.safetyLabel ? 820 : 96 }}>
        <div style={titleStyle}>{scene.title}</div>
        {scene.subtitle ? (
          <div style={{ color: "rgba(226, 232, 240, 0.9)", fontSize: 30, marginTop: 24 }}>{scene.subtitle}</div>
        ) : null}
      </div>
      {scene.safetyLabel ? (
        <div
          style={{
            bottom: 96,
            color: "rgba(226, 232, 240, 0.82)",
            fontSize: 20,
            maxWidth: 680,
            position: "absolute",
            right: 96,
            textAlign: "right",
          }}
        >
          {scene.safetyLabel}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
