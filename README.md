# 𝐁𝐀𝐑𝐁𝐈𝐄 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓

Complete multi-user WhatsApp bot source with direct web pairing. The separate Server Hub will be built later in another repository.

- `index.js` — web server, `/api/code` pairing endpoint, multi-session runtime
- `plugins/` — merged command/plugin collection from the supplied Husnain base
- `lib/` — bot helpers, group events, storage and newsletter support
- `config.js` — Barbie branding and environment configuration

Default capacity is **50 WhatsApp sessions per server** via `MAX_SESSIONS_PER_SERVER=50`. There is no hard-coded 5,000 global cap; additional servers can be added later by the separate Server Hub.

MongoDB is optional locally and configured only through `MONGODB_URI`. No bot token or database password is committed.

WhatsApp channel links/JIDs and the bot DP URL are blank by default. Six configurable slots are provided through `WA_CHANNEL_LINKS` and `WA_CHANNEL_JIDS`.

The supplied Barbie ZIP did not contain a separate AI/API plugin collection; its WhatsApp commands are covered by the merged Husnain runtime. The full supplied AI/API and YouTube/plugin collection remains in the source and was not replaced with invented commands.
