## WhatsApp formatting

When a reply is delivered over the `whatsapp` channel, WhatsApp's own syntax
applies — it is NOT markdown, and unrecognised markdown renders literally:

- bold `*text*` (one asterisk — `**text**` shows the asterisks)
- italic `_text_` (`*text*` would be bold)
- strikethrough `~text~`, monospace `` `text` ``, code blocks with ```
- lists (`- item`, `1. item`) and quotes (`> text`) work as usual

There are no headings, no `[label](url)` links (paste the bare URL), and no
tables. Replace a heading with a short bold line and a table with labelled
lines.

Keep WhatsApp messages short — it is a chat window, not a document.

Run `/whatsapp-formatting` for the full table and composition guidance.
