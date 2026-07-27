const MIN_HEIGHT = 600;
const MAX_HEIGHT_WITH_AD_DATA = 880;

export function resolveConsoleWindowHeight({
  contentHeight,
  titleBarHeight,
  hasAdData,
}: {
  contentHeight: number;
  titleBarHeight: number;
  hasAdData: boolean;
}): number {
  const outerHeight = Math.ceil(contentHeight + titleBarHeight);
  const maxHeight = hasAdData ? MAX_HEIGHT_WITH_AD_DATA : Infinity;
  return Math.max(MIN_HEIGHT, Math.min(outerHeight, maxHeight));
}
