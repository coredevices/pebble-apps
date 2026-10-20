# Notion

Adds notes as bullets under a “Todo” heading, creates child pages, or appends plain text to a selected Notion page.

Connect Notion in plugin settings and choose a page and how notes are added. Build: see the [repository README](../README.md#building).

## Functions

### `create_note(instanceId?, text)`

Save plain text using the configured Notion destination: add a bullet under the page's “Todo” heading, create a child page, or append a new paragraph at the top or bottom of a selected page. Use only when the user explicitly asks to save or send a note to Notion.

- `instanceId` (string, optional): destination id from the notes/destination source. One of `notion`.
- `text` (string): The complete plain text to save, preferably using the user's exact words. In heading mode the text becomes a bullet under “Todo”; in create mode the first line becomes the child-page title; in append mode the text becomes a new paragraph block.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `notes/destination`: name, configured, page, url
- `notes/configured`: name, configured
