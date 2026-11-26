#!/usr/bin/env node
/**
 * Talk to the board from a plain shell, which is how a human unblocks a lane.
 *
 *   node extensions/pi-board/cli.ts lanes
 *   node extensions/pi-board/cli.ts send <lane> <text…>
 *   node extensions/pi-board/cli.ts post <topic> [text…]
 *   node extensions/pi-board/cli.ts inbox <lane>
 *
 * Messages are sent as `PI_BOARD_FROM` (default "human"). The shell is not a lane,
 * so it never receives anything and needs no registration.
 */

import { formatLane } from "./format.ts";
import { boardRoot, isLaneAlive, listLanes, pendingCount, postTopic, readInbox, sendDirect } from "./store.ts";

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (line: string) => void = console.log): number {
	const root = boardRoot(env);
	const from = env.PI_BOARD_FROM?.trim() || "human";
	const [verb, ...rest] = argv;
	switch (verb) {
		case "lanes": {
			const now = Date.now();
			const lanes = listLanes(root);
			if (lanes.length === 0) out("No lanes on this board yet.");
			for (const lane of lanes) out(`${formatLane(lane, isLaneAlive(lane, now), now)}  unread ${pendingCount(root, lane.lane)}`);
			return 0;
		}
		case "send": {
			const [to, ...words] = rest;
			const body = words.join(" ").trim();
			if (!to || !body) return fail(out, "usage: send <lane> <text…>");
			const result = sendDirect(root, { from, to, body });
			if (!result.ok) return fail(out, result.reason);
			out(`sent to ${to} (${result.delivered})`);
			return 0;
		}
		case "post": {
			const [topic, ...words] = rest;
			if (!topic) return fail(out, "usage: post <topic> [text…]");
			const result = postTopic(root, { from, topic, body: words.join(" ").trim() || topic });
			if ("ok" in result) return fail(out, result.reason);
			out(`posted ${topic}; notified ${result.notified.join(", ") || "nobody yet (kept for 24h)"}`);
			return 0;
		}
		case "inbox": {
			const [lane] = rest;
			if (!lane) return fail(out, "usage: inbox <lane>");
			const messages = readInbox(root, lane);
			if (messages.length === 0) out(`${lane}: no unread messages`);
			for (const m of messages) out(`${m.id}  from ${m.from}${m.topic ? `  ${m.topic}` : ""}  ${m.body.slice(0, 120)}`);
			return 0;
		}
		default:
			return fail(out, "usage: lanes | send <lane> <text…> | post <topic> [text…] | inbox <lane>");
	}
}

function fail(out: (line: string) => void, message: string): number {
	out(message);
	return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run(process.argv.slice(2)));
