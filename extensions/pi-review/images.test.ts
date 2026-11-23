import { describe, expect, it } from "vitest";
import { MAX_IMAGES, extractImages, fetchImages } from "./images.ts";

const GUID = "0123abcd-1234-4abc-8def-0123456789ab";
const ATTACHMENT = `https://github.com/user-attachments/assets/${GUID}`;
const SIGNED = `https://private-user-images.githubusercontent.com/12345/999-${GUID}.png?jwt=abc`;

describe("extractImages", () => {
	it("finds markdown images, raw img tags and signed URLs", () => {
		const text = [
			`![the header](//bad.example/${GUID})`,
			`![the header](${ATTACHMENT})`,
			`<img src="${SIGNED}" width="200">`,
			`<a href="${ATTACHMENT}">same asset, deduped</a>`,
		].join("\n");
		const found = extractImages(text);
		expect(found.map((ref) => ref.guid)).toEqual([GUID]);
		expect(found[0]?.source).toBe("attachment");
	});

	it("ignores a lookalike host and a GUID that is not the asset", () => {
		// The GUID has to come from the resolved filename, or text that merely
		// embeds one could claim another asset.
		const text = [
			`![x](https://github.evil.test/user-attachments/assets/${GUID})`,
			`![y](https://github.com/user-attachments/assets/12345/${GUID})`,
			// The GUID appears only in the query, not in the resolved filename.
			`![z](https://private-user-images.githubusercontent.com/1/2-999999.png?jwt=${GUID})`,
			"![plain](https://example.test/nothing.png)",
		].join("\n");
		expect(extractImages(text)).toEqual([]);
	});

	it("caps how many a comment can ask for", () => {
		const text = Array.from({ length: MAX_IMAGES + 3 }, (_, index) => {
			const guid = `0123abcd-1234-4abc-8def-01234567${String(index).padStart(4, "0")}`;
			return `![shot ${index}](https://github.com/user-attachments/assets/${guid})`;
		}).join("\n");
		expect(extractImages(text)).toHaveLength(MAX_IMAGES);
	});
});

describe("fetchImages", () => {
	const response = (body: Uint8Array, contentType = "image/png") =>
		({ ok: true, status: 200, headers: new Headers({ "content-type": contentType }), arrayBuffer: async () => body }) as unknown as Response;

	it("returns base64 image data with a mime type", async () => {
		const result = await fetchImages([{ url: ATTACHMENT, guid: GUID, source: "attachment" }], {
			fetchImpl: (async () => response(new Uint8Array([1, 2, 3]))) as typeof fetch,
		});
		expect(result.notes).toEqual([]);
		expect(result.images).toEqual([{ guid: GUID, mimeType: "image/png", data: "AQID" }]);
	});

	it("falls back to the extension when the server sends no content type", async () => {
		const result = await fetchImages([{ url: SIGNED, guid: GUID, source: "signed" }], {
			fetchImpl: (async () =>
				response(new Uint8Array([1]), "application/octet-stream")) as typeof fetch,
		});
		expect(result.images[0]?.mimeType).toBe("image/png");
	});

	it("turns a failure into a note instead of throwing", async () => {
		const result = await fetchImages(
			[{ url: ATTACHMENT, guid: GUID, source: "attachment" }],
			{ fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch }
		);
		expect(result.images).toEqual([]);
		expect(result.notes[0]).toContain("could not be fetched");
		expect(result.notes[0]).toContain("network down");
	});

	it("refuses an image over the size cap", async () => {
		const result = await fetchImages([{ url: ATTACHMENT, guid: GUID, source: "attachment" }], {
			maxBytes: 2,
			fetchImpl: (async () => response(new Uint8Array([1, 2, 3]))) as typeof fetch,
		});
		expect(result.images).toEqual([]);
		expect(result.notes[0]).toContain("larger than");
	});

	it("reports an HTTP error by status", async () => {
		const result = await fetchImages([{ url: ATTACHMENT, guid: GUID, source: "attachment" }], {
			fetchImpl: (async () =>
				({ ok: false, status: 404, headers: new Headers() }) as unknown as Response) as typeof fetch,
		});
		expect(result.notes[0]).toContain("HTTP 404");
	});
});
