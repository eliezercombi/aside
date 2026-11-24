# Aside

**Your Notion tasks on Even G2: today at a glance, done with a tap, captured in one breath.**

The moment you remember something is rarely the moment you have a keyboard. Aside puts the task list you already keep in Notion on your glasses, and lets you add to it by saying one sentence: hold the touchpad, "send the deck to Anna on Friday", release. A model turns that into a clean task with a date, you see the draft, and a tap saves it.

Built for the Heads Up hackathon, track **AI Assistants & Work** (Notion, OpenRouter), with a Telegram bot as a second way in.

```
TODAY   1 of 4                                         1 overdue
Send the board deck to Anna

Overdue   Yesterday

tap: actions   swipe: next   hold: capture   double-tap: exit
```

## Read, then write

| You see | You do | What happens |
| --- | --- | --- |
| One task per card, overdue first | Swipe | Next task |
| A task | Tap, then pick **Done**, **Tomorrow** or **Next week** | The page is updated in Notion, in the way that database expects |
| A task | Tap, then **Brief me** | The task's page, cut down to a few lines that fit the display |
| Anything | Hold, say a task, release | A draft: title, due date and note. Tap saves it to Notion, double-tap discards it |
| Anything | Hold, ask a question, release | "What is due this week?" is answered in a few lines from your open tasks |

Nothing is written to Notion without a tap on a screen that shows exactly what will be written. Questions only read.

## From Telegram to your glasses

Half of what ends up on a to-do list arrives as a message. Forward it to your own Aside bot:

1. Someone writes "Can you send me the Q3 deck by Friday?". You forward it to the bot.
2. Within a second the draft is on your glasses, tagged `FROM TELEGRAM`, with who said it kept in the note.
3. Tap on the glasses, or press **Save to Notion** under the bot's reply. Either side decides, once: the other one updates ("Saved from your glasses").

Typing to the bot works the same way, and a question ("what is due this week?") is answered in the chat.

The bot is yours alone. It serves the one private chat that started it with the pairing code the relay prints, stops accepting codes after five wrong guesses, and says nothing to anyone else.

## What the model does, and what it is not trusted with

- It writes the **draft**: "remind me to call the bank next Friday about the mortgage" becomes *Call the bank about the mortgage, due Fri 4 Dec*.
- It writes the **brief** of a page.
- It **answers questions** about your open tasks. It is given the list and returns text; it has no way to change anything, and task titles are passed to it as data. With no model you get an honest summary instead: the counts and what comes first.
- Its draft is **checked before you see it**: the date has to be a real calendar date that is not in the past, the title cannot be empty. If the model is down, slow or wrong, a rule-based parser produces the draft instead. That parser is also all you get if you configure no model, and it handles "tomorrow", weekdays, "next Friday", "in 2 weeks", "1 Dec", "by the end of the week".
- It never decides to save anything.

## Works with the task list you already have

No template to copy. Aside reads the schema of your database and works out which property is the title, which date is the due date, and how "done" is expressed: a checkbox, or a Status whose Complete group may be called anything. Completing a task sets that checkbox or moves the Status into its Complete group.

## Try it

**Without an account.** `npm install`, `npm run dev`, open the printed address. With no glasses and no relay the page runs on a built-in demo list: a green panel mirrors the display and four buttons stand in for the touchpad.

**In the simulator.** With the dev server running: `npm run simulate`.

**With your Notion.** Create a [personal access token](https://developers.notion.com/guides/connections-and-tokens/personal-access-tokens), then:

```bash
NOTION_TOKEN=ntn_... OPENROUTER_API_KEY=sk-or-... npm run relay
```

It prints a relay token. Enter the relay address and that token on the phone page under **Notion**. The relay finds your task list by itself, or you can pin one with `NOTION_DATA_SOURCE_ID`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NOTION_TOKEN` | yes | Notion personal access token or internal connection token |
| `NOTION_DATA_SOURCE_ID` | no | The task list to use; otherwise the best match is found by search |
| `OPENROUTER_API_KEY` | no | Turns on model-written drafts, briefs and answers |
| `OPENROUTER_MODEL` | no | Default `anthropic/claude-haiku-5.5`; any OpenRouter model works, including the free ones |
| `STT_URL`, `STT_KEY`, `STT_MODEL` | no | OpenAI-compatible transcription endpoint for voice capture |
| `TELEGRAM_BOT_TOKEN` | no | Token of a bot you created with @BotFather. Turns on capture from Telegram; the relay prints the `/start` code to pair with |
| `TELEGRAM_CHAT_ID` | no | Your chat id, printed after pairing. Set it to stay paired across restarts |
| `TZ_OFFSET_MINUTES` | no | Minutes ahead of UTC that decide what "today" is. Defaults to the time zone of the machine the relay runs on |

## How it is built

```
src/core      task source interface, relay client, demo list, text layout
src/ui        pages (576x288 layouts), controller, display adapter, event mapping
shared/       date parsing, draft checking, telling a question from a task; used by the relay and the demo
server/       relay: Notion client, OpenRouter client, Telegram bot, HTTP API; Node built-ins only
test/         42 tests, run with `npm test`
```

- The Notion token, the model key and the speech key live only in the relay. The app holds a relay address and a relay token.
- The relay uses the Notion API version `2026-03-11` (data sources, Markdown page content).
- Layouts are data, measured with `@evenrealities/pretext` because the display font is proportional. A new screen is one `rebuildPageContainer`; a changed line is one `textContainerUpgrade`.
- Slow steps show a "working" screen and block further input, so a second tap cannot double-save.

## What has been tested, and how

- Date parsing, schema detection, Notion request shapes, draft checking, the relay routes, layouts, every screen flow and the Telegram bot: 42 automated tests, replaced by stand-ins for Notion, OpenRouter and the Telegram Bot API built from their documentation.
- One of those tests runs the whole path over real HTTP: controller, relay client, relay, Notion client, and an in-memory stand-in for the Notion API that applies filters, sorts and updates.
- The whole app in a desktop browser on the demo list.
- TODO before submission: runs against a live Notion workspace, OpenRouter, a real Telegram bot and the simulator are recorded here once done.

Not done: nothing has been tested on physical glasses.

## Hackathon notes

Everything in this repository was written during the hackathon week. Nothing existed before 23 November 2026. The display adapter and event mapping are shared with my other entry, Riskline, written the same week.

MIT licence.
