# Console Motion Design

## Scope

Add restrained motion to the Tauri console client so first launch and route changes do not appear abrupt. The change covers the console application's root route outlet and `ConsolePage` only. It does not change data loading, service lifecycle, routing rules, or interaction behavior.

## Route Transitions

`App.vue` will wrap `router-view` in a Vue transition that runs for every route change. The entering page will fade in while moving upward by a small fixed distance. The leaving page will fade out and move downward by the same distance. The transition remains in `out-in` mode so pages do not overlap or compete for focus during navigation.

## Console Startup

`ConsolePage.vue` will use a local mounted flag. Before it is set, the page keeps its final layout; once mounted, the header and content shell will enter with short, staggered fade-and-rise animations. The motion will not delay API calls, event listeners, polling, controls, or any service operation.

## Accessibility And Reliability

The existing `prefers-reduced-motion: reduce` rule remains authoritative and collapses animations to effectively immediate. Motion only uses `opacity` and `transform`, avoiding layout shifts. Transition classes are scoped so other pages and components cannot accidentally inherit them.

## Verification

Run the console application's TypeScript/Vite production build and the focused `ConsolePage` test suite. Confirm that the new transition wrapper does not affect route rendering or existing action handlers.
