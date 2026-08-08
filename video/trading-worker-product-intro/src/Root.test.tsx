import { describe, expect, it } from "vitest";
import { PRODUCT_VIDEO } from "./scenes";

describe("product video metadata", () => {
	it("uses the approved 1080p 54-second delivery format", () => {
		expect(PRODUCT_VIDEO).toEqual({
			durationInFrames: 1620,
			fps: 30,
			height: 1080,
			width: 1920,
		});
	});
});
