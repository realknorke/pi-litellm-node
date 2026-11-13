/**
 * LiteLLM Node Status — shows the backend host (e.g. `node-a`) that served the
 * latest request, read from LiteLLM's `x-litellm-model-api-base` response header,
 * plus a red `*not sticky*` warning when session affinity is not in effect.
 *
 * Stickiness source: the response headers do NOT carry the session id (verified:
 * header sets with and without `x-session-id` are identical, and LiteLLM has no
 * affinity response header). Pi also adds its affinity header inside the provider
 * client, i.e. after `before_provider_headers` has run, so the outgoing headers
 * cannot be inspected either. What remains is the decision Pi itself makes, per
 * API and `compat` flags. Headers an extension explicitly adds or deletes are
 * honoured as an override, including `null` (delete) and invalid values.
 *
 * The extension stays invisible until a response proves it is talking to a LiteLLM
 * gateway (`x-litellm-*` header). That keeps it harmless on other providers and
 * avoids claiming "not sticky" before the first request has been observed.
 *
 * Placement: in the TUI the built-in footer is wrapped; the text is spliced in
 * right-aligned one line above the stats line (above the model name). `setStatus`
 * cannot do that (its entries always become the last footer line). In RPC mode
 * `setFooter()` is a no-op, so there the value goes through `setStatus`.
 *
 * No caching by design: a new session and a model switch start empty.
 */
import { FooterComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY = "node";
const MARKER = "*not sticky*";
/** Precaution only: no backend host is anywhere near this long. */
const MAX_HOSTNAME = 30;
/** LiteLLM's get_chain_id_from_headers(): required value shape. */
const SESSION_ID_VALUE = /^[A-Za-z0-9_-]{8,}$/;

type Headers = Record<string, string | null | undefined>;
/** `undefined` = not observed yet, `true` = session id reaches LiteLLM. */
type Sticky = boolean | undefined;

/** Header names LiteLLM's get_chain_id_from_headers() actually reads. */
function isAffinityHeader(name: string): boolean {
	const key = name.toLowerCase();
	return (
		key === "x-session-id" ||
		key === "session-id" ||
		key === "thread-id" ||
		key === "x-litellm-session-id" ||
		key === "x-litellm-trace-id" ||
		key.endsWith("-session-id")
	);
}

/**
 * What an extension did to the affinity headers, independent of Pi's own defaults:
 * `present` (valid id added), `removed` (deleted via null or set to an invalid
 * value), or `undefined` (untouched — Pi's compat decides).
 */
export function affinityHeaderState(headers: Headers | null | undefined): "present" | "removed" | undefined {
	let removed = false;
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (!isAffinityHeader(name)) continue;
		if (typeof value === "string" && SESSION_ID_VALUE.test(value)) return "present";
		removed = true;
	}
	return removed ? "removed" : undefined;
}

/**
 * Session id carried in the request body instead of a header. LiteLLM's affinity
 * check reads `metadata.session_id` (or `litellm_metadata.session_id`) too, so a
 * `before_provider_request` hook can deliver stickiness without the compat flags.
 */
export function payloadSessionId(payload: unknown): string | undefined {
	const body = payload as
		| { metadata?: Record<string, unknown>; litellm_metadata?: Record<string, unknown> }
		| undefined;
	for (const meta of [body?.metadata, body?.litellm_metadata]) {
		const value = meta?.session_id;
		if (typeof value === "string" && SESSION_ID_VALUE.test(value)) return value;
	}
	return undefined;
}

/**
 * Does Pi send a session id LiteLLM reads, for this model? Mirrors Pi's own
 * per-API compat resolution; `undefined` means the API is not modelled here, so
 * nothing is claimed either way.
 */
export function sendsSessionId(model: { provider?: string; baseUrl?: string; api?: string; compat?: unknown } | undefined): Sticky {
	if (!model) return undefined;
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	const openRouter = model.provider === "openrouter" || (model.baseUrl ?? "").includes("openrouter.ai");
	const format = compat.sessionAffinityFormat ?? (openRouter ? "openrouter" : "openai");
	// Only the openrouter format emits `x-session-id`, the one name LiteLLM reads.
	if (format !== "openrouter") return false;
	switch (model.api) {
		case "openai-completions": {
			const enabled =
				compat.sendSessionAffinityHeaders === undefined ? openRouter : compat.sendSessionAffinityHeaders === true;
			return enabled;
		}
		case "openai-responses":
			// This API has no sendSessionAffinityHeaders gate (pi-ai 1.5.0).
			return true;
		default:
			return undefined;
	}
}

/**
 * What the footer line should say, or `undefined` for "no line at all".
 *
 * The warning needs proof: only `sticky === false` produces it, and only once a
 * response proved this is a LiteLLM gateway. A fresh session, a model switch and
 * a non-LiteLLM provider stay completely invisible.
 */
export function statusText(
	node: string | undefined,
	sticky: Sticky,
	litellm: boolean | undefined,
	marker: string = MARKER,
): string | undefined {
	if (litellm !== true) return undefined;
	if (sticky === false) return node ? `${marker} ${node}` : marker;
	// sticky true or unknown: the node is a fact, the warning is not
	return node;
}

export function hostnameOf(apiBase: unknown): string | undefined {
	if (typeof apiBase !== "string") return undefined;
	const trimmed = apiBase.trim();
	if (!trimmed) return undefined;
	let host: string;
	try {
		host = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname;
	} catch {
		return undefined;
	}
	const label = host.split(".")[0].slice(0, MAX_HOSTNAME);
	return label || undefined;
}

/** Insert a right-aligned line above the footer's stats line. */
export function nodeLine(lines: string[], width: number, text: string | undefined): string[] {
	if (!text) return lines;
	const pad = width - visibleWidth(text);
	const line = pad > 0 ? " ".repeat(pad) + text : truncateToWidth(text, width, "");
	const out = lines.slice();
	out.splice(Math.min(1, out.length), 0, line);
	return out;
}

/**
 * FooterComponent expects an AgentSession and calls
 * `session.modelRuntime.isUsingSubscription(provider)`, but `ctx.modelRegistry`
 * is a ModelRegistry without that method. This adapter reproduces
 * ModelRuntime.isUsingSubscription from public registry methods.
 */
function runtimeAdapter(ctx: ExtensionContext): { isUsingSubscription(providerId: string): boolean } {
	return {
		isUsingSubscription(providerId: string): boolean {
			try {
				const registry = ctx.modelRegistry as unknown as {
					isUsingSubscription?: (id: string) => boolean;
					isUsingOAuth?: (model: unknown) => boolean;
					getProvider?: (id: string) => { auth?: { oauth?: { isSubscription?: boolean } } } | undefined;
				};
				if (typeof registry?.isUsingSubscription === "function") return registry.isUsingSubscription(providerId);
				const model = ctx.model;
				const oauth = typeof registry?.isUsingOAuth === "function" && model ? registry.isUsingOAuth(model) : false;
				return oauth && registry?.getProvider?.(providerId)?.auth?.oauth?.isSubscription === true;
			} catch {
				return false;
			}
		},
	};
}

/** Last-resort footer content if the wrapped component ever fails to render. */
function fallbackLines(ctx: ExtensionContext, width: number): string[] {
	try {
		const cwd = ctx.sessionManager.getCwd();
		const id = ctx.model?.id;
		return [truncateToWidth(id ? `${cwd}  ${id}` : cwd, width, "...")];
	} catch {
		return [];
	}
}

export default function (pi: ExtensionAPI) {
	let node: string | undefined;
	let sticky: Sticky;
	let litellm: boolean | undefined;
	/** Bumped whenever observed state is invalidated; drops responses from before. */
	let generation = 0;
	let requestGeneration = -1;
	let requestRender: (() => void) | undefined;
	let useStatus = false;
	let compaction = { at: 0, enabled: true };

	const compactionEnabled = (): boolean => {
		const now = Date.now();
		if (now - compaction.at > 1000) {
			let enabled = true;
			try {
				enabled = pi.getSettings().compaction?.enabled ?? true;
			} catch {
				// extension runtime not active; keep the last value
			}
			compaction = { at: now, enabled };
		}
		return compaction.enabled;
	};

	const publish = (ctx: ExtensionContext): void => {
		if (ctx.mode === "rpc" || useStatus) {
			ctx.ui.setStatus(STATUS_KEY, statusText(node, sticky, litellm));
			return;
		}
		requestRender?.();
	};

	const reset = (): void => {
		node = undefined;
		sticky = undefined;
		litellm = undefined;
		generation += 1;
	};

	const installFooter = (ctx: ExtensionContext): void => {
		try {
			ctx.ui.setFooter((tui, theme, footerData) => {
				requestRender = () => tui.requestRender();
				const marker = (() => {
					try {
						return theme.fg("error", MARKER);
					} catch {
						return MARKER;
					}
				})();
				const session = {
					get sessionManager() {
						return ctx.sessionManager;
					},
					get model() {
						return ctx.model;
					},
					get state() {
						return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
					},
					// Virtual-model routing is not exposed to extensions; the stock
					// footer's "→ routed model" suffix is therefore not reproduced.
					get routedModel() {
						return undefined;
					},
					get modelRuntime() {
						return runtimeAdapter(ctx);
					},
					getContextUsage: () => ctx.getContextUsage(),
				};
				const inner = new FooterComponent(session as never, footerData);
				return {
					render(width: number) {
						try {
							inner.setAutoCompactEnabled(compactionEnabled());
							return nodeLine(inner.render(width), width, statusText(node, sticky, litellm, marker));
						} catch {
							// an internal API change must not cost the user the whole footer
							return nodeLine(fallbackLines(ctx, width), width, statusText(node, sticky, litellm));
						}
					},
					invalidate() {
						try {
							inner.invalidate();
						} catch {
							// ignore
						}
					},
					dispose() {
						try {
							inner.dispose();
						} catch {
							// ignore
						}
					},
				};
			});
		} catch {
			// Wrapping failed: restore Pi's footer and fall back to a status entry.
			useStatus = true;
			try {
				ctx.ui.setFooter(undefined);
			} catch {
				// ignore
			}
			publish(ctx);
		}
	};

	// `before_provider_headers` runs before Pi adds its own affinity header, so it
	// only reports overrides by other extensions; everything else is inferred from
	// the model's compat flags, exactly as Pi does.
	pi.on("before_provider_headers", (event, ctx) => {
		if (!ctx.hasUI) return;
		requestGeneration = generation;
		const override = affinityHeaderState(event?.headers);
		sticky = override === "present" ? true : override === "removed" ? false : sendsSessionId(ctx.model);
		publish(ctx);
	});

	// A body-level session id counts as well: LiteLLM reads metadata.session_id.
	pi.on("before_provider_request", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!payloadSessionId(event?.payload)) return;
		sticky = true;
		publish(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!ctx.hasUI) return;
		// A response from before a session/model reset must not repopulate state.
		if (requestGeneration !== generation) return;
		const headers = (event?.headers ?? {}) as Headers;
		node = hostnameOf(headers["x-litellm-model-api-base"]);
		litellm = Object.keys(headers).some((name) => name.startsWith("x-litellm-"));
		publish(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ctx.hasUI) return;
		reset();
		publish(ctx);
	});

	// No caching: a fresh session shows nothing until its first request has been seen.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		reset();
		if (ctx.mode === "rpc") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		installFooter(ctx);
	});
}
