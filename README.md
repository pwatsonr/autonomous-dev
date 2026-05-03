# autonomous-dev

Autonomous AI development system for Claude Code.

A continuously-running, self-improving development pipeline that receives product requests, decomposes them through PRD > TDD > Plan > Spec > Code, reviews its own work at every gate, monitors production, and generates its own improvement PRDs.

## Repository Structure

```
autonomous-dev/
├── plugins/
│   ├── autonomous-dev/              # Core plugin (install this first)
│   │   ├── agents/                  #   18 AI agent definitions
│   │   ├── bin/                     #   Daemon and CLI executables
│   │   ├── commands/                #   Slash commands
│   │   ├── src/                     #   TypeScript subsystems
│   │   ├── intake/                  #   Multi-channel request processing,
│   │   │                            #   chains, deploy, cred-proxy, firewall,
│   │   │                            #   standards
│   │   ├── lib/                     #   Bash utilities and state management
│   │   ├── tests/                   #   Test suite
│   │   ├── docs/                    #   Planning documentation
│   │   └── README.md                #   Full plugin documentation
│   ├── autonomous-dev-deploy-gcp/   # GCP Cloud Run deployment backend
│   ├── autonomous-dev-deploy-aws/   # AWS ECS/Fargate deployment backend
│   ├── autonomous-dev-deploy-azure/ # Azure Container Apps deployment backend
│   ├── autonomous-dev-deploy-k8s/   # Kubernetes deployment backend
│   ├── autonomous-dev-assist/       # Expert assistant + eval harness
│   └── autonomous-dev-portal/       # Local web UI (Bun-based, optional)
├── .claude-plugin/
│   └── marketplace.json             # Claude Code marketplace manifest
└── LICENSE
```

The four `autonomous-dev-deploy-*` plugins are optional cloud backends that
register with the core plugin's deployment subsystem (one per cloud). Install
only the ones you need. `autonomous-dev-assist` and `autonomous-dev-portal`
are optional companions; see their READMEs for details.

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
