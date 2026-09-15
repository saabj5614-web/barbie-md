'use strict';
require('dotenv').config();

module.exports = {
  BOT_NAME: process.env.BOT_NAME || '𝐁𝐀𝐑𝐁𝐈𝐄 𝐌𝐃',
  OWNER_NAME: process.env.OWNER_NAME || '𓆩 𝛭𝑅 𝑅𝛯𝛨𝛥𝜨 𓆪',
  OWNER_NUMBER: process.env.OWNER_NUMBER || '923483763349',
  PREFIX: process.env.PREFIX || '.',
  // Six intentionally empty WhatsApp Channel link slots.
  WHATSAPP_CHANNELS: ['', '', '', '', '', ''],
  // Six intentionally empty channel-JID slots; deployment can override them through .env.
  WHATSAPP_CHANNEL_JIDS: ['', '', '', '', '', ''],
  BOT_IMAGE_URL: process.env.BOT_IMAGE_URL || '',
};
