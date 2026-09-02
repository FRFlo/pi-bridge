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
	threadId?: string;
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
	selectedOptionValues: Set<string>;
	customText?: string;
	timer: Timer | null;
	resolve: (result: QuestionResult) => void;
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

	private async resolveTargetChannel(
		channelId?: string,
		threadId?: string,
	): Promise<TextChannel | ThreadChannel | null> {
		const targetId = threadId || channelId || this.config.defaultThreadId || this.config.defaultChannelId;
		if (!targetId) return null;

		try {
			const channel = await this.client.channels.fetch(targetId);
			if (channel && channel.isTextBased()) {
				return channel as TextChannel | ThreadChannel;
			}
		} catch (err) {
			console.error(`[Discord] Impossible de récupérer le salon/fil ${targetId}:`, err);
		}
		return null;
	}

	public async sendNotification(params: {
		message: string;
		title?: string;
		channelId?: string;
		threadId?: string;
	}): Promise<{ success: boolean; messageId?: string; error?: string }> {
		const channel = await this.resolveTargetChannel(params.channelId, params.threadId);
		if (!channel) {
			return { success: false, error: "Salon ou fil Discord introuvable" };
		}

		try {
			const embed = new EmbedBuilder()
				.setColor(0x5865f2)
				.setTimestamp();

			if (params.title) {
				embed.setTitle(params.title);
				embed.setDescription(params.message);
			} else {
				embed.setDescription(params.message);
			}

			const sent = await channel.send({ embeds: [embed] });
			return { success: true, messageId: sent.id };
		} catch (err: any) {
			return { success: false, error: err.message || String(err) };
		}
	}

	public async askQuestion(req: QuestionRequest): Promise<QuestionResult> {
		const channel = await this.resolveTargetChannel(req.channelId, req.threadId);
		if (!channel) {
			return {
				status: "cancelled",
				answers: [],
				message: "Salon ou fil Discord introuvable",
			};
		}

		const questionId = randomUUID().slice(0, 8);
		const timeoutSec = req.timeoutSeconds || 300;
		const expireTimestamp = Math.floor(Date.now() / 1000) + timeoutSec;

		const embed = this.buildQuestionEmbed(req, expireTimestamp);
		const components = this.buildQuestionComponents(questionId, req);

		const sentMessage = await channel.send({
			embeds: [embed],
			components,
		});

		return new Promise<QuestionResult>((resolve) => {
			const timer = setTimeout(async () => {
				const pending = this.pendingQuestions.get(questionId);
				if (!pending) return;
				this.pendingQuestions.delete(questionId);

				await this.updateMessageStatus(
					sentMessage,
					req,
					"⌛ **Question expirée (délai dépassé)**",
					0xed4245,
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
				selectedOptionValues: new Set<string>(),
				timer,
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

		if (pending.timer) clearTimeout(pending.timer);
		this.pendingQuestions.delete(questionId);

		await this.updateMessageStatus(pending.message, pending.req, statusMessage, 0x57f287);
		pending.resolve({
			status: "answered",
			answers: [],
			message: statusMessage,
		});
		return true;
	}

	private buildQuestionEmbed(req: QuestionRequest, expireTimestamp: number): EmbedBuilder {
		const embed = new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle("❓ Question de Pi Agent")
			.setDescription(`### ${req.question}\n\n⏳ *Expire <t:${expireTimestamp}:R>*`)
			.setTimestamp();

		if (req.context) {
			embed.addFields({
				name: "📋 Contexte",
				value: req.context.length > 1024 ? `${req.context.slice(0, 1020)}...` : req.context,
			});
		}

		if (req.recentMessages && req.recentMessages.length > 0) {
			const formattedRecent = req.recentMessages
				.slice(-3)
				.map((m) => `**${m.role === "user" ? "👤 Flo" : "🤖 Pi"}**: ${m.content.length > 250 ? `${m.content.slice(0, 247)}...` : m.content}`)
				.join("\n\n");

			if (formattedRecent.trim()) {
				embed.addFields({
					name: "💬 Derniers échanges",
					value: formattedRecent.length > 1024 ? `${formattedRecent.slice(0, 1020)}...` : formattedRecent,
				});
			}
		}

		if (req.details) {
			embed.addFields({
				name: "ℹ️ Détails & Instructions",
				value: req.details.length > 1024 ? `${req.details.slice(0, 1020)}...` : req.details,
			});
		}

		return embed;
	}

	private buildQuestionComponents(
		questionId: string,
		req: QuestionRequest,
	): ActionRowBuilder<any>[] {
		const rows: ActionRowBuilder<any>[] = [];
		const options = req.options || [];
		const isMulti = Boolean(req.multiSelect);

		if (options.length > 0) {
			if (isMulti) {
				// Multi-select dropdown
				const selectMenu = new StringSelectMenuBuilder()
					.setCustomId(`select:${questionId}`)
					.setPlaceholder("Sélectionnez une ou plusieurs options...")
					.setMinValues(1)
					.setMaxValues(options.length)
					.addOptions(
						options.map((opt, idx) => ({
							label: `${idx + 1}. ${opt.label}`.slice(0, 100),
							value: opt.value || opt.label,
							description: opt.description ? opt.description.slice(0, 100) : undefined,
						})),
					);

				rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

				// Actions row
				const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setCustomId(`submit_multi:${questionId}`)
						.setLabel("Valider la sélection")
						.setStyle(ButtonStyle.Success)
						.setEmoji("🚀"),
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
				// Single select
				if (options.length <= 4) {
					const buttonRow = new ActionRowBuilder<ButtonBuilder>();
					options.forEach((opt, idx) => {
						buttonRow.addComponents(
							new ButtonBuilder()
								.setCustomId(`opt:${questionId}:${idx}`)
								.setLabel(`${idx + 1}. ${opt.label}`.slice(0, 80))
								.setStyle(ButtonStyle.Primary),
						);
					});
					buttonRow.addComponents(
						new ButtonBuilder()
							.setCustomId(`other:${questionId}`)
							.setLabel("Autre")
							.setStyle(ButtonStyle.Secondary)
							.setEmoji("✏️"),
					);
					rows.push(buttonRow);

					const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
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
				} else {
					// > 4 options: use select menu
					const selectMenu = new StringSelectMenuBuilder()
						.setCustomId(`select_single:${questionId}`)
						.setPlaceholder("Choisissez une option...")
						.setMinValues(1)
						.setMaxValues(1)
						.addOptions(
							options.map((opt, idx) => ({
								label: `${idx + 1}. ${opt.label}`.slice(0, 100),
								value: `${idx}`,
								description: opt.description ? opt.description.slice(0, 100) : undefined,
							})),
						);
					rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

					const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder()
							.setCustomId(`other:${questionId}`)
							.setLabel("Autre")
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
	): Promise<void> {
		try {
			const embed = new EmbedBuilder()
				.setColor(color)
				.setTitle("❓ Question de Pi Agent")
				.setDescription(`### ${req.question}\n\n${statusText}`)
				.setTimestamp();

			if (req.details) {
				embed.addFields({ name: "ℹ️ Détails", value: req.details });
			}

			await message.edit({
				embeds: [embed],
				components: [], // Disables all buttons/menus
			});
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
		const [action, questionId, param] = interaction.customId.split(":");
		const pending = this.pendingQuestions.get(questionId);
		if (!pending) {
			await interaction.reply({
				content: "Cette question n'est plus active ou a déjà été résolue.",
				ephemeral: true,
			});
			return;
		}

		if (action === "cancel") {
			if (pending.timer) clearTimeout(pending.timer);
			this.pendingQuestions.delete(questionId);

			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0xed4245)
						.setTitle("❌ Question annulée")
						.setDescription(`### ${pending.req.question}\n\nAnnulée sur Discord par <@${interaction.user.id}>.`)
						.setTimestamp(),
				],
				components: [],
			});

			pending.resolve({
				status: "cancelled",
				answers: [],
				message: "Question annulée depuis Discord",
				user: { id: interaction.user.id, username: interaction.user.username },
			});
			return;
		}

		if (action === "retry") {
			if (pending.timer) clearTimeout(pending.timer);
			this.pendingQuestions.delete(questionId);

			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0xfee75c)
						.setTitle("🔄 Réessayer / Fork demandé")
						.setDescription(`### ${pending.req.question}\n\nInterruption demandée par <@${interaction.user.id}> pour forker/réessayer la session.`)
						.setTimestamp(),
				],
				components: [],
			});

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
				.setTitle("Saisie de réponse");

			const textInput = new TextInputBuilder()
				.setCustomId("custom_text")
				.setLabel("Votre réponse ou précision :")
				.setStyle(TextInputStyle.Paragraph)
				.setRequired(true)
				.setPlaceholder("Tapez votre texte ici...");

			modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
			await interaction.showModal(modal);
			return;
		}

		if (action === "opt") {
			const index = Number.parseInt(param, 10);
			const opt = pending.req.options?.[index];
			if (!opt) return;

			if (pending.timer) clearTimeout(pending.timer);
			this.pendingQuestions.delete(questionId);

			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0x57f287)
						.setTitle("✅ Choix validé")
						.setDescription(`### ${pending.req.question}\n\n**Option choisie :**\n✓ \`${index + 1}. ${opt.label}\`\n\n*Validé par <@${interaction.user.id}>*`)
						.setTimestamp(),
				],
				components: [],
			});

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
			return;
		}

		if (action === "submit_multi") {
			const options = pending.req.options || [];
			const selectedValues = Array.from(pending.selectedOptionValues);

			if (selectedValues.length === 0 && !pending.customText) {
				await interaction.reply({
					content: "⚠️ Veuillez sélectionner au moins une option avant de valider.",
					ephemeral: true,
				});
				return;
			}

			if (pending.timer) clearTimeout(pending.timer);
			this.pendingQuestions.delete(questionId);

			const answers: AnswerItem[] = [];
			selectedValues.forEach((val) => {
				const idx = options.findIndex((o) => (o.value || o.label) === val);
				if (idx !== -1) {
					answers.push({
						type: "option",
						label: options[idx].label,
						value: val,
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

			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0x57f287)
						.setTitle("✅ Sélection validée")
						.setDescription(`### ${pending.req.question}\n\n**Options sélectionnées :**\n${summaryList}\n\n*Validé par <@${interaction.user.id}>*`)
						.setTimestamp(),
				],
				components: [],
			});

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
			// Multi-select values updated
			pending.selectedOptionValues = new Set(interaction.values);
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

			if (pending.timer) clearTimeout(pending.timer);
			this.pendingQuestions.delete(questionId);

			await interaction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(0x57f287)
						.setTitle("✅ Choix validé")
						.setDescription(`### ${pending.req.question}\n\n**Option choisie :**\n✓ \`${index + 1}. ${opt.label}\`\n\n*Validé par <@${interaction.user.id}>*`)
						.setTimestamp(),
				],
				components: [],
			});

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
				if (pending.timer) clearTimeout(pending.timer);
				this.pendingQuestions.delete(questionId);

				await interaction.deferUpdate().catch(() => {});
				await this.updateMessageStatus(
					pending.message,
					pending.req,
					`**Réponse :**\n\`${text}\`\n\n*Soumis par <@${interaction.user.id}>*`,
					0x57f287,
				);

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
