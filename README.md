# autonomous-dev

Autonomous AI development system for Claude Code.

A continuously-running, self-improving development pipeline that receives product requests, decomposes them through PRD > TDD > Plan > Spec > Code, reviews its own work at every gate, monitors production, and generates its own improvement PRDs.

## Repository Structure

```
autonomous-dev/
├── plugins/
│   └── autonomous-dev/     # Claude Code plugin (install this)
│       ├── agents/          # 13 AI agent definitions
│       ├── bin/             # Daemon and CLI executables
│       ├── commands/        # Slash commands
│       ├── src/             # TypeScript subsystems
│       ├── intake/          # Multi-channel request processing
│       ├── lib/             # Bash utilities and state management
│       ├── tests/           # Test suite
│       ├── docs/            # Planning documentation
│       └── README.md        # Full plugin documentation
├── .claude-plugin/
│   └── marketplace.json     # Claude Code marketplace manifest
└── LICENSE
```

## Installation

```bash
# Add the marketplace
claude plugin marketplace add pwatsonr/autonomous-dev

# Install the plugin
claude plugin install autonomous-dev
```

## Documentation

See [plugins/autonomous-dev/README.md](plugins/autonomous-dev/README.md) for the full guide — quick start, commands reference, configuration, usage examples, architecture, and more.

## License

MIT
