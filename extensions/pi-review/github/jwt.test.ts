import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppJwt } from "./jwt.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function decode(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("createAppJwt", () => {
	const now = 1_700_000_000_000;

	it("produces an RS256 token GitHub will accept", () => {
		const jwt = createAppJwt(1234, pem, now);
		const [header, payload, signature] = jwt.split(".");
		expect(header && payload && signature).toBeTruthy();
		expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
		expect(jwt.split(".")).toHaveLength(3);
		expect(signature).not.toMatch(/[+/=]/);
	});

	it("uses the App id as iss and backdates iat", () => {
		const payload = decode(createAppJwt(1234, pem, now).split(".")[1]!);
		const issuedAt = Math.floor(now / 1000) - 60;
		expect(payload).toEqual({ iat: issuedAt, exp: issuedAt + 540, iss: 1234 });
	});

	it("keeps exp inside GitHub's ten-minute limit", () => {
		const payload = decode(createAppJwt(1, pem, now).split(".")[1]!);
		expect((payload.exp as number) - Math.floor(now / 1000)).toBeLessThanOrEqual(10 * 60);
	});

	it("signs the header and payload", () => {
		const jwt = createAppJwt(1234, pem, now);
		const [header, payload, signature] = jwt.split(".");
		const verifier = createVerify("RSA-SHA256");
		verifier.update(`${header}.${payload}`);
		verifier.end();
		expect(verifier.verify(publicPem, Buffer.from(signature!, "base64url"))).toBe(true);
	});
});
