# Desktop Console Full-Width Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Rail-adjacent native console route occupy the same viewport canvas as the embedded WebUI iframe.

**Architecture:** `App.vue` determines whether the retained shell currently has a Rail and expresses that state with a modifier class. `console.css` owns the viewport geometry and removes the former global body centering; existing page roots use fluid widths so their internal layouts can consume the shell canvas.

**Tech Stack:** Vue 3, TypeScript, Vitest, Vue Test Utils, CSS custom properties.

## Global Constraints

- Rail-present routes must start at `var(--rail-width)` and use `calc(100vw - var(--rail-width))`.
- Onboarding and login without a visible Rail must occupy `100vw`.
- Keep the iframe geometry, theme bridge, IPC behavior, and 220ms/reduced-motion transitions unchanged.
- Use existing Trading Worker-compatible semantic tokens; do not add gradients, decorative panels, or a second navigation surface.
- Do not alter live-trading or sidecar behavior.

---

### Task 1: Define the Rail-aware shell contract

**Files:**
- Modify: `src-tauri/console-app/src/App.vue:14-16,140-143,183-208`
- Modify: `src-tauri/console-app/src/__tests__/App.test.ts:70-118`

**Interfaces:**
- Consumes: `isStandaloneSurface: ComputedRef<boolean>` and `webuiVisible: Ref<boolean>` already declared in `App.vue`.
- Produces: `hasRail: ComputedRef<boolean>` and the `shell-content--rail` class for CSS geometry.

- [ ] **Step 1: Write the failing shell-class tests**

  In `src-tauri/console-app/src/__tests__/App.test.ts`, extend the existing onboarding, login, and WebUI tests with these assertions:

  ```ts
  expect(content.classes()).not.toContain("shell-content--rail");

  openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
  await flushPromises();
  expect(wrapper.get('[data-test="shell-content"]').classes()).toContain("shell-content--rail");
  ```

  Add a non-standalone route assertion:

  ```ts
  await router.push("/next");
  const wrapper = mount(App, { global: { plugins: [router, createPinia()] } });
  expect(wrapper.get('[data-test="shell-content"]').classes()).toContain("shell-content--rail");
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```bash
  cd src-tauri/console-app && npm test -- App.test.ts
  ```

  Expected: the new assertions fail because `shell-content--rail` does not yet exist.

- [ ] **Step 3: Add the explicit Rail-presence computed value and class**

  In `src-tauri/console-app/src/App.vue`, add the state immediately after `isStandaloneSurface`:

  ```ts
  const hasRail = computed(() => !isStandaloneSurface.value || webuiVisible.value);
  ```

  Replace the shell's current class binding with:

  ```vue
  :class="{
    'shell-content--onboarding': isOnboarding,
    'shell-content--standalone': isStandaloneSurface,
    'shell-content--rail': hasRail,
  }"
  ```

  This treats a visible WebUI opened from a standalone route as Rail-present,
  exactly matching the `Rail` component's existing `v-if` condition.

- [ ] **Step 4: Run the focused tests and verify they pass**

  Run:

  ```bash
  cd src-tauri/console-app && npm test -- App.test.ts
  ```

  Expected: all `App` tests pass.

- [ ] **Step 5: Commit the tested shell-state change**

  ```bash
  git add src-tauri/console-app/src/App.vue src-tauri/console-app/src/__tests__/App.test.ts
  git commit -s -m "feat: mark rail-aware console shells"
  ```

### Task 2: Make the native canvas match the iframe canvas

**Files:**
- Modify: `src-tauri/console-app/src/styles/console.css:44-90,790-842`
- Modify: `src-tauri/console-app/src/__tests__/App.test.ts:57-68`

**Interfaces:**
- Consumes: `shell-content--rail` emitted by Task 1 and `--rail-width` defined in `console.css`.
- Produces: a fluid Rail-aware native canvas, a full-width standalone canvas, and neutral document-level layout defaults.

- [ ] **Step 1: Write the failing CSS contract test**

  In `src-tauri/console-app/src/__tests__/App.test.ts`, add a source-level contract test:

  ```ts
  it("uses the iframe's available viewport width for Rail-aware console content", () => {
    expect(consoleStyles).toContain(".shell-content--rail");
    expect(consoleStyles).toContain("width: calc(100vw - var(--rail-width));");
    expect(consoleStyles).toContain("margin-left: var(--rail-width);");
    expect(consoleStyles).toContain("min-height: 100dvh;");
  });
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```bash
  cd src-tauri/console-app && npm test -- App.test.ts
  ```

  Expected: the CSS contract test fails because the Rail-aware selector is absent.

- [ ] **Step 3: Move viewport geometry from `body` to `.shell-content`**

  In `src-tauri/console-app/src/styles/console.css`, make the document root neutral and define the shell geometry:

  ```css
  body {
    min-width: 0;
    min-height: 100dvh;
    display: block;
    padding: 0;
  }

  #app,
  .shell-content {
    width: 100%;
    min-width: 0;
    min-height: 100dvh;
  }

  .shell-content--rail {
    width: calc(100vw - var(--rail-width));
    margin-left: var(--rail-width);
  }

  .shell-content--standalone {
    width: 100vw;
    margin-left: 0;
  }

  .shell-content--standalone.shell-content--rail {
    width: calc(100vw - var(--rail-width));
    margin-left: var(--rail-width);
  }
  ```

  Remove the preceding `body` `display:flex`, `justify-content:center`, and
  Rail-compensating padding declarations, plus the later duplicate `body`
  padding override. Retain the existing transition and standalone page rules.

- [ ] **Step 4: Run the focused tests and verify they pass**

  Run:

  ```bash
  cd src-tauri/console-app && npm test -- App.test.ts
  ```

  Expected: all `App` tests pass, including the viewport contract test.

- [ ] **Step 5: Commit the tested canvas contract**

  ```bash
  git add src-tauri/console-app/src/styles/console.css src-tauri/console-app/src/__tests__/App.test.ts
  git commit -s -m "style: align console canvas with webui frame"
  ```

### Task 3: Remove fixed-width blockers from Rail-adjacent pages

**Files:**
- Modify: `src-tauri/console-app/src/styles/console.css:90-95,228-231`
- Modify: `src-tauri/console-app/src/pages/SettingsPage.vue:419-423`
- Modify: `src-tauri/console-app/src/__tests__/App.test.ts:57-68`

**Interfaces:**
- Consumes: fluid `.shell-content--rail` geometry from Task 2.
- Produces: `.console`, `.profile`, and `.settings` roots that can fill the native canvas while retaining `min-width: 0` for responsive children.

- [ ] **Step 1: Write the failing fixed-width regression test**

  Add this source contract test to `src-tauri/console-app/src/__tests__/App.test.ts`:

  ```ts
  it("keeps native console page roots fluid inside the Rail-aware canvas", () => {
    expect(consoleStyles).toMatch(/\.console\s*\{[\s\S]*width: 100%;/);
    expect(consoleStyles).toMatch(/\.profile\s*\{[\s\S]*width: 100%;/);
    expect(readFileSync(resolve(process.cwd(), "src/pages/SettingsPage.vue"), "utf8"))
      .toMatch(/\.settings\s*\{[\s\S]*width: 100%;/);
  });
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```bash
  cd src-tauri/console-app && npm test -- App.test.ts
  ```

  Expected: the test fails while the roots still set `width: 580px`.

- [ ] **Step 3: Replace fixed roots with fluid roots**

  Apply these declarations in the existing selectors:

  ```css
  .console,
  .profile {
    position: relative;
    z-index: 1;
    width: 100%;
    min-width: 0;
  }
  ```

  In `src-tauri/console-app/src/pages/SettingsPage.vue`, use:

  ```css
  .settings {
    position: relative;
    z-index: 1;
    width: 100%;
    min-width: 0;
  }
  ```

  Preserve all cards, content-grid constraints, and page-local responsive
  rules so data and form controls retain readable line lengths.

- [ ] **Step 4: Run the focused tests and verify they pass**

  Run:

  ```bash
  cd src-tauri/console-app && npm test -- App.test.ts
  ```

  Expected: all `App` tests pass.

- [ ] **Step 5: Run the complete console verification**

  Run:

  ```bash
  cd src-tauri/console-app && npm test && npm run build
  ```

  Expected: Vitest passes and `vue-tsc --noEmit && vite build` exits 0.

- [ ] **Step 6: Commit the fluid page roots**

  ```bash
  git add src-tauri/console-app/src/styles/console.css src-tauri/console-app/src/pages/SettingsPage.vue src-tauri/console-app/src/__tests__/App.test.ts
  git commit -s -m "style: make native console pages fluid"
  ```
