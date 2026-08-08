import { describe, expect, it } from "vitest";
import { clampProgress, sceneOpacity } from "./Motion";
import { SCENES } from "../scenes";

describe("video timing", () => {
  it("fills exactly the approved duration without gaps", () => {
    expect(SCENES.map((scene) => [scene.from, scene.durationInFrames])).toEqual([
      [0, 210], [210, 270], [480, 330], [810, 360], [1170, 270], [1440, 180],
    ]);
  });

  it("clamps visual progress and fades a scene at both edges", () => {
    expect(clampProgress(-4, 0, 20)).toBe(0);
    expect(clampProgress(10, 0, 20)).toBe(0.5);
    expect(clampProgress(40, 0, 20)).toBe(1);
    expect(sceneOpacity(0, 210)).toBe(0);
    expect(sceneOpacity(105, 210)).toBe(1);
    expect(sceneOpacity(209, 210)).toBeLessThan(1);
  });
});
