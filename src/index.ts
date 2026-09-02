import { loadConfig } from "./config";
import { DiscordService } from "./discord";
import { createServer } from "./server";

const config = loadConfig();
const discordService = new DiscordService(config);

await discordService.start();

const app = createServer(config, discordService);

export default {
	port: config.port,
	fetch: app.fetch,
};

console.log(`[pi-bridge] Serveur HTTP démarré sur le port ${config.port}`);
