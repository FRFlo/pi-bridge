import { randomUUID } from "node:crypto";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	Client,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	type Message,
	ModalBuilder,
	type ModalSubmitInteraction,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	type TextChannel,
	TextInputBuilder,
	TextInputStyle,
	type ThreadChannel,
	ThreadAutoArchiveDuration,
} from "discord.js";
import type { Config } from "./config";

export interface QuestionOption {
	label: string;
	value: string;
	description?: string;
}

export interface QuestionRequest {
	question: string;
	details?: string;
	context?: string;
	recentMessages?: Array<{ role: string; content: string }>;
	options?: QuestionOption[];
	multiSelect?: boolean;
	timeoutSeconds?: number;
	channelId?: string;
}

export interface AnswerItem {
	type: "option" | "other" | "text";
	label: string;
	value: string;
	index?: number;
}

export interface QuestionResult {
	status: "answered" | "cancelled" | "retry" | "timeout";
	answers: AnswerItem[];
	message?: string;
	user?: {
		id: string;
		username: string;
	};
}

interface PendingQuestion {
	id: string;
	req: QuestionRequest;
	message: Message;
	thread?: ThreadChannel;
	reminderMessage?: Message;
	selectedOptionIndices: Set<number>;
	customText?: string;
	timer: Timer | null;
	reminderTimer: Timer | null;
	resolve: (result: QuestionResult) => void;
}

function truncate(str: string | undefined, maxLen: number): string {
	if (!str) return "";
	const trimmed = str.trim();
	if (trimmed.length <= maxLen) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxLen - 3))}...`;
}

export class DiscordService {
	private client: Client;
	private config: Config;
	private pendingQuestions = new Map<string, PendingQuestion>();

	constructor(config: Config) {
		this.config = config;
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
			],
		});

		this.setupEventHandlers();
	}

	public async start(): Promise<void> {
		if (!this.config.discordToken) {
			console.warn("[Discord] Aucun DISCORD_BOT_TOKEN configuré. Le client Discord ne sera pas démarré.");
			return;
		}

		try {
			await this.client.login(this.config.discordToken);
			console.log(`[Discord] Connecté en tant que ${this.client.user?.tag}`);
		} catch (err) {
			console.error("[Discord] Erreur lors de la connexion Discord:", err);
		}
	}

	public isReady(): boolean {
		return this.client.isReady();
	}

	private isUserAllowed(userId: string): boolean {
		if (this.config.allowedUsers.length === 0) return true;
		return this.config.allowedUsers.includes(userId);
	}

	private async resolveTargetChannel(channelId?: string): Promise<TextChannel | null> {
		const targetId = channelId || this.config.defaultChannelId;
		if (!targetId) return null;

		try {
			const channel = await this.client.channels.fetch(targetId);
			if (channel && channel.isTextBased() && !channel.isThread()) {
				return channel as TextChannel;
			}
			if (channel && channel.isTextBased()) {
				return channel as any;
			}
		} catch (err) {
			console.error(`[Discord] Impossible de récupérer le salon ${targetId}:`, err);
		}
		return null;
	}

	public async sendNotification(params: {
		message: string;
		title?: string;
		channelId?: string;
	}): Promise<{ success: boolean; messageId?: string; error?: string }> {
		const channel = await this.resolveTargetChannel(params.channelId);
		if (!channel) {
			return { success: false, error: "Salon Discord introuvable" };
		}

		try {
			const embed = new EmbedBuilder()
				.setColor(0x5865f2)
				.setTimestamp();

			if (params.title) {
				embed.setTitle(truncate(params.title, 256));
				embed.setDescription(truncate(params.message, 4096));
			} else {
				embed.setDescription(truncate(params.message, 4096));
			}

			const sent = await channel.send({ embeds: [embed] });
			return { success: true, messageId: sent.id };
		} catch (err: any) {
			return { success: false, error: err.message || String(err) };
		}
	}

	public async askQuestion(req: QuestionRequest): Promise<QuestionResult> {
		const channel = await this.resolveTargetChannel(req.channelId);
		if (!channel) {
			return {
				status: "cancelled",
				answers: [],
				message: "Salon Discord introuvable",
			};
		}

		const questionId = randomUUID().slice(0, 8);
		const timeoutSec = req.timeoutSeconds || 300;
		const reminderSec = this.config.reminderDelaySeconds || 60;
		const nowSec = Math.floor(Date.now() / 1000);
		const expireTimestamp = nowSec + timeoutSec;
		const reminderTimestamp = reminderSec > 0 && reminderSec < timeoutSec ? nowSec + reminderSec : undefined;

		const mainEmbed = this.buildMainQuestionEmbed(req, expireTimestamp, reminderTimestamp);
		const components = this.buildQuestionComponents(questionId, req);

		// 1. Envoyer le message principal dans le channel
		const sentMessage = await channel.send({
			embeds: [mainEmbed],
			components,
		});

		// 2. Créer un thread attaché au message principal pour y stocker le contexte
		let thread: ThreadChannel | undefined;
		try {
			const threadName = `❓ ${truncate(req.question.replace(/[\n\r]+/g, " "), 95)}`;
			thread = await sentMessage.startThread({
				name: threadName,
				autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
			});

			const contextEmbeds = this.buildContextEmbeds(req);
			if (contextEmbeds.length > 0) {
				await thread.send({ embeds: contextEmbeds });
			} else {
				await thread.send({
					content: "ℹ️ *Aucun contexte supplémentaire fourni pour cette question.*",
				});
			}
		} catch (err) {
			console.warn("[Discord] Impossible de créer le fil de contexte attaché:", err);
		}

		return new Promise<QuestionResult>((resolve) => {
			const reminderSec = this.config.reminderDelaySeconds || 60;
			let reminderTimer: Timer | null = null;

			if (reminderSec > 0 && this.config.allowedUsers.length > 0) {
				reminderTimer = setTimeout(async () => {
					const p = this.pendingQuestions.get(questionId);
					if (!p) return;

					const pings = this.config.allowedUsers.map((uid) => `<@${uid}>`).join(" ");
					try {
						const reminderMsg = await sentMessage.reply({
							content: `⏰ ${pings} **Rappel :** Cette question de Pi Agent attend votre réponse !`,
							allowedMentions: { users: this.config.allowedUsers },
						});
						p.reminderMessage = reminderMsg;

						if (p.thread) {
							await p.thread.send({
								content: `⏰ ${pings} **Rappel :** Question en attente de réponse depuis ${reminderSec}s.`,
								allowedMentions: { users: this.config.allowedUsers },
							}).catch(() => {});
						}
					} catch (err) {
						console.warn("[Discord] Impossible d'envoyer le rappel/ping:", err);
					}
				}, reminderSec * 1000);
			}

			const timer = setTimeout(async () => {
				const pending = this.pendingQuestions.get(questionId);
				if (!pending) return;
				if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
				this.pendingQuestions.delete(questionId);

				await this.updateMessageStatus(
					sentMessage,
					req,
					"⌛ **Question expirée (délai dépassé)**",
					0xed4245,
					thread,
				);

				resolve({
					status: "timeout",
					answers: [],
					message: "Délai d'attente Discord dépassé",
				});
			}, timeoutSec * 1000);

			this.pendingQuestions.set(questionId, {
				id: questionId,
				req,
				message: sentMessage,
				thread,
				selectedOptionIndices: new Set<number>(),
				timer,
				reminderTimer,
				resolve,
			});
		});
	}

	public async resolveQuestionExternally(
		questionId: string,
		statusMessage: string,
	): Promise<boolean> {
		const pending = this.pendingQuestions.get(questionId);
		if (!pending) return false;

		if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.reminderMessage) pending.reminderMessage.delete().catch(() => {});
		this.pendingQuestions.delete(questionId);

		await this.updateMessageStatus(pending.message, pending.req, statusMessage, 0x57f287, pending.thread);
		pending.resolve({
			status: "answered",
			answers: [],
			message: statusMessage,
		});
		return true;
	}

	private buildMainQuestionEmbed(req: QuestionRequest, expireTimestamp: number, reminderTimestamp?: number): EmbedBuilder {
		let timingInfo = `⏳ *Expire <t:${expireTimestamp}:R>*`;
		if (reminderTimestamp) {
			timingInfo += `\n⏰ *Rappel avec notification <t:${reminderTimestamp}:R>*`;
		}
		timingInfo += "\n🧵 *Consultez le fil attaché pour le contexte détaillé.*";

		const embed = new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle("❓ Question de Pi Agent")
			.setDescription(`### ${truncate(req.question, 1000)}\n\n${timingInfo}`)
			.setTimestamp();

		// Afficher la liste complète des options avec leurs descriptions complètes
		if (req.options && req.options.length > 0) {
			const optionsList = req.options.map((opt, idx) => {
				let line = `**${idx + 1}. ${opt.label}**`;
				if (opt.description) {
					line += `\n↳ *${opt.description}*`;
				}
				return line;
			}).join("\n\n");

			embed.addFields({
				name: "📋 Choix disponibles :",
				value: truncate(optionsList, 1024),
			});
		}

		if (req.details) {
			embed.addFields({
				name: "ℹ️ Détails & Instructions",
				value: truncate(req.details, 1024),
			});
		}

		return embed;
	}

	private buildContextEmbeds(req: QuestionRequest): EmbedBuilder[] {
		const embeds: EmbedBuilder[] = [];

		if (req.context) {
			const contextEmbed = new EmbedBuilder()
				.setColor(0x5865f2)
				.setTitle("📋 Contexte de la tâche")
				.setDescription(truncate(req.context, 4000));
			embeds.push(contextEmbed);
		}

		if (req.recentMessages && req.recentMessages.length > 0) {
			const formattedRecent = req.recentMessages
				.slice(-4)
				.map((m) => `**${m.role === "user" ? "👤 Flo" : "🤖 Pi"}**:\n${truncate(m.content, 800)}`)
				.join("\n\n---\n\n");

			if (formattedRecent.trim()) {
				const historyEmbed = new EmbedBuilder()
					.setColor(0x4f545c)
					.setTitle("💬 Historique récent des échanges")
					.setDescription(truncate(formattedRecent, 4000));
				embeds.push(historyEmbed);
			}
		}

		return embeds;
	}

	private buildQuestionComponents(
		questionId: string,
		req: QuestionRequest,
	): ActionRowBuilder<any>[] {
		const rows: ActionRowBuilder<any>[] = [];
		const options = (req.options || []).slice(0, 25); // Discord select menu allows max 25 options
		const isMulti = Boolean(req.multiSelect);

		if (options.length > 0) {
			if (isMulti) {
				// Menu déroulant multi-sélection
				const selectMenu = new StringSelectMenuBuilder()
					.setCustomId(`select:${questionId}`)
					.setPlaceholder(truncate("Sélectionnez une ou plusieurs options...", 150))
					.setMinValues(1)
					.setMaxValues(options.length)
					.addOptions(
						options.map((opt, idx) => ({
							label: truncate(`${idx + 1}. ${opt.label}`, 100),
							value: String(idx),
							description: opt.description ? truncate(opt.description, 100) : undefined,
						})),
					);

				rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

				// Actions buttons
				const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setCustomId(`submit_multi:${questionId}`)
						.setLabel("Valider la sélection")
						.setStyle(ButtonStyle.Success)
						.setEmoji("✅"),
					new ButtonBuilder()
						.setCustomId(`other:${questionId}`)
						.setLabel("Autre (texte)")
						.setStyle(ButtonStyle.Secondary)
						.setEmoji("✏️"),
					new ButtonBuilder()
						.setCustomId(`retry:${questionId}`)
						.setLabel("Réessayer / Fork")
						.setStyle(ButtonStyle.Primary)
						.setEmoji("🔄"),
					new ButtonBuilder()
						.setCustomId(`cancel:${questionId}`)
						.setLabel("Annuler")
						.setStyle(ButtonStyle.Danger)
						.setEmoji("❌"),
				);
				rows.push(actionRow);
			} else {
				// Menu déroulant sélection unique (toujours utilisé quel que soit le nombre d'options)
				const selectMenu = new StringSelectMenuBuilder()
					.setCustomId(`select_single:${questionId}`)
					.setPlaceholder(truncate("Choisissez une option...", 150))
					.setMinValues(1)
					.setMaxValues(1)
					.addOptions(
						options.map((opt, idx) => ({
							label: truncate(`${idx + 1}. ${opt.label}`, 100),
							value: String(idx),
							description: opt.description ? truncate(opt.description, 100) : undefined,
						})),
					);
				rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

				const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setCustomId(`other:${questionId}`)
						.setLabel("Autre (texte)")
						.setStyle(ButtonStyle.Secondary)
						.setEmoji("✏️"),
					new ButtonBuilder()
						.setCustomId(`retry:${questionId}`)
						.setLabel("Réessayer / Fork")
						.setStyle(ButtonStyle.Primary)
						.setEmoji("🔄"),
					new ButtonBuilder()
						.setCustomId(`cancel:${questionId}`)
						.setLabel("Annuler")
						.setStyle(ButtonStyle.Danger)
						.setEmoji("❌"),
				);
				rows.push(controlRow);
			}
		} else {
			// Free text only
			const textRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`text_btn:${questionId}`)
					.setLabel("Saisir une réponse")
					.setStyle(ButtonStyle.Success)
					.setEmoji("💬"),
				new ButtonBuilder()
					.setCustomId(`retry:${questionId}`)
					.setLabel("Réessayer / Fork")
					.setStyle(ButtonStyle.Primary)
					.setEmoji("🔄"),
				new ButtonBuilder()
					.setCustomId(`cancel:${questionId}`)
					.setLabel("Annuler")
					.setStyle(ButtonStyle.Danger)
					.setEmoji("❌"),
			);
			rows.push(textRow);
		}

		return rows;
	}

	private async updateMessageStatus(
		message: Message,
		req: QuestionRequest,
		statusText: string,
		color = 0x57f287,
		thread?: ThreadChannel,
	): Promise<void> {
		try {
			const embed = new EmbedBuilder()
				.setColor(color)
				.setTitle("❓ Question de Pi Agent")
				.setDescription(`### ${truncate(req.question, 1000)}\n\n${truncate(statusText, 3000)}`)
				.setTimestamp();

			if (req.details) {
				embed.addFields({ name: "ℹ️ Détails", value: truncate(req.details, 1024) });
			}

			await message.edit({
				embeds: [embed],
				components: [], // Désactive tous les boutons / sélecteurs
			});

			if (thread) {
				await thread.send({
					embeds: [
						new EmbedBuilder()
							.setColor(color)
							.setTitle("Statut de la question")
							.setDescription(truncate(statusText, 4000))
							.setTimestamp(),
					],
				}).catch(() => {});
				await thread.setArchived(true).catch(() => {});
			}
		} catch (err) {
			console.error("[Discord] Erreur lors de la mise à jour du message:", err);
		}
	}

	private setupEventHandlers(): void {
		this.client.on(Events.InteractionCreate, async (interaction) => {
			if (!this.isUserAllowed(interaction.user.id)) {
				if (interaction.isRepliable()) {
					await interaction.reply({
						content: "⛔ Vous n'êtes pas autorisé à interagir avec cette session.",
						ephemeral: true,
					});
				}
				return;
			}

			if (interaction.isButton()) {
				await this.handleButtonInteraction(interaction);
			} else if (interaction.isStringSelectMenu()) {
				await this.handleSelectMenuInteraction(interaction);
			} else if (interaction.isModalSubmit()) {
				await this.handleModalSubmitInteraction(interaction);
			}
		});
	}

	private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
		const [action, questionId] = interaction.customId.split(":");
		const pending = this.pendingQuestions.get(questionId);
		if (!pending) {
			await interaction.reply({
				content: "Cette question n'est plus active ou a déjà été résolue.",
				ephemeral: true,
			});
			return;
		}

		if (action === "cancel") {
			if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.reminderMessage) pending.reminderMessage.delete().catch(() => {});
			this.pendingQuestions.delete(questionId);

			const statusText = `Question annulée par <@${interaction.user.id}>.`;
			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0xed4245)
						.setTitle("❌ Question annulée")
						.setDescription(`### ${truncate(pending.req.question, 1000)}\n\n${statusText}`)
						.setTimestamp(),
				],
				components: [],
			});

			if (pending.thread) {
				await pending.thread.send({
					content: `❌ **Question annulée** par <@${interaction.user.id}>.`,
				}).catch(() => {});
				await pending.thread.setArchived(true).catch(() => {});
			}

			pending.resolve({
				status: "cancelled",
				answers: [],
				message: "Question annulée depuis Discord",
				user: { id: interaction.user.id, username: interaction.user.username },
			});
			return;
		}

		if (action === "retry") {
			if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.reminderMessage) pending.reminderMessage.delete().catch(() => {});
			this.pendingQuestions.delete(questionId);

			const statusText = `Interruption demandée par <@${interaction.user.id}> pour forker/réessayer la session.`;
			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0xfee75c)
						.setTitle("🔄 Réessayer / Fork demandé")
						.setDescription(`### ${truncate(pending.req.question, 1000)}\n\n${statusText}`)
						.setTimestamp(),
				],
				components: [],
			});

			if (pending.thread) {
				await pending.thread.send({
					content: `🔄 **Interruption demandée** par <@${interaction.user.id}> pour forker/réessayer la session.`,
				}).catch(() => {});
				await pending.thread.setArchived(true).catch(() => {});
			}

			pending.resolve({
				status: "retry",
				answers: [],
				message: "Réessayer / Fork demandé depuis Discord",
				user: { id: interaction.user.id, username: interaction.user.username },
			});
			return;
		}

		if (action === "text_btn" || action === "other") {
			const modal = new ModalBuilder()
				.setCustomId(`modal_other:${questionId}`)
				.setTitle(truncate("Saisie de réponse", 45));

			const textInput = new TextInputBuilder()
				.setCustomId("custom_text")
				.setLabel("Votre réponse ou précision :")
				.setStyle(TextInputStyle.Paragraph)
				.setRequired(true)
				.setPlaceholder(truncate("Tapez votre texte ici...", 100));

			modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
			await interaction.showModal(modal);
			return;
		}

		if (action === "submit_multi") {
			const options = pending.req.options || [];
			const selectedIndices = Array.from(pending.selectedOptionIndices);

			if (selectedIndices.length === 0 && !pending.customText) {
				await interaction.reply({
					content: "⚠️ Veuillez sélectionner au moins une option avant de valider.",
					ephemeral: true,
				});
				return;
			}

			if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.reminderMessage) pending.reminderMessage.delete().catch(() => {});
			this.pendingQuestions.delete(questionId);

			const answers: AnswerItem[] = [];
			selectedIndices.forEach((idx) => {
				const opt = options[idx];
				if (opt) {
					answers.push({
						type: "option",
						label: opt.label,
						value: opt.value || opt.label,
						index: idx + 1,
					});
				}
			});

			if (pending.customText) {
				answers.push({
					type: "other",
					label: pending.customText,
					value: pending.customText,
				});
			}

			const summaryList = answers
				.map((a) => (a.type === "option" ? `✓ \`${a.index}. ${a.label}\`` : `✓ \`Autre: ${a.label}\``))
				.join("\n");

			const statusText = `**Options sélectionnées :**\n${summaryList}\n\n*Validé par <@${interaction.user.id}>*`;
			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0x57f287)
						.setTitle("✅ Sélection validée")
						.setDescription(`### ${truncate(pending.req.question, 1000)}\n\n${truncate(statusText, 3000)}`)
						.setTimestamp(),
				],
				components: [],
			});

			if (pending.thread) {
				await pending.thread.send({
					content: `✅ **Sélection validée** par <@${interaction.user.id}> :\n${summaryList}`,
				}).catch(() => {});
				await pending.thread.setArchived(true).catch(() => {});
			}

			pending.resolve({
				status: "answered",
				answers,
				user: { id: interaction.user.id, username: interaction.user.username },
			});
		}
	}

	private async handleSelectMenuInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
		const [action, questionId] = interaction.customId.split(":");
		const pending = this.pendingQuestions.get(questionId);
		if (!pending) {
			await interaction.reply({
				content: "Cette question n'est plus active.",
				ephemeral: true,
			});
			return;
		}

		if (action === "select") {
			// Multi-select values updated (values are string indices)
			pending.selectedOptionIndices = new Set(interaction.values.map((v) => Number.parseInt(v, 10)));
			await interaction.reply({
				content: `Sélection enregistrée (${interaction.values.length} option(s)). Cliquez sur **Valider la sélection** pour confirmer.`,
				ephemeral: true,
			});
			return;
		}

		if (action === "select_single") {
			const index = Number.parseInt(interaction.values[0], 10);
			const opt = pending.req.options?.[index];
			if (!opt) return;

			if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.reminderMessage) pending.reminderMessage.delete().catch(() => {});
			this.pendingQuestions.delete(questionId);

			const statusText = `**Option choisie :**\n✓ \`${index + 1}. ${opt.label}\`\n\n*Validé par <@${interaction.user.id}>*`;
			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0x57f287)
						.setTitle("✅ Choix validé")
						.setDescription(`### ${truncate(pending.req.question, 1000)}\n\n${truncate(statusText, 3000)}`)
						.setTimestamp(),
				],
				components: [],
			});

			if (pending.thread) {
				await pending.thread.send({
					content: `✅ **Choix validé** par <@${interaction.user.id}> : \`${index + 1}. ${opt.label}\``,
				}).catch(() => {});
				await pending.thread.setArchived(true).catch(() => {});
			}

			pending.resolve({
				status: "answered",
				answers: [
					{
						type: "option",
						label: opt.label,
						value: opt.value || opt.label,
						index: index + 1,
					},
				],
				user: { id: interaction.user.id, username: interaction.user.username },
			});
		}
	}

	private async handleModalSubmitInteraction(interaction: ModalSubmitInteraction): Promise<void> {
		const [action, questionId] = interaction.customId.split(":");
		const pending = this.pendingQuestions.get(questionId);
		if (!pending) {
			await interaction.reply({
				content: "Cette question n'est plus active.",
				ephemeral: true,
			});
			return;
		}

		if (action === "modal_other") {
			const text = interaction.fields.getTextInputValue("custom_text").trim();
			if (!text) {
				await interaction.reply({
					content: "La réponse ne peut pas être vide.",
					ephemeral: true,
				});
				return;
			}

			// If single mode or free text, resolve immediately
			if (!pending.req.multiSelect) {
				if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
				if (pending.timer) clearTimeout(pending.timer);
				if (pending.reminderMessage) pending.reminderMessage.delete().catch(() => {});
				this.pendingQuestions.delete(questionId);

				const statusText = `**Réponse :**\n\`${text}\`\n\n*Soumis par <@${interaction.user.id}>*`;
				await interaction.deferUpdate().catch(() => {});
				await this.updateMessageStatus(
					pending.message,
					pending.req,
					statusText,
					0x57f287,
					pending.thread,
				);

				if (pending.thread) {
					await pending.thread.send({
						content: `💬 **Réponse saisie** par <@${interaction.user.id}> :\n\`\`\`\n${text}\n\`\`\``,
					}).catch(() => {});
					await pending.thread.setArchived(true).catch(() => {});
				}

				pending.resolve({
					status: "answered",
					answers: [
						{
							type: pending.req.options && pending.req.options.length > 0 ? "other" : "text",
							label: text,
							value: text,
						},
					],
					user: { id: interaction.user.id, username: interaction.user.username },
				});
			} else {
				// In multi mode, store custom text and notify
				pending.customText = text;
				await interaction.reply({
					content: `Remarque/Option ajoutée : \`${text}\`. N'oubliez pas de cliquer sur **Valider la sélection**.`,
					ephemeral: true,
				});
			}
		}
	}
}
