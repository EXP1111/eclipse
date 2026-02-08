const {
  Client,
  GatewayIntentBits,
  Partials,
  Routes,
  REST,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require('discord.js');
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function query(text, params) {
  return pool.query(text, params);
}

async function getSetting(key) {
  const result = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return result.rows[0]?.value || null;
}

async function setSetting(key, value) {
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

async function ensureDefaultProducts() {
  const defaults = [
    { name: 'EH Accounts - 1M Cash', priceCents: 349 },
    { name: 'EH Accounts - 5M Cash', priceCents: 499 },
    { name: 'EH Accounts - 10M Cash', priceCents: 999 }
  ];

  for (const item of defaults) {
    await query(
      'INSERT INTO products (name, price_cents) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [item.name, item.priceCents]
    );
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const commandData = [
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Manage product keys')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add keys to a product')
        .addStringOption((opt) => opt.setName('product').setDescription('Product name').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('keys').setDescription('One key per line').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove keys from a product')
        .addStringOption((opt) => opt.setName('product').setDescription('Product name').setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName('count').setDescription('How many available keys to remove').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Show stock counts')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('order')
    .setDescription('Order actions')
    .addSubcommand((sub) =>
      sub
        .setName('deliver')
        .setDescription('Deliver a key to a user')
        .addUserOption((opt) => opt.setName('buyer').setDescription('Buyer').setRequired(true))
        .addStringOption((opt) => opt.setName('product').setDescription('Product name').setRequired(true))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket actions')
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Post the ticket panel in this channel')
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close this ticket')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  if (!config.guildId) {
    return;
  }
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commandData });
}

async function logEvent(message) {
  if (!config.logChannelId) {
    return;
  }
  const channel = await client.channels.fetch(config.logChannelId).catch(() => null);
  if (channel) {
    channel.send({ content: message }).catch(() => null);
  }
}

async function buildStorefrontEmbed() {
  const products = await query(
    "SELECT p.id, p.name, p.price_cents, COUNT(k.id) FILTER (WHERE k.status = 'available') AS stock FROM products p LEFT JOIN stock_keys k ON k.product_id = p.id GROUP BY p.id ORDER BY p.price_cents ASC"
  );

  const embed = new EmbedBuilder()
    .setTitle(`${config.storeName} Storefront`)
    .setColor(0x1f2937)
    .setDescription('Live stock and prices. Open a ticket to buy.');

  for (const row of products.rows) {
    const price = (row.price_cents / 100).toFixed(2);
    embed.addFields({
      name: row.name,
      value: `Price: ${price} ${config.currency}\nStock: ${row.stock}`,
      inline: false
    });
  }

  return embed;
}

async function updateStorefront() {
  if (!config.storefrontChannelId) {
    return;
  }

  const channel = await client.channels.fetch(config.storefrontChannelId).catch(() => null);
  if (!channel) {
    return;
  }

  const embed = await buildStorefrontEmbed();
  const settingsKey = 'storefront_message_id';
  const existingId = await getSetting(settingsKey);

  if (existingId) {
    const message = await channel.messages.fetch(existingId).catch(() => null);
    if (message) {
      await message.edit({ embeds: [embed] });
      return;
    }
  }

  const sent = await channel.send({ embeds: [embed] });
  await setSetting(settingsKey, sent.id);
}

function ticketPanelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_purchase')
      .setLabel('Purchase')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket_support')
      .setLabel('Support')
      .setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

async function handleCreateTicket(interaction, category) {
  if (!config.ticketCategoryId) {
    await interaction.reply({ content: 'Ticket category is not configured yet.', ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  const channelName = `ticket-${category}-${interaction.user.username}`.toLowerCase();

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ...(config.staffRoleId
        ? [{ id: config.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }]
        : [])
    ]
  });

  await query(
    'INSERT INTO tickets (channel_id, user_id, category) VALUES ($1, $2, $3) ON CONFLICT (channel_id) DO NOTHING',
    [channel.id, interaction.user.id, category]
  );

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: `Welcome ${interaction.user}, a staff member will assist you shortly.`,
    components: [closeRow]
  });

  await interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
  await logEvent(`Ticket opened by ${interaction.user.tag} (${category})`);
}

async function handleCloseTicket(interaction) {
  const channel = interaction.channel;
  await query('UPDATE tickets SET status = $1, closed_at = NOW() WHERE channel_id = $2', ['closed', channel.id]);
  await interaction.reply({ content: 'Closing ticket in 5 seconds.' });
  await logEvent(`Ticket closed by ${interaction.user.tag} in ${channel.name}`);
  setTimeout(() => channel.delete().catch(() => null), 5000);
}

async function addStock(productName, keysText) {
  const productResult = await query('SELECT id FROM products WHERE name = $1', [productName]);
  const product = productResult.rows[0];
  if (!product) {
    throw new Error('Product not found. Check the exact name.');
  }

  const keys = keysText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!keys.length) {
    return 0;
  }

  const values = keys.map((_, idx) => `($1, $${idx + 2})`).join(', ');
  await query(`INSERT INTO stock_keys (product_id, key_text) VALUES ${values}`, [product.id, ...keys]);
  return keys.length;
}

async function removeStock(productName, count) {
  const productResult = await query('SELECT id FROM products WHERE name = $1', [productName]);
  const product = productResult.rows[0];
  if (!product) {
    throw new Error('Product not found. Check the exact name.');
  }

  const removed = await query(
    "DELETE FROM stock_keys WHERE id IN (SELECT id FROM stock_keys WHERE product_id = $1 AND status = 'available' LIMIT $2) RETURNING id",
    [product.id, count]
  );
  return removed.rowCount || 0;
}

async function deliverKey(buyer, productName, ticketChannel) {
  const productResult = await query('SELECT id, price_cents FROM products WHERE name = $1', [productName]);
  const product = productResult.rows[0];
  if (!product) {
    throw new Error('Product not found. Check the exact name.');
  }

  const keyResult = await query(
    "SELECT id, key_text FROM stock_keys WHERE product_id = $1 AND status = 'available' ORDER BY id ASC LIMIT 1",
    [product.id]
  );
  const keyRow = keyResult.rows[0];
  if (!keyRow) {
    throw new Error('No available stock for this product.');
  }

  const orderResult = await query(
    'INSERT INTO orders (user_id, product_id, key_id, status, delivered_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
    [buyer.id, product.id, keyRow.id, 'delivered']
  );

  await query(
    "UPDATE stock_keys SET status = 'sold', sold_at = NOW() WHERE id = $1",
    [keyRow.id]
  );

  const message = `Your ${productName} key: ${keyRow.key_text}`;
  let deliveredViaDm = true;
  try {
    await buyer.send({ content: message });
  } catch (error) {
    deliveredViaDm = false;
  }

  if (!deliveredViaDm && ticketChannel) {
    await ticketChannel.send({ content: `${buyer}, DM failed. Here is your key: ${keyRow.key_text}` });
  }

  await logEvent(`Delivered order #${orderResult.rows[0].id} to ${buyer.tag} (${productName})`);
  return deliveredViaDm;
}

client.once('ready', async () => {
  await ensureDefaultProducts();
  await registerCommands();
  await updateStorefront();

  setInterval(() => {
    updateStorefront().catch(() => null);
  }, config.storefrontRefreshMinutes * 60 * 1000);

  console.log(`Logged in as ${client.user.tag}`);
});

client.on('guildMemberAdd', async (member) => {
  if (config.memberRoleId) {
    member.roles.add(config.memberRoleId).catch(() => null);
  }

  if (config.welcomeChannelId) {
    const channel = await client.channels.fetch(config.welcomeChannelId).catch(() => null);
    if (channel) {
      const message = `👋 Welcome to ${member.guild.name}, ${member}! You're the ${member.guild.memberCount}th member.`;
      channel.send({ content: message }).catch(() => null);
    }
  }

  member
    .send({
      content: `👋 Welcome to ${config.storeName}! You can open a ticket in the server or DM a staff member.
https://discord.gg/eclipse-hq`
    })
    .catch(() => null);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticket') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'setup') {
          await interaction.reply({
            content: 'Select a category to open a ticket.',
            components: ticketPanelComponents()
          });
        } else if (sub === 'close') {
          await handleCloseTicket(interaction);
        }
      }

      if (interaction.commandName === 'stock') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const product = interaction.options.getString('product');
          const keys = interaction.options.getString('keys');
          const added = await addStock(product, keys);
          await interaction.reply({ content: `Added ${added} keys to ${product}.`, ephemeral: true });
          await updateStorefront();
        }
        if (sub === 'remove') {
          const product = interaction.options.getString('product');
          const count = interaction.options.getInteger('count');
          const removed = await removeStock(product, count);
          await interaction.reply({ content: `Removed ${removed} keys from ${product}.`, ephemeral: true });
          await updateStorefront();
        }
        if (sub === 'list') {
          const result = await query(
            "SELECT p.name, COUNT(k.id) FILTER (WHERE k.status = 'available') AS stock FROM products p LEFT JOIN stock_keys k ON k.product_id = p.id GROUP BY p.id ORDER BY p.price_cents ASC"
          );
          const lines = result.rows.map((row) => `${row.name}: ${row.stock}`);
          await interaction.reply({ content: lines.join('\n') || 'No products.', ephemeral: true });
        }
      }

      if (interaction.commandName === 'order') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'deliver') {
          const buyer = interaction.options.getUser('buyer');
          const product = interaction.options.getString('product');
          const deliveredViaDm = await deliverKey(buyer, product, interaction.channel);
          await interaction.reply({
            content: deliveredViaDm
              ? `Delivered key to ${buyer.tag}.`
              : `DM failed. Key sent in this ticket to ${buyer.tag}.`,
            ephemeral: true
          });
          await updateStorefront();
        }
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'ticket_purchase') {
        await handleCreateTicket(interaction, 'purchase');
      }
      if (interaction.customId === 'ticket_support') {
        await handleCreateTicket(interaction, 'support');
      }
      if (interaction.customId === 'ticket_close') {
        await handleCloseTicket(interaction);
      }
    }
  } catch (error) {
    console.error(error);
    const reply = { content: `Error: ${error.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      interaction.followUp(reply).catch(() => null);
    } else {
      interaction.reply(reply).catch(() => null);
    }
  }
});

client.login(config.discordToken);
