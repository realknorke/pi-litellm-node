# pi-litellm-node

A [Pi](https://pi.dev) extension for a LiteLLM gateway: shows **which backend node
served the last request** in the footer, and warns in red when **session affinity
is off** (which costs you the prefix cache).

```
~/code/project (main)
                                          node-a
↑17k ↓153 R16k CH87.9% 1.7%/1.0M (auto)   lb:DeepSeek-V4.1-Flash • xhigh
```

Not sticky: `*not sticky* node-a`.

## Install

```bash
pi install git:github.com/realknorke/pi-litellm-node
```

Or drop `extensions/litellm-node.ts` into `~/.pi/agent/extensions/` and run `/reload`.

## What is session stickiness?

LiteLLM's `session_affinity` pre-call check pins a session to one deployment of a
model group. The pin is keyed by model group, hashed caller API key and session id,
and lives in Redis for `deployment_affinity_ttl_seconds` (default 3600 s). Requests
without a session id are left unpinned.

## Why turn it on?

vLLM's prefix cache (KV blocks) lives on each node, in GPU memory, and is not
shared between independent instances. Switching to a backend that does not hold the
prefix costs recomputation and raises TTFT; `cached_tokens` only grows where blocks
are still resident. Stickiness keeps a session on the node that already holds them.

## Enable it

**Pi** (`~/.pi/agent/models.json`, provider or model level):

```json
"compat": { "sendSessionAffinityHeaders": true, "sessionAffinityFormat": "openrouter" }
```

Pi then sends `x-session-id: <pi session id>` (constant per session) while prompt
caching is enabled — with `cacheRetention: "none"` Pi drops the session id again.
Only the `openrouter` format emits that header; the `openai` formats send
`session_id` / `x-client-request-id` / `x-session-affinity` (the Responses API omits
`x-session-affinity`, `openai-nosession` omits `session_id`), all of which LiteLLM
ignores. `prompt_cache_key` is a separate mechanism, not LiteLLM affinity; whether Pi
sends it depends on the API and the cache retention.

**Gateway** (`config.yaml`, then restart — it is read at `Router.__init__`):

```yaml
router_settings:
  redis_host: redis                     # pins must be shared across workers
  redis_port: 6379                      # host and port, or a redis_url
  deployment_affinity_ttl_seconds: 600
  model_group_affinity_config:
    <your-model-group>: ["session_affinity"]
```

## Behavior

| Situation | Footer |
|---|---|
| not a LiteLLM response (other provider, fresh session) | nothing |
| LiteLLM, sticky | node |
| LiteLLM, not sticky | `*not sticky*` + node |
| LiteLLM, error response without `api_base` | node line disappears; a known "not sticky" stays as the bare marker |

Nothing is cached: a new session and `/model` start empty. The node is cut at 30
chars. In RPC mode the value goes through `setStatus` (plain text); print/json show
nothing.

## Limits

- "Sent" is not "pinned": the extension checks that Pi sends a session id, not that
  the proxy's `model_group_affinity_config` actually pins the deployment.
- The warning is deliberately invisible until a response proves it is a LiteLLM
  gateway (`x-litellm-*` header), so the extension is harmless on other providers.
- Virtual-model routing is not exposed to extensions, so the stock footer's
  "→ routed model" suffix is not reproduced while this footer is installed.
- Tested against Pi 1.5.0. The footer wrapper relies on the exported
  `FooterComponent` and the `AgentSession` shape it consumes; on an incompatible
  version it falls back to a minimal footer or to `setStatus`.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
