require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const SCHEDULE_URL = 'https://raw.githubusercontent.com/stw222/stw222-schedule/main/data/schedule.json';
const REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const categoryEmojis = {
  atc: '📡',
  flying: '✈️',
  minecraft: '⛏️',
  other: '🎮'
};

async function fetchSchedule() {
  const response = await fetch(SCHEDULE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch schedule: ${response.status}`);
  }
  return response.json();
}

function parseStreamDateTime(stream, timezone) {
  // Parse as Eastern Time (America/New_York)
  const dateStr = `${stream.date}T${stream.startTime}:00`;
  const date = new Date(dateStr + '-05:00'); // EST offset
  return date;
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

function createStreamEmbed(stream, streamer, categories) {
  const category = categories[stream.category] || categories.other;
  const emoji = categoryEmojis[stream.category] || '🎮';
  const timestamp = Math.floor(stream.dateTime.getTime() / 1000);

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
    .setFooter({ text: `${streamer.displayName} • ${streamer.description}` });

  if (stream.image) {
    embed.setImage(stream.image);
  }

  return embed;
}

async function clearChannel(channel) {
  let deleted;
  do {
    deleted = await channel.bulkDelete(100, true);
  } while (deleted.size > 0);

  // For messages older than 14 days, delete individually
  const remaining = await channel.messages.fetch({ limit: 100 });
  for (const message of remaining.values()) {
    await message.delete().catch(() => {});
  }
}

async function postScheduleToChannel() {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error('Invalid channel ID or channel is not text-based');
      return;
    }

    console.log(`Updating schedule in #${channel.name}...`);

    // Clear all messages
    await clearChannel(channel);

    // Fetch and post schedule
    const scheduleData = await fetchSchedule();
    const upcomingStreams = getUpcomingStreams(scheduleData);

    if (upcomingStreams.length === 0) {
      await channel.send('No upcoming streams scheduled!');
      return;
    }

    // Post each stream as a separate embed
    for (const stream of upcomingStreams) {
      const embed = createStreamEmbed(stream, scheduleData.streamer, scheduleData.categories);
      await channel.send({ embeds: [embed] });
    }

    console.log(`Posted ${upcomingStreams.length} upcoming streams to #${channel.name}`);
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
