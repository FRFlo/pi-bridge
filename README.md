# pi-bridge

Direct bidirectional Discord relay & interactive decision bridge for the **Pi Coding Agent**.

## Features

- **0 LLM & 0 Token Overhead**: Instant (<200ms) execution directly communicating with Discord API.
- **Rich Multiple Choice**: Native `StringSelectMenu` multi-selection with emoji badges, descriptions, and dynamic submission.
- **Interactive Action Buttons**: Single-choice buttons, `[ ❌ Annuler ]`, and `[ 🔄 Réessayer / Fork ]`.
- **Discord Modals**: Native popup text input for custom answers and freeform remarks.
- **Context-Aware Embeds**: Displays previous conversation context, code diffs, and relative expiration countdowns (`<t:TIMESTAMP:R>`).
- **Live Message Editing**: Real-time updates on Discord as choices are made (or answered locally in the terminal).

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP server port | `8017` |
| `PI_BRIDGE_API_KEY` | Bearer token for authenticating Pi requests | `""` |
| `PI_BRIDGE_DISCORD_TOKEN` | Discord Bot Token | `""` |
| `DISCORD_HOME_CHANNEL` | Default Discord Channel ID | `1544807364585201864` |
| `DISCORD_DEFAULT_THREAD_ID` | Default Discord Thread ID (`Pi - PC`) | `1544807364585201864` |
| `DISCORD_ALLOWED_USERS` | Comma-separated allowed Discord User IDs | `544862774002581504` |

## API Endpoints

- `GET /health` — Service health check.
- `POST /api/notify` — Send a Discord notification message or embed.
- `POST /api/ask` — Send an interactive question and wait for Discord user decision.
- `POST /api/ask/:id/resolve` — Mark a question as resolved from the local terminal.
