/**
 * Screenshots in a `@pi` comment.
 *
 * A comment that says "here is what it looks like — why is the header cut off?"
 * with a pasted image arrives as a markdown link and nothing else, so the
 * reviewer can answer only about the URL. GitHub serves pasted images from two
 * hosts, and both are identified by an asset GUID, which is the only thing worth
 * trusting in the URL.
 *
 * Nothing else is fetched. A pull request can put any URL in a comment, so the
 * host is checked, the GUID is taken from the resolved filename rather than the
 * query string (a GUID anywhere in a URL cannot claim another asset), and the
 * download is capped by count, size and time.
 */

export interface ImageRef {
	/** The URL to fetch: the attachment itself, or the signed download URL. */
	url: string;
	/** Lowercased asset GUID, which is also the file name we store it under. */
	guid: string;
	source: "attachment" | "signed";
}

export interface DownloadedImage {
	guid: string;
	mimeType: string;
	/** Base64, as `ImageContent` wants it. */
	data: string;
}

export interface ImageFetchResult {
	images: DownloadedImage[];
	/** One line per image that could not be used, for the prompt and the log. */
	notes: string[];
}

/** At most this many screenshots per run, so a comment cannot flood a review. */
export const MAX_IMAGES = 4;
/** Refuse anything larger: a review does not need a 40 MB photo. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 30_000;

const ATTACHMENT_HOST = "github.com";
const ATTACHMENT_PATH = /^\/user-attachments\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SIGNED_HOST = "private-user-images.githubusercontent.com";
/** `/<owner-id>/<asset-id>-<guid>.<ext>`; the GUID comes from the path only. */
const SIGNED_PATH =
	/^\/[^/]+\/[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[a-z0-9]+)?$/i;

const MARKDOWN_IMAGE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

function reference(url: string): ImageRef | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.host.toLowerCase() === ATTACHMENT_HOST) {
		const guid = parsed.pathname.match(ATTACHMENT_PATH)?.[1]?.toLowerCase();
		return guid ? { url, guid, source: "attachment" } : undefined;
	}
	if (parsed.host.toLowerCase() === SIGNED_HOST) {
		const guid = parsed.pathname.match(SIGNED_PATH)?.[1]?.toLowerCase();
		return guid ? { url, guid, source: "signed" } : undefined;
	}
	return undefined;
}

/** Every image URL worth fetching, in order, deduplicated by asset and capped. */
export function extractImages(text: string): ImageRef[] {
	const seen = new Map<string, ImageRef>();
	for (const pattern of [MARKDOWN_IMAGE, HTML_IMAGE]) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const found = match[1] ? reference(match[1]) : undefined;
			if (!found || seen.has(found.guid)) continue;
			seen.set(found.guid, found);
			if (seen.size >= MAX_IMAGES) return [...seen.values()];
		}
	}
	return [...seen.values()];
}

function mimeTypeFrom(url: URL, contentType: string | null): string {
	if (contentType?.startsWith("image/")) return contentType.split(";")[0] ?? "image/png";
	const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
	switch (extension) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

export interface FetchImagesOptions {
	/** Injected for tests. */
	fetchImpl?: typeof fetch;
	/** Used for private repositories, where an attachment needs a token. */
	token?: string;
	maxImages?: number;
	maxBytes?: number;
	timeoutMs?: number;
}

/**
 * Download the screenshots a comment references. Every failure is a note, not an
 * error: a review without the image is still a review, and the model is told the
 * image could not be read so it can say so instead of guessing.
 */
export async function fetchImages(
	refs: ImageRef[],
	options: FetchImagesOptions = {}
): Promise<ImageFetchResult> {
	const call = options.fetchImpl ?? fetch;
	const maxImages = options.maxImages ?? MAX_IMAGES;
	const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
	const timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS;
	const images: DownloadedImage[] = [];
	const notes: string[] = [];

	for (const ref of refs.slice(0, maxImages)) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const controller = new AbortController();
			timer = setTimeout(() => controller.abort(), timeoutMs);
			const response = await call(ref.url, {
				redirect: "follow",
				signal: controller.signal,
				headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
			});
			if (!response.ok) {
				notes.push(`screenshot ${ref.guid} could not be fetched (HTTP ${response.status})`);
				continue;
			}
			const buffer = new Uint8Array(await response.arrayBuffer());
			if (buffer.byteLength > maxBytes) {
				notes.push(`screenshot ${ref.guid} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
				continue;
			}
			if (buffer.byteLength === 0) {
				notes.push(`screenshot ${ref.guid} was empty`);
				continue;
			}
			images.push({
				guid: ref.guid,
				mimeType: mimeTypeFrom(new URL(ref.url), response.headers.get("content-type")),
				data: Buffer.from(buffer).toString("base64"),
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			notes.push(`screenshot ${ref.guid} could not be fetched (${reason})`);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	return { images, notes };
}
