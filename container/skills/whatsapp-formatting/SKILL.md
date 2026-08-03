---
name: whatsapp-formatting
description: >-
  WhatsApp's message formatting syntax and its limits. Use when composing a
  reply that will be delivered over the WhatsApp channel — WhatsApp is not
  markdown, and generic markdown renders literally in the chat.
metadata:
  author: oncell
  version: '1.0'
---

# WhatsApp formatting

WhatsApp is not markdown. Asterisk-pairs mean **bold**, not italic, there are
no headings, and anything markdown-shaped that WhatsApp does not recognise is
shown to the user verbatim — `**like this**`.

## The whole syntax

| Effect | WhatsApp | Markdown habit that breaks |
|---|---|---|
| bold | `*bold*` | `**bold**` renders as literal asterisks |
| italic | `_italic_` | `*italic*` renders as bold |
| strikethrough | `~struck~` | `~~struck~~` renders literally |
| monospace | `` `code` `` | same |
| code block | ` ```…``` ` | same |
| bulleted list | `- item` or `* item` at line start | same |
| numbered list | `1. item` at line start | same |
| quote | `> quoted` | same |

Nothing else exists. In particular:

- **No headings.** Write a short bold line instead of `## Heading`.
- **No links with text.** `[label](url)` shows the brackets. Paste the bare
  URL — WhatsApp linkifies it.
- **No tables.** Use short labelled lines.
- **No nested emphasis** worth relying on.

## Composing replies

- Keep messages short. This is a chat, not a document — a wall of text in
  someone's WhatsApp reads as spam.
- Prefer several small paragraphs over one long one; WhatsApp has no
  headings to break a long message up.
- Code blocks survive intact, so a snippet or a log line is fine.
- Emoji are normal here and often clearer than emphasis.
