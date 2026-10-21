/**
 * Session grants: "allow once" is not remembered, "allow for this session" is,
 * and "always allow" also writes a rule to project settings.
 *
 * Grants are keyed by the exact call (`tool` + normalized command/path + cwd),
 * never by a loose prefix, so a grant for `git status` cannot approve
 * `git status --short && rm -rf /`.
 */

export interface Grant {
	key: string;
	rule: string;
}

export class Grants {
	private readonly entries = new Map<string, Grant>();

	add(key: string, rule: string): void {
		this.entries.set(key, { key, rule });
	}

	get(key: string): Grant | undefined {
		return this.entries.get(key);
	}

	clear(): void {
		this.entries.clear();
	}

	list(): Grant[] {
		return [...this.entries.values()];
	}

	get size(): number {
		return this.entries.size;
	}
}
