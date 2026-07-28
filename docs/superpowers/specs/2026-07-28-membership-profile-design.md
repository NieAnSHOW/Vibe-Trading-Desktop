# Membership Profile and Benefits

## Goal

Make the signed-in account identity in the desktop console a clear entry point
to a profile page. The page presents the current membership benefits supplied
by the Cool Admin server and is the only place where a user can sign out.

## Scope

- Add an authenticated, read-only app-facing endpoint in Cool Admin's AI
  module. It returns the benefits available to the current user, resolved from
  the existing membership data model.
- Add a Tauri command that fetches that endpoint using the existing desktop
  login session, plus matching TypeScript IPC types and command wrapper.
- Add a `/profile` route and a `ProfilePage.vue` page in the desktop console.
- Make the signed-in identity block in `ConsolePage.vue` keyboard-accessible
  and route it to `/profile`.
- Move the existing sign-out confirmation and service-restart behavior from
  the console page to the profile page.

## UI and Behavior

The console account entry shows the account name and membership tier. It is a
single clickable control with a concise accessible label. It uses neutral,
low-contrast styling for ordinary memberships. Recognized elevated tiers use
stable, distinct tones: Pro uses blue, higher VIP/Elite/Ultimate tiers use
gold, and any other named paid tier uses teal. The displayed tier remains
derived from the server profile; the color is presentation only.

The profile page includes a back action to the console, account identity,
membership tier, and expiration when supplied by the profile. Its main content
is a benefits list populated only by the new server response. It does not
repeat the console's points-usage information. Loading, empty, and request
failure states are explicit. A retry action is available after a failed
request. The sign-out action is at the bottom of the page and preserves the
existing confirmation copy, credential clearing, and service restart flow.

## Data Contract

The server endpoint is authenticated with the existing app login token and
returns a minimal envelope containing the current membership benefits as
display-ready items. Each item has a stable identifier, a title, and optional
description. The Cool Admin implementation owns membership eligibility and
ordering. The desktop application does not infer benefits from member-level
codes.

## Failure Handling

- An expired login clears the desktop authentication state and returns the
  user to the console's signed-out state.
- Other benefit-request failures do not affect console controls or the cached
  account profile; the profile page reports the failure and allows retry.
- An empty successful result displays an empty state rather than a fabricated
  benefit.

## Verification

Keep automated testing narrow:

- Cover the Cool Admin endpoint's authentication and current-user benefit
  resolution using the server's focused test conventions.
- Cover Rust parsing/error mapping and Tauri command behavior where unit-test
  seams already exist.
- Cover the critical console-to-profile route and sign-out placement with
  focused Vue tests.

Visual layout and end-to-end WebUI interaction are intentionally left for
manual verification. No broad snapshot suite, coverage gate, or full desktop
end-to-end run is required for this change.
