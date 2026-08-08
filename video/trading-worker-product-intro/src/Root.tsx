import { Composition } from "remotion";
import { ProductIntro } from "./ProductIntro";
import { PRODUCT_VIDEO } from "./scenes";

export const RemotionRoot = () => (
  <Composition
    id="TradingWorkerProductIntro"
    component={ProductIntro}
    {...PRODUCT_VIDEO}
  />
);
