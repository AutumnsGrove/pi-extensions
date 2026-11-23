import { describe, expect, it } from "vitest";
import { MAX_IMAGES, extractImages, fetchImages } from "./images.ts";

const GUID = "0123abcd-1234-4abc-8def-0123456789ab";
const SIGNED_GUID = "9876fedc-4321-4abc-8def-ba9876543210";
const ATTACHMENT = `https://github.com/user-attachments/assets/${GUID}`;
const SIGNED = `https://private-user-images.githubusercontent.com/12345/999-${SIGNED_GUID}.png?jwt=abc`;
/** A real PNG signature: anything else is not attached. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("extractImages", () => {
	it("finds markdown images, raw img tags and signed URLs", () => {
		// Distinct GUIDs on purpose: with one shared GUID the signed URL is
		// dropped as a duplicate before SIGNED_PATH is ever consulted, and the
		// test would stay green through a regression in it.
		const text = [
			`![the header](${ATTACHMENT})`,
			`<img src="${SIGNED}" width="200">`,
			`![the header again](${ATTACHMENT})`,
		].join("\n");
		const found = extractImages(text);
		expect(found.map((ref) => [ref.guid, ref.source])).toEqual([
			[GUID, "attachment"],
			[SIGNED_GUID, "signed"],
		]);
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

	it("returns base64 image data with the type the bytes actually are", async () => {
		const result = await fetchImages([{ url: ATTACHMENT, guid: GUID, source: "attachment" }], {
			fetchImpl: (async () => response(PNG)) as typeof fetch,
		});
		expect(result.notes).toEqual([]);
		expect(result.images).toEqual([
			{
				guid: GUID,
				mimeType: "image/png",
				data: Buffer.from(PNG).toString("base64"),
			},
		]);
	});

	it("trusts the signature over a missing content type", async () => {
		const result = await fetchImages([{ url: SIGNED, guid: SIGNED_GUID, source: "signed" }], {
			fetchImpl: (async () =>
				response(PNG, "application/octet-stream")) as typeof fetch,
		});
		expect(result.images[0]?.mimeType).toBe("image/png");
	});

	it("refuses a body that is not an image the provider accepts", async () => {
		// An SVG, or a 200 with HTML labelled `image/png`: the provider rejects
		// the media type with a 400, which would kill the run instead of leaving
		// a note.
		for (const [body, contentType] of [
			[Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), "image/svg+xml"],
			[Buffer.from("<html>not an image</html>"), "image/png"],
		] as [Uint8Array, string][]) {
			const result = await fetchImages([{ url: ATTACHMENT, guid: GUID, source: "attachment" }], {
				fetchImpl: (async () => response(new Uint8Array(body), contentType)) as typeof fetch,
			});
			expect(result.images).toEqual([]);
			expect(result.notes[0]).toContain("is not an image the reviewer can read");
		}
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
			fetchImpl: (async () => response(PNG)) as typeof fetch,
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
