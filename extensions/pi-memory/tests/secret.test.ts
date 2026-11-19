import { describe, expect, it } from "vitest";
import { findSecret, scanMemoryFields, secretRefusal } from "../secret.ts";

describe("findSecret", () => {
	it.each([
		["AWS access key", "key AKIAIOSFODNN7ABCDEF1 here"],
		["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
		["GitHub fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"],
		["Slack token", "xoxb-1234567890-abcdefghijkl"],
		["Anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"],
		["OpenAI key", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"],
		["Stripe key", `sk_${"live"}_abcdefghijklmnopqrstuvwx`],
		["Google key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
		["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
		["PEM", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
		["connection string", "postgres://user:hunter2pass@db.internal:5432/app"],
		["Bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
	])("flags %s", (_label, text) => {
		expect(findSecret(text)).toBeDefined();
	});

	it.each([
		["documentation", "Set sk-ant-... in your environment."],
		["placeholder", "api_key = sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
		["prose", "The token expires after an hour."],
		["env reference", "api_key: process.env.OPENAI_API_KEY"],
		["ordinary sentence", "password: rotate this every quarter"],
	])("ignores %s", (_label, text) => {
		expect(findSecret(text)).toBeUndefined();
	});

	it("flags a credential assignment with a real-looking value", () => {
		expect(findSecret('password = "hunter2hunter2AB"')).toBeDefined();
	});
});

describe("scanMemoryFields", () => {
	it("reports the field without leaking the value", () => {
		const hit = scanMemoryFields({
			name: "Deploy",
			description: "Uses a token",
			body: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		});
		expect(hit?.field).toBe("body");
		expect(hit?.label).toBe("GitHub token");
		const message = secretRefusal(hit!);
		expect(message).toContain("body");
		expect(message).toContain("GitHub token");
		expect(message).not.toContain("ghp_");
	});
});
