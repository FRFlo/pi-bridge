import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		delete process.env.PORT;
		delete process.env.PI_BRIDGE_API_KEY;
		delete process.env.PI_BRIDGE_DISCORD_TOKEN;
		delete process.env.DISCORD_BOT_TOKEN;
		delete process.env.DISCORD_HOME_CHANNEL;
		delete process.env.DISCORD_ALLOWED_USERS;
		delete process.env.DISCORD_REMINDER_DELAY_SECONDS;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("should load safe default configuration without hardcoded IDs", () => {
		const config = loadConfig();
		expect(config.port).toBe(8017);
		expect(config.apiKey).toBe("");
		expect(config.discordToken).toBe("");
		expect(config.defaultChannelId).toBe("");
		expect(config.allowedUsers).toEqual([]);
		expect(config.reminderDelaySeconds).toBe(60);
	});

	it("should parse custom environment variables", () => {
		process.env.PORT = "9000";
		process.env.PI_BRIDGE_API_KEY = "test-secret-key";
		process.env.PI_BRIDGE_DISCORD_TOKEN = "test-discord-token";
		process.env.DISCORD_HOME_CHANNEL = "123456789";
		process.env.DISCORD_ALLOWED_USERS = " user1, user2 , user3 ";
		process.env.DISCORD_REMINDER_DELAY_SECONDS = "120";

		const config = loadConfig();
		expect(config.port).toBe(9000);
		expect(config.apiKey).toBe("test-secret-key");
		expect(config.discordToken).toBe("test-discord-token");
		expect(config.defaultChannelId).toBe("123456789");
		expect(config.allowedUsers).toEqual(["user1", "user2", "user3"]);
		expect(config.reminderDelaySeconds).toBe(120);
	});

	it("should fallback to DISCORD_BOT_TOKEN if PI_BRIDGE_DISCORD_TOKEN is not set", () => {
		process.env.DISCORD_BOT_TOKEN = "fallback-token";
		const config = loadConfig();
		expect(config.discordToken).toBe("fallback-token");
	});
});
