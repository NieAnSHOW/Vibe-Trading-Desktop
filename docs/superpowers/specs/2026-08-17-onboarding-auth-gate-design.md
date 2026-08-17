# Onboarding Authentication Gate Design

## Goal

Make desktop startup follow the required sequence: environment check, optional authentication check, service startup, then research. Login must return the user to onboarding so the normal startup flow resumes.

## Current Context

`OnboardingPage.vue` already refreshes the environment and handles repair/bootstrap events. `LoginPage.vue` already stores successful login state and replaces the route with `/`. The auth store's `refresh()` method is the existing Rust-backed session check, and `config.enableLogin` is loaded at application startup.

## Design

Onboarding owns the startup gate:

1. Register existing bootstrap/service/quit event listeners.
2. Refresh the environment.
3. If the environment is not `ready`, stop here and keep the repair UI available. Authentication is not queried while the environment is unavailable.
4. If `config.enableLogin` is `true`, refresh the auth store. If the result is unauthenticated, replace the route with `/login` and do not start the service.
5. If login is disabled or the user is authenticated, start the research service when it is not already running. `service.start()` remains responsible for opening the embedded WebUI.

The successful bootstrap-exit path uses the same gate before starting the service. Returning from `LoginPage` to `/` remounts `OnboardingPage`, which observes the authenticated store state and proceeds with service startup.

## Error Handling

Auth refresh failures use the existing auth store behavior, which clears the session. The onboarding flow treats that as signed out and routes to `/login`. Existing environment/bootstrap errors remain unchanged.

## Testing

Add focused Onboarding tests for:

- ready environment plus signed-out user redirects to `/login` and does not start the service;
- ready environment plus authenticated user starts the service;
- `enableLogin: false` skips auth refresh and starts the service;
- incomplete environment shows repair UI and does not query auth;
- successful bootstrap starts the service only after the same authentication gate.

Existing LoginPage tests continue to verify that successful login returns to `/`.
