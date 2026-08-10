# Clawdian

![Preview](assets/Preview.png)

A fork of [Claudian](https://github.com/yishentu/claudian) by Yishen Tu that adds in support for additional harnesses and scheduled jobs to organize your vault for you.

## New Features

In addition to what is provided by claudian, clawdian adds in support for
- oh-my-pi and copilot-cli harnesses
- An agentic cronjob system

## Installation

### Using BRAT

1. Install the BRAT plugin from Obsidian -> Settings -> Community plugins -> Browse
2. After enabling BRAT, go to its settings and click '+' next to "Beta plugin list"
3. Enter in https://github.com/chemiseblanc/clawdian for the repositiory and select latest release
4. Enable the plugin

## Usage

1. In the plugin settings, configure your choice of harness under the "Providers" tab
2. Create and view the status of background jobs in the "Jobs" tab, or ask in a chat session for supported providers (claude, copilot, oh-my-pi)

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── app/                         # Shared defaults and plugin-level storage
├── core/                        # Provider-neutral runtime, registry, and type contracts
│   ├── runtime/                 # ChatRuntime interface and approval types
│   ├── providers/               # Provider registry and workspace services
│   ├── auxiliary/               # Shared provider auxiliary services
│   ├── bootstrap/               # Plugin bootstrap wiring
│   ├── security/                # Approval utilities
│   └── ...                      # commands, mcp, prompt, storage, tools, types
├── providers/
│   ├── claude/                  # Claude SDK adaptor, prompt encoding, storage, MCP, plugins
│   ├── codex/                   # Codex app-server adaptor, JSON-RPC transport, JSONL history
│   ├── grok/                    # Grok Build ACP adaptor, native history, models, and tools
│   ├── opencode/                # Opencode adaptor
│   ├── pi/                      # Pi RPC adaptor, model discovery, JSONL history
│   └── acp/                     # Agent Client Protocol shared transport
├── features/
│   ├── chat/                    # Sidebar chat: tabs, controllers, renderers
│   ├── inline-edit/             # Inline edit modal and provider-backed edit services
│   └── settings/                # Settings shell with provider tabs
├── shared/                      # Reusable UI components and modals
├── i18n/                        # Internationalization (10 locales)
├── types/                       # Shared ambient types
├── utils/                       # Cross-cutting utilities
└── style/                       # Modular CSS
```

## License

Licensed under the [MIT License](LICENSE).
