import { describe, expect, it } from "bun:test";
import type { Config } from "../src/config";
import type { DiscordService } from "../src/discord";
import { createServer } from "../src/server";

function createMockDiscordService(overrides?: Partial<DiscordService>): DiscordService {
	return {
		isReady: () => true,
		sendNotification: async () => ({ success: true, messageId: "msg_123" }),
		askQuestion: async () => ({
			status: "answered" as const,
			answers: [{ type: "option" as const, label: "Opt 1", value: "opt1", index: 1 }],
		}),
		resolveQuestionExternally: async () => true,
		...overrides,
	} as unknown as DiscordService;
}

const baseConfig: Config = {
	port: 8017,
	apiKey: "",
	discordToken: "",
	defaultChannelId: "",
	allowedUsers: [],
	reminderDelaySeconds: 60,
};

describe("HTTP API", () => {
	it("GET /health should return status ok", async () => {
		const mockDiscord = createMockDiscordService();
		const app = createServer(baseConfig, mockDiscord);

		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.status).toBe("ok");
		expect(data.service).toBe("pi-bridge");
		expect(data.discordConnected).toBe(true);
	});

	it("POST /api/notify should enforce API key authentication when configured", async () => {
		const secureConfig: Config = { ...baseConfig, apiKey: "secret123" };
		const mockDiscord = createMockDiscordService();
		const app = createServer(secureConfig, mockDiscord);

		// Without auth header
		const unauthRes = await app.request("/api/notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "Hello" }),
		});
		expect(unauthRes.status).toBe(401);

		// With valid auth header
		const authRes = await app.request("/api/notify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer secret123",
			},
			body: JSON.stringify({ message: "Hello" }),
		});
		expect(authRes.status).toBe(200);
		const data = await authRes.json();
		expect(data.success).toBe(true);
		expect(data.messageId).toBe("msg_123");
	});

	it("POST /api/notify should validate required payload fields", async () => {
		const mockDiscord = createMockDiscordService();
		const app = createServer(baseConfig, mockDiscord);

		const res = await app.request("/api/notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/ask should validate required question field and return result", async () => {
		const mockDiscord = createMockDiscordService();
		const app = createServer(baseConfig, mockDiscord);

		const res = await app.request("/api/ask", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				question: "Should we proceed?",
				options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
			}),
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("answered");
		expect(data.answers[0].value).toBe("opt1");
	});

	it("POST /api/ask/:id/resolve should call resolveQuestionExternally", async () => {
		let resolvedId = "";
		let resolvedMsg = "";
		let resolvedCancelled: boolean | undefined;

		const mockDiscord = createMockDiscordService({
			resolveQuestionExternally: async (id, msg, isCancelled) => {
				resolvedId = id;
				resolvedMsg = msg;
				resolvedCancelled = isCancelled;
				return true;
			},
		});

		const app = createServer(baseConfig, mockDiscord);

		const res = await app.request("/api/ask/q123/resolve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				statusMessage: "Terminé depuis le terminal",
				isCancelled: false,
			}),
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.success).toBe(true);
		expect(resolvedId).toBe("q123");
		expect(resolvedMsg).toBe("Terminé depuis le terminal");
		expect(resolvedCancelled).toBe(false);
	});
});
