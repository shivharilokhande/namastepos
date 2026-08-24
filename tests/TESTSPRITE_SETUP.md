# TestSprite MCP — Setup for Cowork mode

`claude mcp add ...` is the Claude **Code** CLI command. Cowork mode uses
its own MCP server registry. Here's the right path for each surface.

## Cowork (recommended)

1. Open the Cowork app → **Settings** → **Connectors / MCP servers**
2. Click **Add custom server**
3. Paste:

   | Field   | Value                                             |
   | ------- | ------------------------------------------------- |
   | Name    | `TestSprite`                                      |
   | Command | `npx`                                             |
   | Args    | `@testsprite/testsprite-mcp@latest`               |
   | Env     | `API_KEY` = *<your TestSprite API key>*           |

4. Click **Save** and restart the Cowork session. After restart,
   Claude will have access to TestSprite tools (e.g.
   `mcp__testsprite__run_tests`, depending on what the MCP exposes).

> Don't paste the API key in chat — set it as an environment variable
> in the Cowork settings UI. Rotate the one you shared in chat at
> https://testsprite.com/dashboard.

## Claude Code CLI (alternative)

If you also want it in the terminal `claude` CLI:

```bash
claude mcp add TestSprite \
  --env API_KEY=<your_testsprite_api_key> \
  -- npx @testsprite/testsprite-mcp@latest
```

Then `claude` (or `claude --dangerously-skip-permissions`) will load
the MCP at startup.

## Project-scoped fallback

If Cowork's UI install doesn't stick on your machine, drop a
`.mcp.json` at the repo root (already created — see
`/PetPooja Clone/.mcp.json`):

```json
{
  "mcpServers": {
    "TestSprite": {
      "command": "npx",
      "args": ["@testsprite/testsprite-mcp@latest"],
      "env": { "API_KEY": "${TESTSPRITE_API_KEY}" }
    }
  }
}
```

…and export `TESTSPRITE_API_KEY` in your shell before launching Cowork:

```bash
export TESTSPRITE_API_KEY=<your_testsprite_api_key>
```

This keeps the key out of the file so it's safe to commit.

## After setup — first run

Once TestSprite is connected, you can ask Claude:

> "Use TestSprite to run all NamastePOS specs and tell me which fail"

TestSprite will read `tests/playwright.config.ts`, execute each spec
in headless Chromium, capture traces, and surface a structured
pass/fail report back to the chat.
