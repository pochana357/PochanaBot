// Package Dependencies
const { Client, GatewayIntentBits } = require('discord.js');
const { DisTube } = require('distube');
const { YouTubePlugin } = require('@distube/youtube');
const { SpotifyPlugin } = require("@distube/spotify");
const ffmpegPath = require('ffmpeg-static');

// Local Project Dependencies
const { logMessage, logError } = require('./libs/logger');
const { getTimeoutMinutes, setTimeoutMinutes, getInactivityTimeout, setInactivityTimeout } = require('./libs/serverSettings');
const { getDiscordToken, getBotAdminId, getDebugLoggingMode, setDebugLoggingMode } = require('./libs/adminSettings');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const distube = new DisTube(client, {
    plugins: [
        new YouTubePlugin(),
        new SpotifyPlugin()
    ],
    ffmpeg: {
        path: ffmpegPath,
        options: "-loglevel debug"
    }
});

const emoji = { play: '<:pkm_pochiena07:1242333077129265282>', stop: '<:pkm_pochiena06:1242333081046614016>', error: '<:pkm_pochiena10:1242333629397340281>', general: '<:pkm_pochiena05:1242333078849064960>' };
const sticker = { enter: '1277193362327474249', leave: '1277193575561429164' };

client.once('ready', () => {
    logMessage(`${client.user.tag} is online and ready!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/g);
    const command = args.shift()?.toLowerCase();

    const userVoiceChannel = message.member?.voice?.channel;
    if (!userVoiceChannel) {
        return message.reply(`${emoji.error} You must be in a voice channel to use commands.`);
    }

    const server = userVoiceChannel.guild;
    const queue = distube.getQueue(userVoiceChannel);
    if (queue &&
        queue?.voice?.channel.id != userVoiceChannel.id &&
        command != 'help') {
        return message.reply(`${emoji.error} You must be in the bot's voice channel \`${queue?.voice?.channel.name}\` to use this command.`);
    }

    try {

        logMessage(`${server.name}: ${message.author.displayName} issued command "${message.content}"`);

        switch (command) {
            case 'play':

                if (args.length < 1) return message.reply(`${emoji.error} Please provide a YouTube/Spotify URL or search query.`);

                const loadingMsg = await message.channel.send(`${emoji.general} Loading song. Please wait a moment...`);

                await distube.play(userVoiceChannel, args.join(' '), {
                    textChannel: message.channel,
                    member: message.member,
                });

                loadingMsg.delete();

                break;
            case 'pause':

                if (!queue) return message.reply(`${emoji.error} The queue is empty, so there is nothing to pause.`);
                if (queue.paused) return message.reply(`${emoji.error} Music is already paused.`);

                queue.pause();

                message.channel.send(`${emoji.error} Playback has been paused.`);

                break;
            case 'resume':

                if (!queue) return message.reply(`${emoji.error} The queue is empty, so there is nothing to resume.`);
                if (!queue.paused) return message.reply(`${emoji.error} Music is already playing.`);

                queue.resume();

                message.channel.send(`${emoji.play} Playback resumed.`);

                break;
            case 'stop':

                if (!queue) return message.reply(`${emoji.error} There is no music playing to stop.`);

                queue.stop();

                message.channel.send(`${emoji.error} Music has been stopped, and the queue has been cleared.`);

                triggerInactivity(server, queue.textChannel);

                break;
            case 'kill':

                distube.voices.get(server.id)?.leave();

                message.channel.send(`${emoji.general} Goodbye!`);

                break;
            case 'skip':

                if (!queue) return message.reply(`${emoji.error} The queue is empty, so there is nothing to skip to.`);

                if (queue.songs.length <= 1) {
                    return message.reply(`${emoji.error} You are at the end of the queue, so there is nothing to skip to.`);
                }

                await queue.skip();
                await message.channel.send(`${emoji.error} Skipping to the next song...`);

                break;
            case 'rewind':

                if (!queue) return message.reply(`${emoji.error} The queue is empty, so there is nothing to rewind to.`);

                if (queue.previousSongs.length <= 0) {
                    return message.reply(`${emoji.error} You are at the beginning of the queue, so there is nothing to rewind to.`);
                }

                await queue.previous();
                await message.channel.send(`${emoji.error} Rewinding to the previous song...`);

                break;
            case 'queue':

                if (!queue) return message.channel.send(`${emoji.error} The queue is empty.`);

                var queueString = `**Current Queue:**\n` +
                    queue.songs
                        .map((song, index) => `${index + 1}. ${song.name} - \`${song.formattedDuration}\``)
                        .join('\n');

                // Respect Discord message limit (2000);
                queueString = queueString.length >= 1900 ? `${queueString.slice(0, 1897)}...` : queueString;

                message.channel.send(`${emoji.general} ${queueString}`);

                break;
            case 'debug':

                if (message.author.id != getBotAdminId()) return message.reply(`${emoji.error} Only the bot administrator may set a debug logging mode.`);

                if (args.length < 1) return message.reply(`${emoji.error} Setting a debug logging mode requires a value.`);

                const mode = args[0].toLowerCase();

                switch (mode) {
                    case 'off':
                    case 'on':
                    case 'verbose':

                        setDebugLoggingMode(mode);

                        message.channel.send(`${emoji.general} Debug logging mode set to \`${mode.toUpperCase()}\`.`);

                        break;
                    default:

                        return message.reply(`${emoji.error} Invalid debug mode value.`);
                }

                break;
            case 'timeout':

                if (args.length < 1) return message.reply(`${emoji.error} Setting a timeout requires a value.`);

                const number = parseInt(args[0]);
                if (!isNaN(number) && number >= 0 && number <= 60) {
                    setTimeoutMinutes(server.id, number);

                    message.channel.send(`${emoji.general} Inactivity timeout set to \`${number} minutes\`.`);
                } else {
                    return message.reply(`${emoji.error} Invalid timeout value.`);
                }

                break;
            case 'help':

                message.channel.send('```Available commands are:\n\n' +
                    'Music:\n' +
                    '!play {url|search term} - Plays a YouTube/Spotify URL or search term. The song is added to the queue if a song is playing.\n' +
                    '!pause - Pauses current playback.\n' +
                    '!resume - Resumes playback.\n' +
                    '!stop - Stops any current music and clears the queue.\n' +
                    '!kill - Disconnects the bot from the voice channel.\n' +
                    '!skip - Plays the next song in the queue.\n' +
                    '!rewind - Plays the previous song in the queue.\n' +
                    '!queue - Displays the current queue.\n\n' +
                    'Other:\n' +
                    '!help - Displays the list of available commands.\n' +
                    '!timeout {minutes (0-60)} - Sets the time the bot will wait to disconnect after the queue completes.```');

                break;
        }
    } catch (error) {
        message.reply(`${emoji.error} An error occurred while processing your command: ${error.message}`);
        logError(`${server.name}: Error in command "${message.content}":`, error);
    }
});

// Listen for voice state updates
client.on('voiceStateUpdate', async (oldState, newState) => {
    // Get a text channel to send the sticker in
    const guildName = newState.guild.name;
    const textChannel = newState.guild.channels.cache.find(
        channel => channel.type === 0 && channel.name === "bot" && channel.permissionsFor(client.user).has('SendMessages')
    );

    if (!textChannel) {
        logError(`{guildName}: Couldn't find a text channel to send the sticker in.`);
        return;
    }

    // Check if it's the bot that joined a voice channel
    if (newState.member.user.id === client.user.id && newState.channelId && !oldState.channelId) {
      // Bot has joined a voice channel
      await textChannel.send({stickers: [sticker.enter]});
    }

    // Check if it's the bot that left a voice channel
    if (oldState.member.user.id === client.user.id && oldState.channelId && !newState.channelId) {
      // Bot has left a voice channel
      await textChannel.send({stickers: [sticker.leave]});
    }
});

distube.on('playSong', (queue, song) => {
    const server = getServerInfo(queue);
    triggerActivity(server);

    queue.textChannel.send(`${emoji.play} Playing \`${song.name}\` - \`${song.formattedDuration}\``);
    logMessage(`${server.name}: Playing song: ${song.name} - ${song.formattedDuration}`);
});

distube.on('addSong', (queue, song) => {
    if (queue.songs.length > 1) {
        const server = getServerInfo(queue);

        queue.textChannel.send(`${emoji.play} Added \`${song.name}\` - \`${song.formattedDuration}\` to the queue!`);
        logMessage(`${server.name}: Added song: ${song.name} - ${song.formattedDuration}`);
    }
});

distube.on('finish', (queue) => {
    const server = getServerInfo(queue);

    logMessage(`${server.name}: Finished song queue`);

    triggerInactivity(server, queue.textChannel);
});

distube.on('error', (error, queue) => {
    if (queue && queue.textChannel) {
        const server = getServerInfo(queue);

        queue.textChannel.send(`${emoji.error} Music playback encountered an error: ${error.message}`);
        logError(`${server.name}: DisTube Error:`, error);
    } else {
        logError(`DisTube Error:`, error);
    }
});

distube.on('debug', (message) => {
    let debugLoggingMode = getDebugLoggingMode();

    if (debugLoggingMode == 'on' || debugLoggingMode == 'verbose') {
        logMessage(`DEBUG: ${message}`);
    }
});

distube.on('ffmpegDebug', (message) => {
    let debugLoggingMode = getDebugLoggingMode();

    if (debugLoggingMode == 'verbose') {
        logMessage(`FFMPEG DEBUG: ${message}`);
    }
});

function getServerInfo(queue) {
    return queue.textChannel.guild;
};

function triggerActivity(server) {
    let inactivityTimeout = getInactivityTimeout(server.id);

    if (inactivityTimeout) {
        clearTimeout(inactivityTimeout);
        setInactivityTimeout(server.id, null);
    }
};

function triggerInactivity(server, textChannel) {
    let minutes = getTimeoutMinutes(server.id);

    let inactivityTimeout = createInactivityTimeout(server, textChannel, minutes);

    setInactivityTimeout(server.id, inactivityTimeout);
};

function createInactivityTimeout(server, textChannel, minutes) {
    return setTimeout(function () {
        logMessage(`${server.name}: Inactivity timeout reached (${minutes} minutes). Bot disconnected.`);
        textChannel.send(`${emoji.general} Looks like you're done playing music for now. Goodbye!`);

        distube.voices.get(server.id)?.leave();

        setInactivityTimeout(server.id, null);
    }, minutes * 60 * 1000);
};

client.login(getDiscordToken());