import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/stores/agent";

const { apiMock, connectMock, disconnectMock, onStatusChangeMock, handlersRef, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getSessionMessages: vi.fn(),
    getRun: vi.fn(),
    getGoal: vi.fn(),
    getLiveStatus: vi.fn(),
    getLLMSettings: vi.fn(),
    updateVIPModel: vi.fn(),
    sendMessage: vi.fn(),
    sseUrl: vi.fn(),
  },
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  onStatusChangeMock: vi.fn(),
  handlersRef: { current: {} as Record<string, (data: Record<string, unknown>) => void> },
  toastMock: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error { status = 0; },
  AUTH_REQUIRED_MESSAGE: "auth required",
  isAuthRequiredError: () => false,
}));
vi.mock("@/hooks/useSSE", () => ({
  useSSE: () => ({
    connect: connectMock.mockImplementation((_url: string, handlers: Record<string, (data: Record<string, unknown>) => void>) => {
      handlersRef.current = handlers;
    }),
    disconnect: disconnectMock,
    onStatusChange: onStatusChangeMock,
  }),
}));
vi.mock("@/components/chat/AgentAvatar", () => ({ AgentAvatar: () => <div /> }));
vi.mock("@/components/chat/WelcomeScreen", () => ({ WelcomeScreen: () => <div /> }));
vi.mock("@/components/chat/MessageBubble", () => ({ MessageBubble: () => <div /> }));
vi.mock("@/components/chat/ThinkingTimeline", () => ({ ThinkingTimeline: () => <div /> }));
vi.mock("@/components/chat/ConversationTimeline", () => ({ ConversationTimeline: () => <div /> }));
vi.mock("@/components/chat/ToolProgressIndicator", () => ({ ToolProgressIndicator: () => <div /> }));
vi.mock("@/components/chat/MandateProposalCard", () => ({ MandateProposalCard: () => <div /> }));
vi.mock("@/components/chat/RunnerStatus", () => ({ RunnerStatus: () => <div /> }));
vi.mock("@/components/chat/SwarmStatusCard", () => ({ SwarmStatusCard: () => <div /> }));

import { Agent } from "../Agent";

const renderAgent = () => render(
  <MemoryRouter initialEntries={["/agent?session=session-a"]}>
    <Routes><Route path="/agent" element={<Agent />} /></Routes>
  </MemoryRouter>,
);

const llmUsage = {
  provider: "vip_server",
  model: "hosted",
  metering_eligible: true,
  totals: { input_tokens: 8, output_tokens: 2, total_tokens: 10, calls: 1 },
  per_iteration: [{ iter: 1, input_tokens: 8, output_tokens: 2, total_tokens: 10 }],
};

describe("Agent attempt completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.getState().reset();
    useAgentStore.getState().setSessionId("session-a");
    apiMock.getSessionMessages.mockResolvedValue([]);
    apiMock.getGoal.mockResolvedValue(null);
    apiMock.getLiveStatus.mockResolvedValue({ global_halted: false, brokers: [] });
    apiMock.getLLMSettings.mockResolvedValue({ sse_timeout_seconds: 90 });
    apiMock.sendMessage.mockResolvedValue({ attempt_id: "attempt-a" });
    apiMock.sseUrl.mockReturnValue("/sessions/session-a/events");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups the prompt controls and VIP model selector in one composer", async () => {
    apiMock.getLLMSettings.mockResolvedValue({
      sse_timeout_seconds: 90,
      desktop_login_provisioned: true,
      desktop_llm_mode: "vip",
      desktop_vip_available: true,
      model_name: "gpt-5.6-terra",
      vip_models: ["gpt-5.6-terra", "gpt-5.6-sol"],
    });

    renderAgent();

    const composer = await screen.findByTestId("agent-composer");
    expect(composer).toContainElement(screen.getByPlaceholderText("agent.placeholder"));
    expect(composer).toContainElement(screen.getByLabelText("agent.vipModel"));
    expect(composer.querySelector("button[type='submit']")).toBeInTheDocument();
  });

  it("starts the composer at a single input row", async () => {
    renderAgent();

    const input = await screen.findByPlaceholderText("agent.placeholder");
    expect(input).toHaveAttribute("rows", "1");
    expect(input).not.toHaveClass("min-h-24");
  });

  it("only enables textarea scrolling after the maximum input height", async () => {
    renderAgent();

    const input = await screen.findByPlaceholderText("agent.placeholder");
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 36 });
    fireEvent.input(input);

    expect(input).toHaveStyle({ height: "36px", overflowY: "hidden" });

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 128 });
    fireEvent.input(input);

    expect(input).toHaveStyle({ height: "128px", overflowY: "hidden" });

    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 200 });
    fireEvent.input(input);

    expect(input).toHaveStyle({ height: "128px", overflowY: "auto" });
  });

  it("keeps export and send in one right-side composer action group", async () => {
    apiMock.getSessionMessages.mockResolvedValue([{
      message_id: "assistant-a",
      role: "assistant",
      content: "Completed analysis",
      created_at: "2026-07-27T01:00:00Z",
      linked_attempt_id: null,
      metadata: {},
    }]);

    renderAgent();

    const actions = await screen.findByTestId("agent-composer-actions");
    expect(actions).toContainElement(screen.getByTitle("agent.exportChat"));
    expect(actions.querySelector("button[type='submit']")).toBeInTheDocument();
  });

  it("treats ignored llm_usage events as watchdog activity", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-23T04:00:00Z"));
    apiMock.getLLMSettings.mockResolvedValue({ sse_timeout_seconds: 20 });
    renderAgent();
    await waitFor(() => expect(connectMock).toHaveBeenCalled());
    await waitFor(() => expect(apiMock.getLLMSettings).toHaveBeenCalled());

    await act(async () => {
      handlersRef.current["attempt.created"]({ attempt_id: "attempt-a" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      handlersRef.current.llm_usage({
        iter: 1, provider: "vip_server", model: "hosted", metering_eligible: true,
        input_tokens: 8, output_tokens: 2, total_tokens: 10,
      });
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(useAgentStore.getState().status).toBe("streaming");
    expect(useAgentStore.getState().messages.some((message) => message.type === "llm_usage")).toBe(false);
    expect(screen.queryByLabelText("llmUsage.title")).not.toBeInTheDocument();
    expect(apiMock.getRun).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    expect(useAgentStore.getState().status).toBe("idle");
  });

  it("ignores llm_usage events without a chat message or live card", async () => {
    renderAgent();
    await waitFor(() => expect(connectMock).toHaveBeenCalled());

    await act(async () => {
      handlersRef.current.llm_usage({
        iter: 1, provider: "vip_server", model: "hosted", metering_eligible: true,
        input_tokens: 8, output_tokens: 2, total_tokens: 10,
      });
    });

    expect(useAgentStore.getState().messages.some((message) => message.type === "llm_usage")).toBe(false);
    expect(screen.queryByLabelText("llmUsage.title")).not.toBeInTheDocument();
    expect(apiMock.getRun).not.toHaveBeenCalled();
  });

  it("does not restore LLM usage as a historical chat message", async () => {
    const completedMessage = {
      message_id: "message-a",
      role: "assistant",
      content: "Persisted complete",
      created_at: "2026-07-22T12:00:00Z",
      linked_attempt_id: "attempt-a",
      metadata: { run_id: "run-a" },
    };
    apiMock.getSessionMessages.mockResolvedValue([completedMessage]);
    apiMock.getRun.mockResolvedValue({ metrics: {}, equity_curve: [], artifacts: [], llm_usage: llmUsage });

    renderAgent();
    await waitFor(() => expect(connectMock).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText("agent.placeholder"), { target: { value: "run it" } });
    fireEvent.keyDown(screen.getByPlaceholderText("agent.placeholder"), { key: "Enter", code: "Enter" });

    await waitFor(() => expect(useAgentStore.getState().messages.some((message) => message.content === "Persisted complete")).toBe(true));
    expect(useAgentStore.getState().messages.some((message) => message.type === "llm_usage")).toBe(false);
  });

  it("keeps the current attempt streaming when an earlier completion fetch resolves", async () => {
    let resolveRun!: (run: Record<string, unknown>) => void;
    apiMock.getRun.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));

    renderAgent();
    await waitFor(() => expect(connectMock).toHaveBeenCalled());

    await act(async () => {
      handlersRef.current["attempt.created"]({ attempt_id: "attempt-a" });
    });

    act(() => {
      void handlersRef.current["attempt.completed"]({
        attempt_id: "attempt-a",
        run_dir: "/runs/run-a",
        summary: "A complete",
      });
    });
    await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledWith("run-a"));

    await act(async () => {
      handlersRef.current["attempt.created"]({ attempt_id: "attempt-b" });
    });

    await act(async () => {
      resolveRun({ metrics: {}, equity_curve: [], artifacts: [], llm_usage: null });
      await Promise.resolve();
    });

    expect(useAgentStore.getState().status).toBe("streaming");
  });

  it("keeps the current attempt streaming when an earlier completion fetch fails", async () => {
    let rejectRun!: (error: Error) => void;
    apiMock.getRun.mockReturnValue(new Promise((_resolve, reject) => { rejectRun = reject; }));

    renderAgent();
    await waitFor(() => expect(connectMock).toHaveBeenCalled());

    await act(async () => {
      handlersRef.current["attempt.created"]({ attempt_id: "attempt-a" });
    });

    act(() => {
      void handlersRef.current["attempt.completed"]({
        attempt_id: "attempt-a",
        run_dir: "/runs/run-a",
        summary: "A complete",
      });
    });
    await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledWith("run-a"));

    await act(async () => {
      handlersRef.current["attempt.created"]({ attempt_id: "attempt-b" });
    });

    await act(async () => {
      rejectRun(new Error("run unavailable"));
      await Promise.resolve();
    });

    expect(useAgentStore.getState().status).toBe("streaming");
  });

  it("continues processing tool calls, assistant text, and completion after llm_usage", async () => {
    apiMock.getRun.mockResolvedValue({ metrics: {}, equity_curve: [], artifacts: [], llm_usage: llmUsage });
    renderAgent();
    await waitFor(() => expect(connectMock).toHaveBeenCalled());

    await act(async () => {
      handlersRef.current["attempt.created"]({ attempt_id: "attempt-a" });
      handlersRef.current.llm_usage({
        iter: 1, provider: "vip_server", model: "hosted", metering_eligible: true,
        input_tokens: 8, output_tokens: 2, total_tokens: 10,
      });
      handlersRef.current.tool_call({ tool: "run_backtest", arguments: {} });
      handlersRef.current.text_delta({ delta: "Assistant response" });
    });

    expect(useAgentStore.getState().toolCalls).toHaveLength(1);
    expect(useAgentStore.getState().streamingText).toBe("Assistant response");

    await act(async () => {
      await handlersRef.current["attempt.completed"]({
        attempt_id: "attempt-a",
        run_dir: "/runs/run-a",
        summary: "Complete",
      });
    });

    expect(useAgentStore.getState().messages.some((message) => message.content === "Complete")).toBe(true);
    expect(useAgentStore.getState().messages.some((message) => message.type === "llm_usage")).toBe(false);
  });

  it("applies a terminal attempt exactly once when polling wins the race with SSE", async () => {
    const completedMessage = {
      message_id: "message-a",
      role: "assistant",
      content: "Persisted complete",
      created_at: "2026-07-22T12:00:00Z",
      linked_attempt_id: "attempt-a",
      metadata: { run_id: "run-a" },
    };
    apiMock.getRun.mockResolvedValue({ metrics: {}, equity_curve: [], artifacts: [], llm_usage: null });

    render(
      <MemoryRouter initialEntries={["/agent?session=session-a"]}>
        <Routes><Route path="/agent" element={<Agent />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(connectMock).toHaveBeenCalled());
    apiMock.getSessionMessages.mockResolvedValue([completedMessage]);

    fireEvent.change(screen.getByPlaceholderText("agent.placeholder"), { target: { value: "run it" } });
    fireEvent.keyDown(screen.getByPlaceholderText("agent.placeholder"), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(
      useAgentStore.getState().messages.filter((message) => message.content === "Persisted complete"),
    ).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      await handlersRef.current["attempt.completed"]({
        attempt_id: "attempt-a",
        run_dir: "/runs/run-a",
        summary: "SSE duplicate",
      });
    });

    expect(useAgentStore.getState().messages.filter((message) => message.content === "SSE duplicate")).toHaveLength(0);
    expect(useAgentStore.getState().messages.filter((message) => message.content === "Persisted complete")).toHaveLength(1);
  });

  it("does not let an old polling refresh overwrite a newly activated attempt", async () => {
    let resolveRun!: (run: Record<string, unknown>) => void;
    const completedMessage = {
      message_id: "message-a",
      role: "assistant",
      content: "Persisted complete",
      created_at: "2026-07-22T12:00:00Z",
      linked_attempt_id: "attempt-a",
      metadata: { run_id: "run-a" },
    };
    apiMock.getRun.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));

    render(
      <MemoryRouter initialEntries={["/agent?session=session-a"]}>
        <Routes><Route path="/agent" element={<Agent />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(connectMock).toHaveBeenCalled());
    apiMock.getSessionMessages.mockResolvedValue([completedMessage]);

    fireEvent.change(screen.getByPlaceholderText("agent.placeholder"), { target: { value: "run it" } });
    fireEvent.keyDown(screen.getByPlaceholderText("agent.placeholder"), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledWith("run-a"));

    act(() => {
      useAgentStore.getState().addMessage({
        id: "message-b",
        type: "user",
        content: "New attempt",
        timestamp: Date.now(),
      });
      useAgentStore.getState().setStatus("streaming");
      handlersRef.current["attempt.created"]({ attempt_id: "attempt-b" });
    });

    await act(async () => {
      resolveRun({ metrics: {}, equity_curve: [], artifacts: [], llm_usage: null });
      await Promise.resolve();
    });

    expect(useAgentStore.getState().messages.some((message) => message.content === "New attempt")).toBe(true);
    expect(useAgentStore.getState().status).toBe("streaming");
  });

  it("shows the VIP model selector only for a logged-in, available VIP service", async () => {
    apiMock.getLLMSettings.mockResolvedValue({
      sse_timeout_seconds: 90,
      desktop_login_provisioned: true,
      desktop_llm_mode: "vip",
      desktop_vip_available: true,
      vip_models: ["vip-fast", "vip-reasoning"],
      model_name: "vip-fast",
    });

    renderAgent();

    const selector = await screen.findByLabelText("agent.vipModel");
    expect(selector).toHaveValue("vip-fast");
    expect(screen.getByRole("option", { name: "vip-reasoning" })).toBeInTheDocument();
  });

  it("does not show the VIP model selector in custom mode", async () => {
    apiMock.getLLMSettings.mockResolvedValue({
      sse_timeout_seconds: 90,
      desktop_login_provisioned: true,
      desktop_llm_mode: "custom",
      desktop_vip_available: false,
      vip_models: ["vip-fast"],
      model_name: "custom-model",
    });

    renderAgent();

    await waitFor(() => expect(apiMock.getLLMSettings).toHaveBeenCalled());
    expect(screen.queryByLabelText("agent.vipModel")).not.toBeInTheDocument();
  });

  it("switches the VIP model through the runtime API and returns focus to the prompt", async () => {
    apiMock.getLLMSettings.mockResolvedValue({
      sse_timeout_seconds: 90,
      desktop_login_provisioned: true,
      desktop_llm_mode: "vip",
      desktop_vip_available: true,
      vip_models: ["vip-fast", "vip-reasoning"],
      model_name: "vip-fast",
    });
    apiMock.updateVIPModel.mockResolvedValue({
      sse_timeout_seconds: 90,
      desktop_login_provisioned: true,
      desktop_llm_mode: "vip",
      desktop_vip_available: true,
      vip_models: ["vip-fast", "vip-reasoning"],
      model_name: "vip-reasoning",
    });

    renderAgent();

    fireEvent.change(await screen.findByLabelText("agent.vipModel"), {
      target: { value: "vip-reasoning" },
    });

    await waitFor(() =>
      expect(apiMock.updateVIPModel).toHaveBeenCalledWith("vip-reasoning"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("agent.vipModel")).toHaveValue("vip-reasoning"),
    );
    expect(screen.getByPlaceholderText("agent.placeholder")).toHaveFocus();
  });

  it("does not start a prompt while a VIP model switch is in flight", async () => {
    let resolveSwitch!: (value: Record<string, unknown>) => void;
    apiMock.getLLMSettings.mockResolvedValue({
      sse_timeout_seconds: 90,
      desktop_login_provisioned: true,
      desktop_llm_mode: "vip",
      desktop_vip_available: true,
      vip_models: ["vip-fast", "vip-reasoning"],
      model_name: "vip-fast",
    });
    apiMock.updateVIPModel.mockReturnValue(new Promise((resolve) => { resolveSwitch = resolve; }));

    renderAgent();

    const prompt = screen.getByPlaceholderText("agent.placeholder");
    fireEvent.change(prompt, { target: { value: "Do not send yet" } });
    fireEvent.change(await screen.findByLabelText("agent.vipModel"), {
      target: { value: "vip-reasoning" },
    });
    await waitFor(() => expect(apiMock.updateVIPModel).toHaveBeenCalledWith("vip-reasoning"));

    expect(prompt).toBeDisabled();
    fireEvent.submit(prompt.closest("form")!);
    expect(apiMock.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      resolveSwitch({
        sse_timeout_seconds: 90,
        desktop_login_provisioned: true,
        desktop_llm_mode: "vip",
        desktop_vip_available: true,
        vip_models: ["vip-fast", "vip-reasoning"],
        model_name: "vip-reasoning",
      });
    });
  });

  it("keeps the prior VIP model and reports a failed switch", async () => {
    apiMock.getLLMSettings.mockResolvedValue({
      sse_timeout_seconds: 90,
      desktop_login_provisioned: true,
      desktop_llm_mode: "vip",
      desktop_vip_available: true,
      vip_models: ["vip-fast", "vip-reasoning"],
      model_name: "vip-fast",
    });
    apiMock.updateVIPModel.mockRejectedValue(new Error("switch failed"));

    renderAgent();

    fireEvent.change(await screen.findByLabelText("agent.vipModel"), {
      target: { value: "vip-reasoning" },
    });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("switch failed"));
    expect(screen.getByLabelText("agent.vipModel")).toHaveValue("vip-fast");
    await waitFor(() =>
      expect(screen.getByPlaceholderText("agent.placeholder")).not.toBeDisabled(),
    );
    expect(screen.getByPlaceholderText("agent.placeholder")).toHaveFocus();
  });
});
