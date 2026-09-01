import { describe, expect, it } from "vitest";
import { Navigate } from "react-router-dom";
import { routes } from "../router";

describe("legacy /news route", () => {
  it("redirects to /watchlist with replace semantics", () => {
    const root = routes.find((r) => r.path === undefined);
    const news = root?.children?.find((r) => r.path === "/news");

    expect(news).toBeDefined();
    expect(news?.element.type).toBe(Navigate);
    expect(news?.element.props.to).toBe("/watchlist");
    expect(news?.element.props.replace).toBe(true);
  });
});
