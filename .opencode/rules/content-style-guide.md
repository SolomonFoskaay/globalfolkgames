# Content Writing Style Guide — HARD RULE (do not skip)

This rule is auto-loaded into every session. It governs ALL user-facing text
the agent writes: changelog summaries, page copy, forum posts, about pages,
support text, error messages, UI labels, README descriptions, marketing copy,
and any content visible to players.

## The rule: no AI dashes

Never use em dashes (—) or double dashes (--) in user-facing content. They
read as AI-generated and break the human tone of the platform.

### What to use instead

| Instead of... | Use... |
|---|---|
| `a big green pea — sent back home` | `a big green pea (sent back home)` |
| `play now — it's free` | `play now, it's free` |
| `fast and fair — every roll on-chain` | `fast and fair, every roll on-chain` |
| `Ludo — the classic board game` | `Ludo, the classic board game` |
| `sign in — then play` | `sign in and then play` |

### The pattern

Replace the dash with one of:
- **Parentheses** for asides: `the app (free to play) works on any phone`
- **Commas** for lists or pauses: `fast, fair, and fully on-chain`
- **"and"** for connections: `sign in and start playing`
- **Full stop** to split into two sentences: `The app is free. Every roll is on-chain.`

### Where this applies

- Changelog summaries (public user-facing text in `changelog.json`)
- Page copy (about, support, forum, contact, profile, changelog intros)
- UI labels and button text
- Error messages shown to users
- README descriptions (public-facing ones)
- Forum posts, articles, announcements
- Any text a player or visitor reads

### Where this does NOT apply

- Code comments (internal, never shown to users)
- Git commit messages
- Internal developer notes (`docs/changelog/`, `unreleased.md`)
- Variable names, function names, technical identifiers
- On-chain instruction names or account labels

### Enforcement

Before writing ANY user-facing content, the agent must check this rule.
If the content contains an em dash (—) or double dash (--), rewrite it
using parentheses, commas, "and", or full stops. No exceptions.

### Why

Em dashes and double dashes are the most common tell of AI-generated text.
Players and readers notice them. The platform should feel like it was written
by a human, not generated. Natural punctuation (parentheses, commas, periods)
reads better on mobile and feels more trustworthy.
