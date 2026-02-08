require('dotenv').config();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const config = {
  discordToken: requiredEnv('DISCORD_TOKEN'),
  guildId: process.env.GUILD_ID || null,
  staffRoleId: process.env.STAFF_ROLE_ID || null,
  memberRoleId: process.env.MEMBER_ROLE_ID || null,
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID || null,
  ticketCategoryId: process.env.TICKET_CATEGORY_ID || null,
  storefrontChannelId: process.env.STOREFRONT_CHANNEL_ID || null,
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  databaseUrl: requiredEnv('DATABASE_URL'),
  storeName: process.env.STORE_NAME || 'Eclipse',
  currency: process.env.CURRENCY || 'EUR',
  storefrontRefreshMinutes: Number(process.env.STOREFRONT_REFRESH_MINUTES || 5)
};

module.exports = config;
