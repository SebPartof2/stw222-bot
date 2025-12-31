require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const SCHEDULE_URL = 'https://raw.githubusercontent.com/stw222/stw222-schedule/main/data/schedule.json';
const REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

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

function parseStreamDateTime(stream, timezone) {
  // Parse date parts and pad with zeros if needed
  const [year, month, day] = stream.date.split('-');
  const paddedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

  // Parse as Eastern Time (America/New_York)
  const dateStr = `${paddedDate}T${stream.startTime}:00-05:00`;
  return new Date(dateStr);
}

function getUpcomingStreams(scheduleData) {
  const now = new Date();

  return scheduleData.streams
    .map(stream => ({
      ...stream,
      dateTime: parseStreamDateTime(stream, scheduleData.timezone)
    }))
    .filter(stream => stream.dateTime > now)
    .sort((a, b) => a.dateTime - b.dateTime);
}

function getStreamKey(stream) {
  // Unique key for each stream based on date and time
  return `${stream.date}|${stream.startTime}`;
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
  // Extract stream key from embed footer
  if (!message.embeds || message.embeds.length === 0) return null;
  const footer = message.embeds[0].footer?.text;
  if (!footer || !footer.includes('|')) return null;
  const parts = footer.split('|');
  if (parts.length < 2) return null;
  return parts.slice(1).join('|').trim();
}

function parseStreamKeyToDate(streamKey) {
  // Parse stream key (date|time) to Date object
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
      if (i < upcomingStreams.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

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
    const upcomingKeys = new Set(upcomingStreams.map(s => getStreamKey(s)));

    // Fetch existing messages
    const messages = await channel.messages.fetch({ limit: 100 });
    const now = new Date();
    const existingKeys = new Set();
    const messagesToDelete = [];

    // Check each message
    for (const message of messages.values()) {
      // Only process bot's own messages with embeds
      if (message.author.id !== client.user.id) continue;

      const streamKey = extractStreamKeyFromMessage(message);
      if (!streamKey) {
        messagesToDelete.push(message);
        continue;
      }

      const streamDate = parseStreamKeyToDate(streamKey);
      if (!streamDate || streamDate < now) {
        // Stream is in the past, delete it
        console.log(`Removing past stream: ${streamKey}`);
        messagesToDelete.push(message);
      } else if (!upcomingKeys.has(streamKey)) {
        // Stream was removed from schedule
        console.log(`Removing deleted stream: ${streamKey}`);
        messagesToDelete.push(message);
      } else {
        // Stream still upcoming, keep it
        existingKeys.add(streamKey);
      }
    }

    // Delete old/removed messages
    for (const message of messagesToDelete) {
      await message.delete().catch(() => {});
    }

    // Find new streams to add
    const newStreams = upcomingStreams.filter(s => !existingKeys.has(getStreamKey(s)));

    if (newStreams.length === 0 && messagesToDelete.length === 0) {
      console.log('No changes needed');
      return;
    }

    console.log(`Removed ${messagesToDelete.length} messages, adding ${newStreams.length} new streams`);

    // Post new streams
    for (let i = 0; i < newStreams.length; i++) {
      const stream = newStreams[i];
      console.log(`Posting: ${stream.title} on ${stream.date}`);
      const embed = createStreamEmbed(stream, scheduleData.streamer, scheduleData.categories);
      await channel.send({ embeds: [embed] });
      if (i < newStreams.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

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
