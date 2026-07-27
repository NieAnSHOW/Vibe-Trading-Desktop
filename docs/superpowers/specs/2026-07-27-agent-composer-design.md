# Agent Composer Integration

## Goal

Make the Agent prompt composer a single, cohesive input surface inspired by the
Codex desktop composer. The prompt field and its controls share one bounded
container instead of appearing as a detached toolbar and text field.

## Layout

- The composer remains pinned below the conversation and is constrained to the
  current `max-w-3xl` reading width.
- A single rounded, bordered surface contains the multiline textarea and a
  bottom action row. The textarea expands up to its existing maximum height.
- The action row is split into three areas:
  - Left: the existing `+` menu, which continues to expose uploads, research
    goals, swarm mode, and connector shortcuts.
  - Middle: the existing VIP model selector when its current eligibility
    condition is true.
  - Right: export when conversation history exists, then a circular send or
    stop action.
- Attachment, swarm, and new-goal selections are rendered as dismissible
  compact chips inside the composer, above the textarea. Existing active-goal
  details, runner status, and live safety controls stay outside the composer
  because they are persistent operational status rather than prompt controls.

## Behavior

- Keep the existing submission, IME handling, upload flow, keyboard shortcut,
  goal creation, swarm prompt transformation, streaming cancellation, and
  export behavior unchanged.
- Preserve the VIP selector's current visibility condition, update request,
  loading state, and input refocus after a selection changes.
- Disabled controls preserve their current streaming, upload, and model-switch
  constraints. The send action remains disabled unless the existing prompt or
  attachment requirements are met.
- On narrow layouts, the action row wraps without overlapping the textarea;
  the send/stop action keeps a fixed square size.

## Visual Treatment

- Reuse the application's existing background, muted, border, primary, and
  destructive tokens. Do not add a new color system.
- Use a focused border/ring for the input surface, compact 36px icon controls,
  and a 40px circular primary or destructive action button.
- Use short opacity and color transitions only for interaction feedback.

## Verification

- Run the focused Agent page tests and the frontend production build.
- Manually inspect the composer at desktop and narrow viewport widths to check
  that controls remain visible and the model selector is not clipped.
