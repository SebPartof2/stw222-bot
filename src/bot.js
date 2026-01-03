require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const crypto = require('crypto');

const SCHEDULE_URL = 'https://raw.githubusercontent.com/stw222/stw222-schedule/main/data/schedule.json';
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const TIMEZONE = 'America/Louisville';

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const categoryEmojis = {
  atc: '<:radar:1455791581268541556>',
  flying: '<:airplane:1455791579032977671>',
  minecraft: '<:minecraft:1455791577816502384>',
  other: '<:tooltipquestion:1455791783538724914>'
};

async function fetchSchedule() {
  const response = await fetch(SCHEDULE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch schedule: ${response.status}`);
  }
  return response.json();
}

function parseStreamDateTime(stream) {
  // Parse date parts and pad with zeros if needed
  const [year, month, day] = stream.date.split('-');
  const paddedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

  // Create date string and parse in Louisville timezone
  const dateStr = `${paddedDate}T${stream.startTime}:00`;

  // Use Intl to get the UTC offset for Louisville at this date/time
  const tempDate = new Date(dateStr + 'Z');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });

  // Calculate offset by comparing UTC interpretation with Louisville interpretation
  const parts = formatter.formatToParts(tempDate);
  const getPart = (type) => parts.find(p => p.type === type)?.value;
  const louisvilleStr = `${getPart('year')}-${getPart('month')}-${getPart('day')}T${getPart('hour')}:${getPart('minute')}:${getPart('second')}Z`;
  const louisvilleAsUtc = new Date(louisvilleStr);
  const offsetMs = louisvilleAsUtc - tempDate;

  // Apply offset to get correct UTC time (subtract because we're converting FROM Louisville TO UTC)
  return new Date(tempDate.getTime() - offsetMs);
}

function getUpcomingStreams(scheduleData) {
  const now = new Date();

  return scheduleData.streams
    .map(stream => ({
      ...stream,
      dateTime: parseStreamDateTime(stream)
    }))
    .filter(stream => stream.dateTime > now)
    .sort((a, b) => a.dateTime - b.dateTime);
}

function getStreamId(stream) {
  // Base ID for stream (date|time) - used for date comparison
  return `${stream.date}|${stream.startTime}`;
}

function getStreamHash(stream) {
  // Hash of all content fields to detect changes
  const content = [
    stream.date,
    stream.startTime,
    stream.title,
    stream.description || '',
    stream.image || '',
    stream.category
  ].join('|');
  return crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
}

function getStreamKey(stream) {
  // Full key: date|time|hash
  return `${getStreamId(stream)}|${getStreamHash(stream)}`;
}

const HEADER_FOOTER = 'schedule-header';

function createFooterEmbed() {
  return new EmbedBuilder()
    .setTitle('📺 Upcoming Streams')
    .setDescription('See full schedule above!\n\n**Website:** https://schedule.stw222.live/')
    .setColor(0x9146FF)
    .setFooter({ text: HEADER_FOOTER });
}

function isHeaderMessage(message) {
  if (!message.embeds || message.embeds.length === 0) return false;
  return message.embeds[0].footer?.text === HEADER_FOOTER;
}

function createStreamEmbed(stream, streamer, categories) {
  const category = categories[stream.category] || categories.other;
  const emoji = categoryEmojis[stream.category] || '🎮';
  const timestamp = Math.floor(stream.dateTime.getTime() / 1000);
  const streamKey = getStreamKey(stream);

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} ${stream.title}`)
    .setColor(category.color)
    .setDescription(stream.description || 'No description available')
    .addFields(
      {
        name: '📅 Date & Time',
        value: `<t:${timestamp}:F>`,
        inline: true
      },
      {
        name: '⏰ Countdown',
        value: `<t:${timestamp}:R>`,
        inline: true
      },
      {
        name: '🏷️ Category',
        value: stream.category.charAt(0).toUpperCase() + stream.category.slice(1),
        inline: true
      }
    )
    // Store stream key in footer for identification
    .setFooter({ text: `${streamer.displayName} | ${streamKey}` });

  if (stream.image) {
    embed.setImage(stream.image);
  }

  return embed;
}

function extractStreamKeyFromMessage(message) {
  // Extract full stream key from embed footer
  if (!message.embeds || message.embeds.length === 0) return null;
  const footer = message.embeds[0].footer?.text;
  if (!footer || !footer.includes('|')) return null;
  const parts = footer.split('|');
  if (parts.length < 2) return null;
  return parts.slice(1).join('|').trim();
}

function extractStreamIdFromKey(streamKey) {
  // Extract base ID (date|time) from full key (date|time|hash)
  const parts = streamKey.split('|');
  if (parts.length < 2) return null;
  return `${parts[0]}|${parts[1]}`;
}

function parseStreamKeyToDate(streamKey) {
  // Parse stream key to Date object (works with both date|time and date|time|hash)
  const [date, time] = streamKey.split('|');
  if (!date || !time) return null;
  const [year, month, day] = date.split('-');
  const paddedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return new Date(`${paddedDate}T${time}:00-05:00`);
}

async function clearChannel(channel) {
  let messages = await channel.messages.fetch({ limit: 100 });

  while (messages.size > 0) {
    const now = Date.now();
    const twoWeeks = 14 * 24 * 60 * 60 * 1000;

    const recent = messages.filter(m => now - m.createdTimestamp < twoWeeks);
    const old = messages.filter(m => now - m.createdTimestamp >= twoWeeks);

    if (recent.size > 0) {
      await channel.bulkDelete(recent).catch(() => {});
    }

    for (const message of old.values()) {
      await message.delete().catch(() => {});
    }

    messages = await channel.messages.fetch({ limit: 100 });
  }
}

async function hardResetChannel() {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error('Invalid channel ID or channel is not text-based');
      return;
    }

    console.log(`Hard reset: clearing #${channel.name}...`);
    await clearChannel(channel);

    const scheduleData = await fetchSchedule();
    const upcomingStreams = getUpcomingStreams(scheduleData);

    if (upcomingStreams.length === 0) {
      await channel.send('No upcoming streams scheduled!');
      return;
    }

    console.log(`Posting ${upcomingStreams.length} streams...`);

    for (let i = 0; i < upcomingStreams.length; i++) {
      const stream = upcomingStreams[i];
      const embed = createStreamEmbed(stream, scheduleData.streamer, scheduleData.categories);
      await channel.send({ embeds: [embed] });
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Post footer last
    await channel.send({ embeds: [createFooterEmbed()] });

    console.log(`Hard reset complete in #${channel.name}`);
  } catch (error) {
    console.error('Error during hard reset:', error);
  }
}

async function postScheduleToChannel(forceRefresh = false) {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error('Invalid channel ID or channel is not text-based');
      return;
    }

    console.log(`Updating schedule in #${channel.name}...`);

    // Fetch current schedule
    const scheduleData = await fetchSchedule();
    const upcomingStreams = getUpcomingStreams(scheduleData);

    // Create set of expected stream keys
    const upcomingKeys = upcomingStreams.map(s => getStreamKey(s));

    // Fetch existing messages
    const messages = await channel.messages.fetch({ limit: 100 });
    const now = new Date();
    const streamMessages = [];
    let headerMessage = null;

    // Collect stream messages and check header
    for (const message of messages.values()) {
      if (message.author.id !== client.user.id) continue;

      if (isHeaderMessage(message)) {
        headerMessage = message;
        continue;
      }

      streamMessages.push(message);
    }

    // Get existing keys in message order (oldest first)
    streamMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const existingKeys = streamMessages
      .map(m => extractStreamKeyFromMessage(m))
      .filter(k => k !== null);

    // Check if streams match in order
    const streamsMatch = existingKeys.length === upcomingKeys.length &&
      existingKeys.every((key, i) => key === upcomingKeys[i]);

    if (streamsMatch && headerMessage) {
      console.log('No changes needed');
      return;
    }

    // Something changed - clear channel and repost
    console.log('Changes detected, clearing channel...');
    await clearChannel(channel);

    // Post all streams in order
    console.log(`Posting ${upcomingStreams.length} streams...`);
    for (let i = 0; i < upcomingStreams.length; i++) {
      const stream = upcomingStreams[i];
      console.log(`Posting: ${stream.title} on ${stream.date}`);
      const embed = createStreamEmbed(stream, scheduleData.streamer, scheduleData.categories);
      await channel.send({ embeds: [embed] });
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Post footer last
    await channel.send({ embeds: [createFooterEmbed()] });

    console.log(`Schedule updated in #${channel.name}`);
  } catch (error) {
    console.error('Error posting schedule to channel:', error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Post schedule to channel on startup
  await postScheduleToChannel();

  // Refresh schedule periodically
  if (process.env.CHANNEL_ID) {
    setInterval(postScheduleToChannel, REFRESH_INTERVAL);
    console.log(`Schedule will refresh every ${REFRESH_INTERVAL / 60000} minutes`);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'refresh') {
      await interaction.deferReply({ ephemeral: true });
      await postScheduleToChannel();
      await interaction.editReply('Schedule channel refreshed!');
      return;
    }

    if (interaction.commandName === 'hardreset') {
      await interaction.deferReply({ ephemeral: true });
      await hardResetChannel();
      await interaction.editReply('Schedule channel cleared and rebuilt!');
      return;
    }

    const scheduleData = await fetchSchedule();
    const upcomingStreams = getUpcomingStreams(scheduleData);

    if (interaction.commandName === 'schedule') {
      const limit = interaction.options.getInteger('limit') || 5;

      if (upcomingStreams.length === 0) {
        await interaction.reply('No upcoming streams scheduled!');
        return;
      }

      const streamsToShow = upcomingStreams.slice(0, limit);
      const embeds = streamsToShow.map(stream =>
        createStreamEmbed(stream, scheduleData.streamer, scheduleData.categories)
      );

      await interaction.reply({ embeds });
    }

    if (interaction.commandName === 'nextstream') {
      if (upcomingStreams.length === 0) {
        await interaction.reply('No upcoming streams scheduled!');
        return;
      }

      const nextStream = upcomingStreams[0];
      const embed = createStreamEmbed(nextStream, scheduleData.streamer, scheduleData.categories);

      await interaction.reply({ embeds: [embed] });
    }
  } catch (error) {
    console.error('Error handling command:', error);
    if (interaction.deferred) {
      await interaction.editReply('An error occurred while processing the command.');
    } else {
      await interaction.reply({
        content: 'An error occurred while fetching the schedule.',
        ephemeral: true
      });
    }
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN environment variable is required!');
  console.error('Create a .env file with: DISCORD_TOKEN=your_bot_token_here');
  process.exit(1);
}

client.login(token);
