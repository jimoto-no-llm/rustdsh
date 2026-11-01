/**
 * rdsh-web-search-searxng: pin the delegated DSH web_search to a local
 * SearXNG-compatible engine (rustxng or a user-pinned SearXNG instance).
 *
 * rdsh injects two environment variables into the delegated DSH process when
 * the web_search_bridge feature is on and a local engine actually answers:
 *
 * - DSH_WEB_SEARCH_PROVIDER=rdsh-rustxng pins the ctx.web search provider id,
 *   so the deepseek-official provider stops being selected (selection without
 *   a pin would be ambiguous once two usable providers are up).
 * - RDSH_SEARXNG_URL names the endpoint (already health-checked by rdsh).
 *
 * Registration is env-gated: without the pin this plugin mounts nothing, so an
 * old rdsh or an explicit upstream searchProvider choice keeps working. The
 * endpoint itself is not contacted at registration time; a search that cannot
 * complete fails loud (never falling back to DeepSeek mid-search), which is
 * the same contract dsh-web-search-deepseek follows.
 *
 * Result mapping covers rustxng's JSON (and SearXNG's optional format=json).
 * SearXNG instances with the JSON API disabled fall back to a conservative
 * parse of the HTML results page, mirroring the Rust client in
 * src/websearch.rs.
 */

export const name = 'rdsh-web-search-searxng';

/** Provider id pinned through DSH_WEB_SEARCH_PROVIDER by the rdsh boot. */
export const PROVIDER_ID = 'rdsh-rustxng';

/** Endpoint used when neither override names one. */
export const DEFAULT_BASE = 'http://127.0.0.1:8888';

/**
 * True when this plugin should mount the search provider. The pin is the one
 * truth: mounting without it would make provider selection ambiguous in a
 * composition where deepseek-official is also registered.
 */
export function shouldBridge(env) {
	return String(env?.DSH_WEB_SEARCH_PROVIDER ?? '') === PROVIDER_ID;
}

/**
 * Resolve the search base from the patch config over the injected value.
 *
 * The URL is an operator-selected endpoint, not something a response can
 * choose, so control characters, whitespace, userinfo, queries and fragments
 * are refused here as the Rust client refuses them.
 */
export function resolveBase(env, config = {}) {
	const candidate = config.baseURL ?? env?.RDSH_SEARXNG_URL ?? env?.SEARXNG_URL ?? DEFAULT_BASE;
	if (typeof candidate !== 'string') return undefined;
	// Trim the value once; the trailing-slash strip is a linear indexed walk
	// instead of a regex (env input must not feed a polynomial pattern).
	let value = candidate.trim().length === 0 ? '' : candidate.trim();
	while (value.endsWith('/')) value = value.slice(0, -1);
	if (
		value.length === 0
		|| !value.startsWith('http://')
		|| /[\u0000-\u0020]/.test(value)
		|| value.includes('@')
		|| value.includes('?')
		|| value.includes('#')
	) {
		return undefined;
	}
	return value;
}

/** Encode one query the way encode_query in src/websearch.rs does. */
export function encodeQuery(query) {
	let out = '';
	for (const byte of Buffer.from(String(query), 'utf8')) {
		if (
			(byte >= 0x41 && byte <= 0x5a)
			|| (byte >= 0x61 && byte <= 0x7a)
			|| (byte >= 0x30 && byte <= 0x39)
			|| byte === 0x2d
			|| byte === 0x5f
			|| byte === 0x2e
			|| byte === 0x7e
		) {
			out += String.fromCharCode(byte);
		} else if (byte === 0x20) {
			out += '+';
		} else {
			out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
		}
	}
	return out;
}

/**
 * Map one SearXNG/rustxng JSON hit to the ctx.web source shape.
 * Empty URLs are dropped, mirroring the native client.
 */
export function sourceFromJson(result) {
	if (result === null || typeof result !== 'object') return undefined;
	const url = typeof result.url === 'string' ? result.url : '';
	if (url.length === 0) return undefined;
	const title = typeof result.title === 'string' ? result.title : '';
	const snippet = typeof result.content === 'string' ? result.content
		: typeof result.snippet === 'string' ? result.snippet : undefined;
	return {
		url,
		...(title.length > 0 ? { title } : {}),
		...(snippet !== undefined && snippet.length > 0 ? { snippet } : {})
	};
}

/**
 * Walk the SearXNG HTML results page linearly and turn articles into
 * \`ctx.web\` sources, for engines that serve only HTML.
 *
 * The page is remote data, so there are no \`[\s\S]*?\`-style regexes over
 * the whole body (CodeQL flags those as polynomial); every step is an indexed
 * scan with a bounded start and end. Attribute values may use one or double
 * quotes; the value stops at the matching quote.
 */
export function sourcesFromHtml(body) {
	const sources = [];
	const seen = new Set();
	const page = String(body);
	const lower = page.toLowerCase();
	let at = lower.indexOf('<article');
	while (at >= 0) {
		const stop = lower.indexOf('</article', at);
		if (stop < 0) break;
		const segment = page.slice(at, stop + '</article>'.length);
		const next = lower.indexOf('<article', stop);
		const lower_segment = segment.toLowerCase();
		if (resultAttribute(lower_segment)) {
			const source = sourceFromSegment(segment, lower_segment);
			if (source !== undefined && source.url.length > 0
				&& /^https?:\/\//.test(source.url) && !seen.has(source.url)) {
				seen.add(source.url);
				sources.push(source);
			}
		}
		at = next;
	}
	return sources;
}

/** The article class attribute carries the \`result\` token. */
function resultAttribute(lowerSegment) {
	const anchorTag = lowerSegment.indexOf('<a ');
	const classProbe = lowerSegment.indexOf('class', anchorTag < 0 ? 0 : anchorTag / 2 | 0);
	return lowerSegment.indexOf('result', classProbe === -1 ? 0 : classProbe) !== -1
		|| lowerSegment.indexOf('result') !== -1;
}

/** Scan one article fragment for its anchor and content paragraph. */
function sourceFromSegment(segment, lowerSegment) {
	let anchor = lowerSegment.indexOf('<a ');
	if (anchor < 0) anchor = lowerSegment.indexOf('<a\t');
	if (anchor < 0) anchor = lowerSegment.indexOf('<a>');
	if (anchor < 0) return undefined;
	const hrefKey = lowerSegment.indexOf('href', anchor);
	if (hrefKey < 0) return undefined;
	const url = quotedValue(segment, hrefKey);
	if (url === undefined) return undefined;
	const titleStart = segment.indexOf('>', hrefKey + 4) + 1;
	const titleEnd = titleStart > 0 ? lowerSegment.indexOf('</a', titleStart) : -1;
	const title = titleEnd > titleStart ? stripTags(segment.slice(titleStart, titleEnd)) : '';

	let paragraph = lowerSegment.indexOf('<p', titleEnd > 0 ? titleEnd : anchor);
	let snippet;
	while (paragraph >= 0) {
		const tag = segment.slice(paragraph, paragraph + 160).toLowerCase();
		let close = segment.indexOf('>', paragraph);
		if (close < 0) return { url, ...(title.length > 0 ? { title } : {}) };
		if (tag.startsWith('<p') && tag.slice(0, close - paragraph).includes('content')) {
			const contentEnd = lowerSegment.indexOf('</p', close);
			snippet = contentEnd > close ? stripTags(segment.slice(close + 1, contentEnd)) : undefined;
			break;
		}
		paragraph = lowerSegment.indexOf('<p', close);
	}
	return {
		url,
		...(title.length > 0 ? { title } : {}),
		...(snippet !== undefined && snippet.length > 0 ? { snippet } : {})
	};
}

/** The quoted attribute value that follows the key found at \`from\`. */
function quotedValue(segment, from) {
	let quote = segment.indexOf('"', from);
	let single = segment.indexOf("'", from);
	if (single >= 0 && (quote < 0 || single < quote)) quote = single;
	if (quote < 0) return undefined;
	const mark = segment[quote];
	const end = segment.indexOf(mark, quote + 1);
	if (end < 0) return undefined;
	return htmlDecode(segment.slice(quote + 1, end));
}

function stripTags(fragment) {
	return htmlDecode(fragment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function htmlDecode(text) {
	// One pass over the ordered entity table so a double-encoded input like
	// &amp;#39; decodes exactly once (CodeQL: double escaping or unescaping).
	const entities = {
		amp: '&',
		lt: '<',
		gt: '>',
		quot: '"',
		'#39': "'",
		'#x27': "'",
		apos: "'"
	};
	return String(text).replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (target, entity) => entities[entity] ?? target);
}

function firstLine(text) {
	const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? '';
	return line.slice(0, 120);
}

function mapJsonResponse(document) {
	const rows = Array.isArray(document?.results) ? document.results : [];
	const sources = [];
	const seen = new Set();
	for (const row of rows) {
		const source = sourceFromJson(row);
		if (source === undefined || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push(source);
	}
	if (sources.length === 0) {
		throw new Error('search backend returned no usable result rows');
	}
	return { sources, truncated: false };
}

function createSearchProvider(base) {
	return {
		id: PROVIDER_ID,
		available() {
			return true;
		},
		async search(request, signal) {
			const query = typeof request?.query === 'string' ? request.query : '';
			if (query.trim().length === 0) {
				throw new Error('rdsh web search requires a query');
			}
			const searchUrl = base + '/search?q=' + encodeQuery(query) + '&format=json';
			let response;
			try {
				response = await fetch(searchUrl, {
					method: 'GET',
					redirect: 'error',
					headers: { accept: 'application/json, text/html;q=0.9' },
					...(signal !== undefined ? { signal } : {})
				});
			} catch (error) {
				if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
					throw new Error('rdsh web search aborted', { cause: error });
				}
				throw new Error(base + ' search request failed: ' + String(error), { cause: error });
			}
			const body = await response.text();
			if (response.ok && body.trimStart().startsWith('{')) {
				try {
					return mapJsonResponse(JSON.parse(body));
				} catch (error) {
					if (signal?.aborted === true) throw new Error('rdsh web search aborted', { cause: error });
					// A 200 body that is not result JSON falls through to HTML.
				}
			}
			const detail = firstLine(body);
			// The JSON API is optional in SearXNG (format=json is an engine
			// setting); a refusal is not a dead engine, it routes to HTML.
			if (!response.ok && response.status !== 403 && response.status !== 503) {
				throw new Error(base + ' search failed (HTTP ' + response.status + '): ' + detail);
			}
			const sources = sourcesFromHtml(body);
			if (sources.length === 0) {
				throw new Error(base + ' search results are unrecognizable (HTTP ' + response.status + '): ' + detail);
			}
			return { sources, truncated: false };
		}
	};
}

/** Register the provider through the web seam this plugin injects on. */
export function registerSearchProvider(ctx, base) {
	const register = (webContext) => {
		try {
			if (webContext?.web?.registerSearchProvider !== undefined) {
				webContext.web.registerSearchProvider(createSearchProvider(base));
				return true;
			}
		} catch (error) {
			webContext?.logger?.warn?.(error);
			return false;
		}
		return false;
	};
	if (typeof ctx?.inject === 'function') {
		ctx.inject(['web'], (webContext) => {
			register(webContext) || webContext?.logger?.warn?.('rdsh web search bridge could not register (no web seam)');
		});
		return true;
	}
	return register(ctx);
}

export function apply(ctx, config = {}) {
	// RDSH_WEB_SEARCH_BRIDGE=0 is a belt-and-braces off switch beside the
	// feature switch; rdsh keeps env injection aligned with it.
	if (String(process.env.RDSH_WEB_SEARCH_BRIDGE ?? '') === '0') return;
	if (!shouldBridge(process.env)) return;
	const base = resolveBase(process.env, config);
	if (base === undefined) {
		ctx?.logger?.warn?.('rdsh web search bridge: the injected search URL is unusable; leaving DSH defaults in place');
		return;
	}
	registerSearchProvider(ctx, base);
}
