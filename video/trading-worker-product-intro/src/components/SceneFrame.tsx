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
    <AbsoluteFill style={{ backgroundColor: "#080b16", opacity: sceneOpacity(frame, scene.durationInFrames) }}>
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
      <AbsoluteFill style={{ backgroundColor: "rgba(3, 7, 18, 0.28)" }} />
      <AbsoluteFill
        style={{
          background: "linear-gradient(100deg, rgba(37, 99, 235, 0.7), rgba(124, 58, 237, 0.12) 68%, transparent)",
          height: 260,
          top: "auto",
        }}
      />
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
