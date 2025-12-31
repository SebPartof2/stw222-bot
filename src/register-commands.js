require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Show upcoming streams')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Number of streams to show (default: 5, max: 10)')
        .setMinValue(1)
        .setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName('nextstream')
    .setDescription('Show the next upcoming stream')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Refresh the schedule channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('hardreset')
    .setDescription('Clear channel and repost all streams')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.error('DISCORD_TOKEN and CLIENT_ID are required in .env');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('Registering slash commands...');

    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands.map(cmd => cmd.toJSON()) }
      );
      console.log(`Commands registered to guild ${guildId} (instant)`);
    } else {
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands.map(cmd => cmd.toJSON()) }
      );
      console.log('Commands registered globally (may take up to 1 hour)');
    }
  } catch (error) {
    console.error('Error registering commands:', error);
    process.exit(1);
  }
}

registerCommands();
