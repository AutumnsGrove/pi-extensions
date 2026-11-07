/**
 * App JWTs for the one API call a GitHub App can make without an installation
 * token: `GET /repos/{owner}/{repo}/installation`, which answers "is the App
 * installed on this repository?".
 *
 * GitHub requires RS256, an `iss` of the App id, and an `exp` at most ten
 * minutes out. The `iat` is backdated a minute to tolerate clock skew.
 */

import { createSign } from "node:crypto";

const ALGORITHM = "RSA-SHA256";
const BACKDATE_SECONDS = 60;
const TTL_SECONDS = 9 * 60;

function base64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

export function createAppJwt(appId: number, pem: string, now = Date.now()): string {
	const issuedAt = Math.floor(now / 1000) - BACKDATE_SECONDS;
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({ iat: issuedAt, exp: issuedAt + TTL_SECONDS, iss: appId })
	);
	const unsigned = `${header}.${payload}`;
	const signer = createSign(ALGORITHM);
	signer.update(unsigned);
	signer.end();
	const signature = signer.sign(pem).toString("base64url");
	return `${unsigned}.${signature}`;
}
