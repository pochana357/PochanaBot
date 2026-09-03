import { REST, Routes } from 'discord.js';
import {
  commandPayloadsFor,
  type CommandDeploymentTarget,
} from './commands/catalog.js';
import { requireDiscordId, requireEnvironment } from './config.js';
import { logger } from './logger.js';

const target = process.argv[2] as CommandDeploymentTarget | undefined;
if (target !== 'test' && target !== 'global') {
  throw new Error('Usage: node dist/deploy-commands.js <test|global>');
}

const token = requireEnvironment('DISCORD_TOKEN');
const applicationId = requireDiscordId('DISCORD_CLIENT_ID');
const commands = commandPayloadsFor(target);
const route =
  target === 'test'
    ? Routes.applicationGuildCommands(
        applicationId,
        requireDiscordId('DISCORD_TEST_GUILD_ID'),
      )
    : Routes.applicationCommands(applicationId);

const rest = new REST({ version: '10' }).setToken(token);
await rest.put(route, { body: commands });
logger.info('commands_deployed', { count: commands.length, target });
