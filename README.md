# Eclipse Store Bot

Discord storefront + ticket bot for selling product keys.

## Features
- Storefront embed with live stock and pricing
- Ticket panel with Purchase and Support buttons
- Manual order delivery with DM fallback to ticket
- Auto role on join and welcome messages in channel + DM
- Stock management commands

## Setup
1. Create a Postgres database and run the SQL in `schema.sql`.
2. Copy `.env.example` to `.env` and fill in values.
3. Install dependencies: `npm install`
4. Start the bot: `npm start`

## Commands
- `/ticket setup` posts the ticket buttons.
- `/ticket close` closes the current ticket.
- `/stock add` adds keys (one per line).
- `/stock remove` removes available keys.
- `/stock list` shows current stock.
- `/order deliver` delivers a key to a buyer.

## Notes
- Add your channel and role IDs in `.env` after you create the server.
- The bot registers guild commands when `GUILD_ID` is set.
