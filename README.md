# PochanaBot

PochanaBot is a modern Discord voice bot built with TypeScript.

## Features

- YouTube URL playback and plain-text YouTube search.
- A separate playback queue for every Discord server.
- FFmpeg-based audio transcoding using a system-installed or local executable.

## Prerequisites

- Node.js 22.13 or newer.
- pnpm 11.3.0, as declared by the `packageManager` field in `package.json`.
- FFmpeg available on the system `PATH`, or as `./ffmpeg` in PochanaBot's working directory.

## Installation

Install the exact locked dependency graph:

```bash
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` and set:

```text
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_TEST_GUILD_ID=your-test-server-id
```

- `DISCORD_TOKEN` is the secret token from Developer Portal → Bot. Never commit or share it.
- `DISCORD_CLIENT_ID` is the public Application ID from Developer Portal → General Information.
- (for testing only) `DISCORD_TEST_GUILD_ID` is the ID of the server used for rapid test-scoped command deployment. It is not needed for global deployment or normal bot startup. To copy it, enable Developer Mode in Discord, right-click the test server, and select **Copy Server ID**.

Values in `.env` take precedence over variables inherited from the shell.

## Build and run

Build after installation or source changes:

```bash
pnpm build
```

Start the already-built bot:

```bash
pnpm run start
```

## Discord bot requirements

PochanaBot must be installed to a server. Configure the application in the [Discord Developer Portal](https://discord.com/developers/applications) as follows:

- Under **Installation**, enable **Guild Install** and include the `bot` and `applications.commands` scopes.
- Grant the bot **View Channels**, **Send Messages**, and **Embed Links** for text channels, plus **Connect** and **Speak** for voice channels.
- Use the generated installation link to add the bot to each server where it will run. The person installing it must have permission to manage that server.
- Make sure members who should use the bot have **Use Application Commands** in the relevant channels.

PochanaBot uses only the standard `Guilds` and `GuildVoiceStates` gateway intents.

If commands were deployed successfully but do not appear in an older server, open the current installation link and authorize the app for that server again; you don't need to remove the bot first. Also check the app's command access under **Server Settings → Integrations** and the channel's **Use Application Commands** permission.

## Commands

- `/play query:<text-or-url>` finds one YouTube video, joins your voice channel, and starts it or adds it to the queue. The response includes the title, YouTube link, duration, thumbnail, and requester, plus its upcoming queue position when queued.
- `/play-next query:<text-or-url>` works like `/play`, but puts the video at the front of the upcoming queue so it plays after the current track. If nothing is playing, it starts immediately.
- `/playlist url:<youtube-url-with-a-playlist>` adds every playable video from a YouTube playlist as a separate queue entry. A watch URL containing both `v` and `list` parameters loads the playlist; the same URL passed to `/play` loads only the selected video.
- `/pause` pauses the current track.
- `/resume` resumes a paused track.
- `/skip` starts the next queued track, or stops playback when nothing is queued.
- `/remove tracks:<position-or-range>` removes upcoming queue entries, such as `tracks:12` or `tracks:12-20`. Positions correspond to the numbered tracks shown under **Up next** in `/queue`; use `/skip` to remove the current track.
- `/stop` stops playback and clears the queue while keeping the voice connection open temporarily.
- `/disconnect` clears playback and disconnects immediately.
- `/queue` posts the current track and up to ten upcoming tracks publicly. When more tracks are queued, **Browse full queue** opens a private, live paginator for each viewer, starting with tracks 11–20. You do not need to join the voice channel to use it.

Playback controls require you to be in the same voice channel as the bot. When a command succeeds, the bot posts a confirmation in the text channel. If the command cannot run (for example, because you are not in the bot's voice channel) the explanation is shown only to you.

## Queue and connection behavior

- Each server has its own queue, voice connection, audio player, and cleanup timers.
- The maximum queue size is 500 tracks, including the current track.
- If a track cannot be played, the bot reports it in the requesting text channel and moves on to the next track.
- If a lost voice connection cannot be restored, the bot clears that server's playback session.
- Playback queues are kept only in memory and are cleared when the bot restarts.

Two cleanup timers handle different kinds of "empty":

- **Empty-channel cleanup (30 seconds):** If no human listeners remain in the bot's voice channel, it stops playback, clears the queue, and disconnects.
- **Idle disconnect (5 minutes):** If nothing is playing or queued, the bot remains connected for five minutes and then disconnects. It posts a notice in the text channel where playback was most recently requested.

## Supported YouTube inputs

PochanaBot supports searches, individual videos, and playlists from:

- `youtube.com` and `m.youtube.com`
- `music.youtube.com`
- `youtu.be`
- YouTube Shorts links

Ordinary public and unlisted playlists have a saved track list, so `/playlist` loads their available pages in order. YouTube-generated Mix/radio queues with `RD…` IDs are personalized and dynamic: the bot loads only the initial batch generated for its anonymous YouTube session, which can differ from the Mix shown in your account. Mix URLs must be copied from a watch page so they include both `v` and `list` parameters.

Command deployment, validation, and architecture notes are in [`DEVELOPMENT.md`](./DEVELOPMENT.md).
