export interface Config {
	port: number;
	apiKey: string;
	discordToken: string;
	defaultChannelId: string;
	defaultThreadId: string;
	allowedUsers: string[];
}

export function loadConfig(): Config {
	const port = Number.parseInt(process.env.PORT || "8017", 10);
	const apiKey = process.env.PI_BRIDGE_API_KEY || "";
	const discordToken = process.env.PI_BRIDGE_DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || "";
	const defaultChannelId = process.env.DISCORD_HOME_CHANNEL || "1544452203207589938";
	const defaultThreadId = process.env.DISCORD_DEFAULT_THREAD_ID || "1544798185468334180";
	const rawAllowed = process.env.DISCORD_ALLOWED_USERS || "544862774002581504";
	const allowedUsers = rawAllowed
		.split(",")
		.map((u) => u.trim())
		.filter((u) => u.length > 0);

	return {
		port,
		apiKey,
		discordToken,
		defaultChannelId,
		defaultThreadId,
		allowedUsers,
	};
}
