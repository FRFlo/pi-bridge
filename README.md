# pi-bridge

Relais bidirectionnel Discord et pont de décision interactif pour l'agent de code **Pi** (`@earendil-works/pi-coding-agent`).

## Fonctionnalités

- **0 surcoût LLM & 0 jeton consommé** : Exécution instantanée (<200ms) communiquant directement avec l'API Discord.
- **Choix multiples enrichis** : Menus déroulants natifs `StringSelectMenu` avec multi-sélection, descriptions détaillées et validation dynamique.
- **Boutons d'action interactifs** : Sélections rapides, bouton `[ ❌ Annuler ]` et bouton `[ 🔀 Réessayer / Fork ]`.
- **Modales Discord natives** : Saisie libre par fenêtre modale pour les réponses personnalisées et remarques textuelles.
- **Fils de contexte dédiés (Threads)** : Création automatique d'un fil attaché pour consulter l'historique complet des échanges et le contexte sans encombrer le salon principal, puis archivage automatique à la résolution.
- **Système de rappels automatiques** : Ping configurable des utilisateurs autorisés si une question reste en attente.
- **Mise à jour en temps réel** : Les embeds et composants Discord se mettent à jour instantanément lors d'une action ou lors d'une réponse directe depuis le terminal local.

## Variables d'environnement

Configurez un fichier `.env` (voir `.env.example`) :

| Variable | Description | Valeur par défaut |
| --- | --- | --- |
| `PORT` | Port du serveur HTTP | `8017` |
| `PI_BRIDGE_API_KEY` | Jeton Bearer pour authentifier les requêtes Pi (`Authorization: Bearer <clé>`) | `""` (optionnel) |
| `PI_BRIDGE_DISCORD_TOKEN` | Jeton du bot Discord (ou `DISCORD_BOT_TOKEN`) | `""` (requis) |
| `DISCORD_HOME_CHANNEL` | Identifiant du salon Discord par défaut | `""` |
| `DISCORD_ALLOWED_USERS` | Identifiants Discord autorisés (séparés par des virgules, vide = tout le monde) | `""` |
| `DISCORD_REMINDER_DELAY_SECONDS` | Délai en secondes avant d'envoyer un rappel avec ping (0 = désactivé) | `60` |

## Installation & Démarrage

### Avec Bun en local

```bash
# Installation des dépendances
bun install

# Lancer les tests
bun test

# Démarrer en mode développement
bun run dev

# Compiler et lancer en production
bun run build
bun run start
```

### Avec Docker

Une image Docker officielle est disponible sur GitHub Container Registry :

```bash
docker run -d \
  --name pi-bridge \
  -p 8017:8017 \
  -e PI_BRIDGE_DISCORD_TOKEN="votre_token_discord" \
  -e DISCORD_HOME_CHANNEL="votre_channel_id" \
  -e DISCORD_ALLOWED_USERS="votre_user_id" \
  ghcr.io/frflo/pi-bridge:latest
```

## Points d'accès API (Endpoints)

### `GET /health`
Vérification de l'état du service et de la connexion au bot Discord.

### `POST /api/notify`
Envoi d'un message d'information ou d'un embed dans Discord.

```json
{
  "message": "Tâche terminée avec succès !",
  "title": "Rapport Pi",
  "channelId": "123456789012345678"
}
```

### `POST /api/ask`
Pose une question interactive avec des choix multiples ou saisie de texte libre, et attend la décision de l'utilisateur sur Discord.

```json
{
  "question": "Quelle approche d'implémentation souhaitez-vous adopter ?",
  "details": "L'approche A privilégie la vitesse, l'approche B la robustesse.",
  "options": [
    { "label": "Approche A (Rapide)", "value": "fast", "description": "Moins de vérifications" },
    { "label": "Approche B (Robuste)", "value": "robust", "description": "Tests complets" }
  ],
  "multiSelect": false,
  "timeoutSeconds": 0
}
```

### `POST /api/ask/:id/resolve`
Résout ou annule une question en attente directement depuis le terminal local (lorsque l'utilisateur répond dans la console sans passer par Discord).

```json
{
  "statusMessage": "Répondu directement depuis le terminal local",
  "isCancelled": false
}
```
