# Pi Agent Kit

A personal Telegram assistant with Markdown memory and access to its own server.
Give it to a friend: the recipient does not need a GitHub account, programming
experience or a ChatGPT subscription. They need a small Ubuntu/Debian server,
a Telegram bot and a funded [OpenRouter](https://openrouter.ai/keys) API key.
The source is open and available to the assistant for improvements.
Built on [Pi](https://github.com/earendil-works/pi).

## Give it as a gift and install it

Prepare a clean Ubuntu 24.04 / Debian 12 or newer server, x86_64 or arm64,
with systemd, internet access and about 1 GB RAM (2 GB makes updates easier).
Install as root or as a user with sudo. The recipient needs:

1. Their own bot from [@BotFather](https://t.me/BotFather): use `/newbot` and obtain its token.
2. Their numeric Telegram **user ID** from [@userinfobot](https://t.me/userinfobot).
3. Their own funded OpenRouter API key. Configure spending limits in OpenRouter.

Run this command on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/Hamyrappy/pi-agent-kit/main/install.sh | sudo bash
```

The installer asks for the bot token, user ID, API key, assistant name and IANA
timezone (for example, `Europe/London`). Token and key input is hidden in the
terminal. It checks the token with Telegram, installs Node.js 22+ and dependencies
from the lockfile, and creates a dedicated user and systemd service.
A GitHub account is not required. When installation finishes, open the bot's chat
and send `/start`.

The installer does not upgrade the operating system. Running it again does not
overwrite an existing directory. If installation stops partway through, the
message provides a command to continue. Each recipient uses their own keys and
personal memory. Do not give them another user's `.env`, authorization or notes.

## Using the assistant

Write naturally: “help me sort out my tasks,” “remember that I…,” “remind me
tomorrow at 10,” or “find information and save the result.” You can send voice
messages, audio recordings, photos and files up to 20 MB. Voice is transcribed
through OpenRouter; PDF and DOCX text is extracted locally. The assistant can
create files, run commands on the server and change its own code. You own the
code and memory. It runs with a dedicated Linux user's permissions; access to
other services becomes available when you configure it.

The assistant gets to know you through use, remembers confirmed preferences
and suggests useful actions. `/help` lists commands; `/face` switches between
assistant and engineer. They share memory and keep separate conversation
histories. Reminders run while the server and bot are working; overdue jobs
are picked up after a restart. Answer quality depends on the selected model.

By default, the bot responds only to your ID in a private chat. To enable groups,
add specific IDs to `telegram.allowedChatIds` in `config.json` and restart the
service. In an allowed group, the bot responds to a mention or a reply to one
of its messages; only the owner can use tools. Shared memory enters the group
context, so account for that when adding your personal assistant to a group.

### Response formatting

Pi responses are rendered as Telegram HTML (`parse_mode: HTML`): headings and
`**bold**` become `<b>`, lists use bullets, quotes use `blockquote`, tables are
flattened into `a · b` rows, and code blocks use `<pre>`. If Telegram rejects
markup, the same chunk is sent again as plain text so the answer is retained.
Text without markup is still sent without `parse_mode`.

## Memory and configuration

The installation lives in `/opt/pi-agent-kit`. Its source is writable by the
`pi-agent-kit` user. Inside:

- `vault/` — ordinary Markdown files for rules, memory, onboarding and faces;
- `config.json` — allowed IDs, model, paths and timezone;
- `.env` — Telegram token and API key;
- `.pi-agent/` — local Pi authorization;
- `.state/` — conversations, attachments and scheduled jobs.

You can open `vault/` in Obsidian or sync it separately. To use an existing folder,
set an absolute `vaultRoot` in the config and give the service user access to it.
Updates do not replace your memory with the template. To add a face, create
`vault/faces/<name>/AGENTS.md`.

To change models, edit `pi.provider` and `pi.model` in the config, preserving
`command` and `args`. Then run `npm run model:configure` as the service user and
restart the bot. If using the bundled Node installation, add it to PATH:
`export PATH=/opt/pi-kit-node/bin:$PATH`. The default is OpenRouter's
`deepseek/deepseek-v4.1-flash`; check availability in your account.
For a new OpenRouter model, configuration sets an 8192-token output limit while
preserving an existing user limit. This does not limit account spending.
Other providers supported by Pi can also be used.

## Changing its own code and restarting

The kit's name does not determine the Telegram bot's name. `botName`, token,
owner and memory are configured separately for each installation. The repository
is not tied to a particular bot or owner.

Before changing its code, the assistant saves the working version. It then edits
the code, runs checks and requests application. The current answer is delivered
before restart. A separate supervisor starts the new bridge and restores the
saved code if startup fails. Once running again, the bot reports the outcome in
Telegram. This code rollback does not replace memory, keys or conversations.

The installed server version provides `/restart`, `/restart_status` and
`/rollback`. The agent uses the following commands in its terminal. Run `begin`
**before** the first edit; `apply` repeats the checks. After `apply`, finish the
current answer rather than waiting for restart inside that answer.

```bash
node "$PI_KIT_ROOT/scripts/self-change.mjs" begin
node "$PI_KIT_ROOT/scripts/self-change.mjs" check
node "$PI_KIT_ROOT/scripts/self-change.mjs" apply --chat-id "$PI_KIT_CHAT_ID"
node "$PI_KIT_ROOT/scripts/self-change.mjs" status
node "$PI_KIT_ROOT/scripts/self-change.mjs" rollback --chat-id "$PI_KIT_CHAT_ID"
```

The supervisor is installed separately from editable application code and runs
as the bot's user. Restarting does not require administrator privileges.
The saved code and last failed version live in `.self-change/`, outside Git.
This restores application source rather than the entire system: dependency,
Node and supervisor changes require separate maintenance. If package.json,
the lockfile or the installed npm dependency marker changes, automatic apply
and rollback stop. Direct `npm start` is for development and does not launch
the supervisor.

## Backups, updates and rollback

A daily systemd timer saves `/var/backups/pi-agent-kit/latest.tar.gz` and keeps
up to three previous snapshots. A backup contains source, secrets, state and
the entire configured memory folder, including an external folder; `node_modules`
and `.git` are excluded. Backups are private to root. They are stored on the
same server: move copies to another device or machine to protect against server
loss. A running bot is stopped during a snapshot and started again afterward.

```bash
sudo /opt/pi-agent-kit/deploy/pi-kit backup
sudo /opt/pi-agent-kit/deploy/pi-kit update
sudo /opt/pi-agent-kit/deploy/pi-kit rollback
sudo /opt/pi-agent-kit/deploy/pi-kit restore /var/backups/pi-agent-kit/latest.tar.gz
```

An update first creates a backup, installs dependencies and runs tests in a
separate directory. It then briefly stops the service and replaces the code.
Secrets, memory, jobs and authorization are preserved. The previous code and
dependencies remain in `/opt/pi-agent-kit.previous`; `rollback` restores them
while preserving current data. You can choose a version: `update <tag-or-commit>`.

If you or the assistant edited the source, update refuses to overwrite it.
Update and rollback also stop when local commits are absent from `origin` refs.
First run `backup`, preserve your branch, refresh `origin` refs and reconcile
changes with upstream manually. The assistant can help with this. A commit
preserves edit history, but automatic code replacement requires the current
history to be present in `origin` already.

`restore` restores archive data to the same installation: dependencies are
prepared first and the service stops **before** current data is replaced.
The current directory remains in `.previous`; previous external memory is kept
in a neighboring `*.before-restore-*` directory. These emergency directories
are outside backup rotation. When moving to a new server, preserve the same
paths and file ownership first. Archives contain keys; do not publish them.

To use an external disk, set `PI_KIT_BACKUP_DIR=/path/to/backups` during
installation. It must be outside the source and memory folders. An existing
installation stores this path in `.deployment.json`.

## Maintenance

```bash
sudo systemctl status pi-agent-kit
sudo journalctl -u pi-agent-kit -f
sudo systemctl restart pi-agent-kit
sudo systemctl stop pi-agent-kit
sudo systemctl list-timers pi-agent-kit-backup.timer
cd /opt/pi-agent-kit
sudo -u pi-agent-kit /opt/pi-kit-node/bin/node scripts/doctor.mjs
```

If a suitable Node was already installed, use its path instead of
`/opt/pi-kit-node/bin/node`. `doctor` checks local configuration; a Telegram
response checks model access. Telegram error 409 usually means another bot
instance or a webhook. For model errors, check the balance, API key and
`pi.provider`/`pi.model`. Do not run a second polling process alongside the service.

For an older installation without `.git`, run `backup`, reconcile source files
with the chosen version manually, then run `adopt [version]`. It compares every
file and adds Git only when they match; personal data is preserved.
Never replace an existing memory folder with a fresh template.

## Local development

On a machine with Node.js **22.19+**:

```bash
git clone https://github.com/Hamyrappy/pi-agent-kit.git
cd pi-agent-kit
npm ci --ignore-scripts
npm run init
# Add OPENROUTER_API_KEY to .env and choose provider/model in the config.
npm run model:configure
npm run doctor
npm start
```

For OAuth instead of an API key, run `npm run login`, then Pi `/login` and
`/model`. Login and startup use the same `.pi-agent/` directory; if overriding
`PI_CODING_AGENT_DIR`, set it consistently for both commands.
For a user service, run `npm run service:install` after configuration; running
after logout may require `loginctl enable-linger "$USER"`.
Local `init` displays token input; the server installer hides it.

`npm test` uses temporary directories and fake Telegram/Pi endpoints.
Markdown rendering lives in `src/markdown.mjs`; its tests are in
`tests/markdown.test.mjs`. Pi is pinned in `package-lock.json`; update it together
with the tests. Secrets, `vault/` and state stay outside Git. MIT licensed.

For unattended installation, pass variables through `sudo env`:
`PI_KIT_NONINTERACTIVE=1`, `PI_KIT_BOT_TOKEN`, `PI_KIT_OWNER_ID`,
`PI_KIT_OPENROUTER_KEY`, and optionally `PI_KIT_BOT_NAME`, `PI_KIT_TIMEZONE`,
`PI_KIT_MODEL`, `PI_KIT_ROOT`, `PI_KIT_USER`, `PI_KIT_SERVICE`,
`PI_KIT_BACKUP_DIR`, `PI_KIT_VERSION`. A private environment file is safer
for secrets than putting them in shell history.
