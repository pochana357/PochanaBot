# Development

This guide covers command deployment, project validation, and the source layout. See [`README.md`](./README.md) for installation, configuration, and bot usage.

## Slash-command deployment

For rapid testing, publish all commands only to the server configured by `DISCORD_TEST_GUILD_ID`:

```bash
pnpm deploy:test
```

Test deployments append `-test` to every command name and prepend `[TEST]` to every description. For example, the test version of `/play` is shown as `/play-test`. If global commands have also been deployed, both `/play` and `/play-test` appear in the test server. They reach the same command handler in the running bot; the test suffix identifies the test-scoped registration and does not create a separate bot runtime or playback environment.

After acceptance, publish the same definitions to every server where the application is installed:

```bash
pnpm deploy:global
```

Each deployment command runs `pnpm build` first. Registration then loads the generated JavaScript from `dist/`, so Discord receives command definitions from the current source code rather than files left over from an earlier build.

Deploying replaces the commands in the selected scope with the nine definitions in this repository. Reinviting the bot is unnecessary as long as its existing installation includes the `applications.commands` scope.

## Validation

Format source and documentation after editing:

```bash
pnpm format
```

Run the formatting check, linting, production build, test-code type-check, and deterministic test suite:

```bash
pnpm check
```

Run only the deterministic test suite with:

```bash
pnpm test
```

Tests are TypeScript ES modules run by Vitest. The default suite mocks YouTube and Discord-adjacent runtime boundaries. It covers URL parsing, metadata mapping, lazy initialization, restrictions, fresh playback data, managed range streaming, queue concurrency, all controls, cleanup, connection failures, command routing, response behavior, deployment definitions, and environment validation.

External YouTube behavior is intentionally opt-in:

```bash
pnpm test:youtube
```

The live YouTube integration tests resolve a 100-track playlist and download the provider-managed stream for one video. The playback test requires FFmpeg on the system `PATH` or as `./ffmpeg` in the working directory to decode the complete track. These tests do not connect to Discord and are not included in `pnpm test` or `pnpm check`.

## Architecture

```text
src/
├── main.ts                     Discord client and lifecycle
├── commands/                   Slash-command definitions and handlers
├── presentation/               Discord formatting and response builders
├── providers/
│   ├── youtube.ts              Provider-neutral Track adapter
│   └── youtube-engine.ts       YouTube.js metadata and media transport
├── playback-manager.ts         Per-server queues and playback lifecycle
├── playback-runtime.ts         Discord voice connection and audio player
├── audio/ffmpeg.ts             FFmpeg-to-PCM pipeline
├── media.ts                    MediaProvider and Track contracts
├── config.ts                   Environment validation
└── logger.ts                   Structured JSON logging
```
