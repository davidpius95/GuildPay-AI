# GuildPay AI — Starter Kit

This repository is the home for building the **GuildPay AI MVP**. Your whole plan lives in `/docs`,
and `CLAUDE.md` tells the AI coding agents how to build it. It works with **Claude Code** and
**Google Antigravity** out of the box.

## What's here
```
CLAUDE.md                     # Project context + rules (read by both tools every session)
README.md
.env.example                  # All the keys/secrets you'll need (copy to .env, fill in)
.gitignore
.agents/                      # Antigravity-specific config
  rules/project-context.md    #   points Antigravity at CLAUDE.md
  workflows/implement-feature.md  #   a /implement-feature workflow
docs/
  01_TECHNICAL_PRD.md         # Full engineering spec (architecture, data model, APIs, security)
  02_IMPLEMENTATION_GUIDE.md  # Plain-English overview + Mermaid diagrams + 3 user journeys
  03_MVP_SCOPE.md             # Exactly what the demo must prove
  04_BUILD_PLAN.md            # The ordered task checklist you work through
  templates/bulk_payment_template.xlsx
```

## Start with Claude Code
```bash
# 1. Install (native installer — no Node.js needed; recommended)
curl -fsSL https://claude.ai/install.sh | bash      # macOS/Linux
#   (or, if you prefer npm and have Node 18+:  npm install -g @anthropic-ai/claude-code)
#   Requires a paid Claude plan (Pro/Max/Team) or a Console API account.

# 2. Put this folder under git and open it
cd guildpay-starter-kit
git init && git add . && git commit -m "chore: project plan + context"

# 3. Launch Claude Code in the folder
claude

# 4. First prompts inside Claude Code:
#    "Read CLAUDE.md and everything in /docs, then summarize the build plan back to me."
#    "Let's start Week 0 of docs/04_BUILD_PLAN.md. Propose a plan, wait for my approval."
```
Claude Code reads `CLAUDE.md` automatically. (You can also run `/init` to have it refine the file
against real code once the repo grows.) Ask it to **plan before implementing**.

## Start with Google Antigravity
```bash
# 1. Install Antigravity (free preview; needs a personal Gmail).
#    Download from https://antigravity.google  then open this folder as a workspace.

# 2. Antigravity reads CLAUDE.md-style context automatically, plus the .agents/ folder here.

# 3. First prompt in a new conversation:
#    "Read CLAUDE.md and /docs, then start docs/04_BUILD_PLAN.md Week 0. Plan first, then implement."
```
`/docs` is Markdown so Antigravity indexes it natively. The `.agents/rules/` file keeps your
standards always-on, and `/implement-feature` runs the repeatable build loop.

## The one habit that matters
Keep the plan **in the repo, in Markdown**. When something changes, update `/docs` and `CLAUDE.md` —
not a separate doc. Both agents re-read these every session, so the plan stays live and the agent
never drifts from it.
