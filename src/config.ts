export interface Config {
	port: number;
	apiKey: string;
	discordToken: string;
	defaultChannelId: string;
	allowedUsers: string[];
	reminderDelaySeconds: number;
}

export function loadConfig(): Config {
	const port = Number.parseInt(process.env.PORT || "8017", 10);
	const apiKey = process.env.PI_BRIDGE_API_KEY || "";
	const discordToken = process.env.PI_BRIDGE_DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || "";
	const defaultChannelId = process.env.DISCORD_HOME_CHANNEL || "1544810657549910117";
	const rawAllowed = process.env.DISCORD_ALLOWED_USERS || "544862774002581504";
	const allowedUsers = rawAllowed
		.split(",")
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
	const reminderDelaySeconds = Number.parseInt(process.env.DISCORD_REMINDER_DELAY_SECONDS || "60", 10);

	return {
		port,
		apiKey,
		discordToken,
		defaultChannelId,
		allowedUsers,
		reminderDelaySeconds,
	};
}
