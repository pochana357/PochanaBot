import { config as loadDotenv } from 'dotenv';

loadDotenv({ override: true, quiet: true });

export function requireEnvironment(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function requireDiscordId(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = requireEnvironment(name, environment);
  if (!/^\d{17,20}$/.test(value)) {
    throw new Error(`${name} must be a Discord ID containing 17 to 20 digits.`);
  }
  return value;
}
