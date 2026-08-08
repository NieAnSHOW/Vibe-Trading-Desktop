import { describe, expect, it } from "vitest";
import { SCENES } from "./scenes";

describe("ProductIntro timeline", () => {
  it("ends with the approved brand close", () => {
    expect(SCENES.at(-1)).toMatchObject({
      durationInFrames: 180,
      from: 1440,
      subtitle: "从市场信息，到可验证的研究",
      title: "Trading Worker",
    });
  });
});
