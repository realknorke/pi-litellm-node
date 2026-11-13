# Coding agent guide

This repository is a [Pi](https://pi.dev) extension for a LiteLLM gateway.
It displays the backend host of the last request in the footer, with a red
`*not sticky*` warning when session affinity is off. License: GPL-3.0-only.

## Layout

- `extensions/litellm-node.ts`: the single extension file and its pure helpers.
- `package.json`: package metadata, Pi peer dependencies, and the `pi.extensions` manifest.
- `README.md`: installation, affinity configuration, behavior, and limitations.

## Invariants

- Stay invisible until a response proves a LiteLLM gateway via any `x-litellm-*` header.
- Show the warning only when `sticky === false`; unknown affinity is not false.
- Show nothing on a fresh session or before its first response.
- Never cache observed node, affinity, or gateway state across sessions or model switches.
  Preserve generation checks so stale responses cannot repopulate reset state.
- Read the backend host from `x-litellm-model-api-base`; a missing host clears the node.
  A proven LiteLLM response may still show the bare warning when affinity is false.
- In the TUI, wrap `FooterComponent` and insert the line right-aligned directly above
  the stats line. Ordinary status entries cannot provide this placement.
- RPC falls back to `ctx.ui.setStatus` with plain text; print/json remain silent.
- Affinity detection indicates whether a session ID is sent, not whether the gateway
  actually pins the deployment.

## Pi API dependencies

- `ctx.modelRegistry` is a `ModelRegistry`, not a `ModelRuntime`; it has no
  `isUsingSubscription` method. Preserve `runtimeAdapter`, which supplies the
  interface required by `FooterComponent` using public registry methods.
- `before_provider_headers` runs BEFORE Pi adds its own session-affinity header.
  It only observes overrides by other extensions. Otherwise, infer affinity from
  the model API and compatibility flags through `sendsSessionId`.
- LiteLLM also accepts a body-level `metadata.session_id`; `payloadSessionId`
  checks it in `before_provider_request` and counts it as sticky.

## Verification

There is no test suite or package test script. Maintainers use a throwaway harness
against the installed Pi to verify `affinityHeaderState`, `sendsSessionId`,
`statusText`, `hostnameOf`, `nodeLine`, and the footer wrapper. Use a fake
`ExtensionContext` whose `modelRegistry` has the shape of a `ModelRegistry`,
without inventing `ModelRuntime.isUsingSubscription` on it. Check fresh sessions,
model switches, gateway detection, affinity states, and footer placement/modes.
The README records verification against Pi 1.5.0; recheck wrapper compatibility
with the installed Pi rather than assuming its internal session shape is stable.
