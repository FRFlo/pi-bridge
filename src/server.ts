import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Config } from "./config";
import type { DiscordService, QuestionRequest } from "./discord";

const NotifySchema = z.object({
	message: z.string().min(1),
	title: z.string().optional(),
	channelId: z.string().optional(),
	threadId: z.string().optional(),
});

const OptionSchema = z.object({
	label: z.string().min(1),
	value: z.string().optional(),
	description: z.string().optional(),
});

const RecentMessageSchema = z.object({
	role: z.string(),
	content: z.string(),
});

const AskSchema = z.object({
	question: z.string().min(1),
	details: z.string().optional(),
	context: z.string().optional(),
	recentMessages: z.array(RecentMessageSchema).optional(),
	options: z.array(OptionSchema).optional(),
	multiSelect: z.boolean().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	channelId: z.string().optional(),
	threadId: z.string().optional(),
});

const ResolveSchema = z.object({
	statusMessage: z.string().optional(),
});

export function createServer(config: Config, discordService: DiscordService) {
	const app = new Hono();

	app.use("*", cors());

	// Healthcheck
	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			service: "pi-bridge",
			discordConnected: discordService.isReady(),
			timestamp: new Date().toISOString(),
		});
	});

	// Auth middleware for /api/*
	app.use("/api/*", async (c, next) => {
		if (config.apiKey) {
			const authHeader = c.req.header("Authorization") || "";
			const token = authHeader.startsWith("Bearer ")
				? authHeader.slice(7).trim()
				: authHeader.trim();

			if (!token || token !== config.apiKey) {
				return c.json({ error: "Unauthorized: Invalid API key" }, 401);
			}
		}
		await next();
	});

	// POST /api/notify
	app.post("/api/notify", async (c) => {
		try {
			const body = await c.req.json();
			const parsed = NotifySchema.safeParse(body);
			if (!parsed.success) {
				return c.json({ error: "Invalid payload", details: parsed.error.issues }, 400);
			}

			const res = await discordService.sendNotification(parsed.data);
			if (!res.success) {
				return c.json({ error: res.error || "Failed to send notification" }, 500);
			}

			return c.json({ success: true, messageId: res.messageId });
		} catch (err: any) {
			return c.json({ error: err.message || "Internal server error" }, 500);
		}
	});

	// POST /api/ask
	app.post("/api/ask", async (c) => {
		try {
			const body = await c.req.json();
			const parsed = AskSchema.safeParse(body);
			if (!parsed.success) {
				return c.json({ error: "Invalid payload", details: parsed.error.issues }, 400);
			}

			const req: QuestionRequest = {
				...parsed.data,
				options: parsed.data.options?.map((o) => ({
					label: o.label,
					value: o.value || o.label,
					description: o.description,
				})),
			};

			const result = await discordService.askQuestion(req);
			return c.json(result);
		} catch (err: any) {
			return c.json({ error: err.message || "Internal server error" }, 500);
		}
	});

	// POST /api/ask/:id/resolve
	app.post("/api/ask/:id/resolve", async (c) => {
		try {
			const id = c.req.param("id");
			const body = await c.req.json().catch(() => ({}));
			const parsed = ResolveSchema.safeParse(body);
			const statusMsg = parsed.success && parsed.data.statusMessage
				? parsed.data.statusMessage
				: "⚡ Répondu directement depuis le terminal local";

			const resolved = await discordService.resolveQuestionExternally(id, statusMsg);
			return c.json({ success: resolved });
		} catch (err: any) {
			return c.json({ error: err.message || "Internal server error" }, 500);
		}
	});

	return app;
}
