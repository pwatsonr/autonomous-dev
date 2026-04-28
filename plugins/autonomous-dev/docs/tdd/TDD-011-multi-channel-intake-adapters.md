# TDD-011: Multi-Channel Intake Adapters

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Multi-Channel Intake Adapters                      |
| **TDD ID**   | TDD-011                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-008: Unified Request Submission Packaging   |
| **Plugin**   | autonomous-dev                                     |

---

## 1. Summary

This Technical Design Document (TDD) specifies the implementation of four multi-channel intake adapters that operationalize PRD-008's goal of making request submission fully functional across all channels. The design bridges the eight critical gaps identified in PRD-008, establishing the complete intake → daemon handoff pipeline that enables the autonomous development system to process real work.

The scope includes CLI dispatcher enhancements, Claude App command stub discovery mechanisms, Discord and Slack service entry points, and the critical SQLite → state.json bridge that connects the TypeScript intake layer to the bash daemon engine. The implementation follows the adapter pattern established in TDD-008, ensuring minimal disruption to the existing 90% complete intake infrastructure.

**Key deliverables:**
- CLI request management commands with bash argument validation and Node.js subprocess execution
- Claude Code discoverable command definitions with proxy execution via TypeScript bridge
- Discord bot main service with graceful shutdown and exponential reconnection logic
- Slack app main service supporting both HTTP receiver and Socket Mode
- Two-phase commit handoff mechanism ensuring SQLite and filesystem state consistency
- Source metadata population for audit trails and channel-specific debugging
- Complete package.json dependency declarations for successful TypeScript builds
- Comprehensive end-to-end testing across all submission channels

## 2. Goals & Non-Goals

### Goals

| ID   | Goal                                                                                           |
|------|------------------------------------------------------------------------------------------------|
| G-01 | Implement all CLI request management subcommands (`submit`, `status`, `list`, `cancel`, `pause`, `resume`, `priority`, `logs`, `feedback`, `kill`) with comprehensive argument validation and subprocess security |
| G-02 | Create Claude Code discoverable `.md` command stubs for all 10 autonomous-dev slash commands that proxy execution to the existing TypeScript router |
| G-03 | Provide production-ready Discord and Slack service entry points with configuration management, graceful lifecycle handling, and resilient connection recovery |
| G-04 | Bridge the SQLite → state.json gap using two-phase commit to maintain consistency between the TypeScript intake index and bash daemon consumption |
| G-05 | Populate request source metadata (`cli`, `claude-app`, `discord`, `slack`) with channel-specific details for complete audit trails |
| G-06 | Ensure zero regression on existing pipeline phases while establishing the intake → daemon handoff boundary |

### Non-Goals

| ID    | Non-Goal                                                                                     |
|-------|----------------------------------------------------------------------------------------------|
| NG-01 | Rewriting or modifying the existing TypeScript intake layer beyond adding source metadata support |
| NG-02 | Implementing a fifth intake channel or web portal functionality (deferred to PRD-009) |
| NG-03 | Changing daemon state schema beyond adding source metadata fields |
| NG-04 | Adding voice, email, or other intake modalities outside the four specified channels |
| NG-05 | Multi-tenant or organization-wide deployment support |

## 3. Background

### Current Intake State

The intake layer implementation (defined in TDD-008) is approximately 90% complete with robust TypeScript infrastructure:

**Completed Infrastructure:**
- **IntakeRouter** at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/core/intake_router.ts` with full command dispatch pipeline
- **Adapter Interface** at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/adapter_interface.ts` defining comprehensive channel contracts
- **Database Layer** with SQLite repository, migrations, and WAL mode support
- **Command Handlers** for all 10 core commands (`submit`, `status`, `list`, `cancel`, `pause`, `resume`, `priority`, `logs`, `feedback`, `kill`)
- **Authorization Engine** with RBAC and repository-scoped permissions
- **Rate Limiting** with per-user and per-channel quotas
- **Notification Engine** with digest scheduling and multi-channel formatting
- **Discord Adapter** at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/discord/discord_adapter.ts` (3000+ lines, complete implementation)
- **Slack Adapter** at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/slack/slack_adapter.ts` (2500+ lines, complete implementation)
- **Claude Adapter** at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/claude_adapter.ts` with command bridge support

**Critical Gaps:**
1. CLI commands missing from `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/bin/autonomous-dev.sh`
2. Claude App commands exist in TypeScript but lack `.md` discovery files in `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/commands/`
3. Discord/Slack adapters have no service entry points despite complete implementations
4. SQLite repository writes never produce `state.json` files consumed by daemon
5. Missing `discord.js` and `better-sqlite3` in package.json dependencies

### Integration Points Diagram

```
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│   CLI Dispatcher    │    │   Claude App CLI    │    │    Chat Platforms   │
│   (bash wrapper)    │    │  (command stubs)    │    │  (Discord + Slack)  │
└─────────┬───────────┘    └─────────┬───────────┘    └─────────┬───────────┘
          │                          │                          │
          │ execFile                 │ spawn bridge             │ network APIs
          │ (no shell)               │ (subprocess)             │ (webhooks/gateway)
          ▼                          ▼                          ▼
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│   CLI Adapter       │    │  Claude Bridge      │    │  Discord/Slack      │
│   (new file)        │    │  (existing)         │    │  Main Services      │
│                     │    │                     │    │  (new files)        │
└─────────┬───────────┘    └─────────┬───────────┘    └─────────┬───────────┘
          │                          │                          │
          └──────────────────────────┼──────────────────────────┘
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │   IntakeRouter      │
                          │   (existing core)   │
                          └─────────┬───────────┘
                                    │
                                    ▼
                          ┌─────────────────────┐
                          │   Submit Handler    │
                          │   (enhanced for     │
                          │    state.json)      │
                          └─────────┬───────────┘
                                    │
                     ┌──────────────┼──────────────┐
                     │              │              │
                     ▼              ▼              ▼
          ┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
          │  SQLite Write   │ │ state.json  │ │  Daemon Pickup  │
          │  (index)        │ │ Write       │ │  (filesystem)   │
          └─────────────────┘ └─────────────┘ └─────────────────┘
```

## 4. Architecture Overview

### 4.1 Component Layering

The multi-channel adapter architecture extends the existing intake layer with four new entry points while preserving the established adapter → router → handler pipeline:

```
┌══════════════════════════════════════════════════════════════════════┐
│                          Entry Points Layer                         │
├─────────────────┬─────────────────┬─────────────────┬─────────────────┤
│ CLI Dispatcher  │ Claude App      │ Discord Bot     │ Slack App       │
│ (bash)          │ Commands        │ Service         │ Service         │
│ autonomous-dev  │ (.md stubs)     │ (main.ts)       │ (main.ts)       │
│ request submit  │ proxy calls     │ gateway client  │ HTTP/Socket     │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┘
           │                │                │                │
           │ execFile       │ spawn bridge   │ interaction    │ webhook/
           │ subprocess     │ subprocess     │ handlers       │ event handlers
           ▼                ▼                ▼                ▼
┌══════════════════════════════════════════════════════════════════════┐
│                        Adapter Layer                                │
├─────────────────┬─────────────────┬─────────────────┬─────────────────┤
│ CLIAdapter      │ ClaudeAdapter   │ DiscordAdapter  │ SlackAdapter    │
│ (new)           │ (existing)      │ (existing)      │ (existing)      │
│ - arg parsing   │ - bridge proxy  │ - embed format  │ - block format  │
│ - validation    │ - identity      │ - rate limiting │ - signature     │
│ - formatting    │ - formatting    │ - reconnection  │ - verification  │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┘
                                    │
                                    ▼
┌══════════════════════════════════════════════════════════════════════┐
│                         Router Layer                                │
│                    IntakeRouter (existing)                          │
│  - Command dispatch   - Authorization   - Rate limiting             │
│  - User resolution    - Event emission  - Error handling            │
└══════════════════════════════════════════════════════════════════════┘
                                    │
                                    ▼
┌══════════════════════════════════════════════════════════════════════┐
│                        Handler Layer                                │
│               10 Command Handlers (existing)                        │
│  Submit | Status | List | Cancel | Pause | Resume | Priority         │
│  Logs | Feedback | Kill + Gate Actions (approve/reject/changes)     │
└══════════════════════════════════════════════════════════════════════┘
                                    │
                                    ▼
┌══════════════════════════════════════════════════════════════════════┐
│                      State Persistence                              │
├───────────────────────────────┬──────────────────────────────────────┤
│          SQLite Index         │         Daemon State Files          │
│      (canonical source)       │         (consumption layer)         │
│   - Request metadata          │    - state.json per request         │
│   - Audit trails              │    - Two-phase commit sync          │
│   - Query optimization        │    - Filesystem atomicity           │
└───────────────────────────────┴──────────────────────────────────────┘
```

### 4.2 Data Flow

**Request Submission Flow:**
1. **Channel Entry** → Raw command received via CLI, Claude App, Discord, or Slack
2. **Adapter Processing** → Parse arguments, validate syntax, resolve user identity
3. **Router Dispatch** → Authorize user, check rate limits, select handler
4. **Handler Execution** → Process business logic, update state
5. **State Persistence** → Two-phase commit: SQLite transaction + state.json atomic write
6. **Response Delivery** → Format result for originating channel

**Source Metadata Flow:**
- Each adapter populates `CommandSource` with channel-specific identifiers
- Router validates source authenticity (server-side assertion, not client-trusted)
- Submit handler includes source in both SQLite record and state.json file
- Audit trails capture complete request provenance for debugging

## 5. CLI Dispatcher Design

### 5.1 Subcommand Structure

The CLI dispatcher at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/bin/autonomous-dev.sh` requires extension with request management capabilities:

**Current Commands:**
```bash
autonomous-dev install-daemon
autonomous-dev daemon start|stop|status
autonomous-dev kill-switch [reset]
autonomous-dev circuit-breaker reset
autonomous-dev config init|show|validate
```

**New Request Commands:**
```bash
autonomous-dev request submit "description" [--priority high|normal|low] [--repo owner/name] [--deadline ISO-8601]
autonomous-dev request status REQ-NNNNNN
autonomous-dev request list [--status queued|active|paused] [--priority high|normal|low]
autonomous-dev request cancel REQ-NNNNNN
autonomous-dev request pause REQ-NNNNNN
autonomous-dev request resume REQ-NNNNNN
autonomous-dev request priority REQ-NNNNNN high|normal|low
autonomous-dev request logs REQ-NNNNNN [--follow] [--lines N]
autonomous-dev request feedback REQ-NNNNNN "message"
autonomous-dev request kill [--force]
```

### 5.2 Implementation Pattern

The dispatcher uses `execFile` with explicit argument arrays to prevent command injection, following the security pattern established for existing subcommands:

```bash
# Route request subcommands to Node.js subprocess
cmd_request() {
    local subcommand="$1"
    shift
    
    case "${subcommand}" in
        submit|status|list|cancel|pause|resume|priority|logs|feedback|kill)
            cmd_request_invoke "${subcommand}" "$@"
            ;;
        --help|-h)
            cmd_request_help
            ;;
        *)
            echo "ERROR: Unknown request subcommand: ${subcommand}" >&2
            echo "Run 'autonomous-dev request --help' for usage." >&2
            exit 1
            ;;
    esac
}

cmd_request_invoke() {
    local subcommand="$1"
    shift
    
    # Pre-validate request ID format if applicable
    if [[ "${subcommand}" =~ ^(status|cancel|pause|resume|priority|logs|feedback)$ ]]; then
        local req_id="$1"
        if [[ ! "${req_id}" =~ ^REQ-[0-9]{6}$ ]]; then
            echo "ERROR: Invalid request ID format: ${req_id}" >&2
            echo "Expected format: REQ-NNNNNN (e.g., REQ-000042)" >&2
            exit 1
        fi
    fi
    
    # Pre-validate priority values
    if [[ "${subcommand}" == "priority" && "$#" -ge 2 ]]; then
        local priority="$2"
        if [[ ! "${priority}" =~ ^(high|normal|low)$ ]]; then
            echo "ERROR: Invalid priority: ${priority}" >&2
            echo "Valid priorities: high, normal, low" >&2
            exit 1
        fi
    fi
    
    # Determine color output
    local use_color="true"
    if [[ -n "${NO_COLOR:-}" || ! -t 1 ]]; then
        use_color="false"
    fi
    for arg in "$@"; do
        if [[ "${arg}" == "--no-color" ]]; then
            use_color="false"
            break
        fi
    done
    
    # Build argument array for Node.js
    local node_args=(
        "${PLUGIN_DIR}/intake/adapters/cli_adapter.js"
        "${subcommand}"
    )
    
    # Add use_color flag
    node_args+=("--use-color=${use_color}")
    
    # Add remaining arguments
    node_args+=("$@")
    
    # Execute via Node.js subprocess (no shell interpretation)
    if command -v node >/dev/null 2>&1; then
        exec node "${node_args[@]}"
    else
        echo "ERROR: Node.js not found. Install Node.js to use request commands." >&2
        exit 2
    fi
}
```

### 5.3 Color and TTY Detection

The CLI implements comprehensive output formatting following Unix conventions:

**Color Suppression Logic:**
- `NO_COLOR` environment variable set (per no-color.org standard)
- Standard output not connected to a TTY (`! -t 1`)
- Explicit `--no-color` flag passed

**Exit Code Semantics:**
- `0`: Success
- `1`: User error (invalid arguments, validation failure, authorization denied)
- `2`: System error (missing dependencies, internal failure, network timeout)

### 5.4 Commander.js Integration

The new `intake/adapters/cli_adapter.ts` uses commander.js for robust argument parsing:

**Justification for commander.js:**
- Industry-standard Node.js CLI library with extensive validation support
- Built-in help generation and error formatting
- Type-safe option parsing with coercion and validation
- Consistent with existing Node.js tooling in the codebase
- Minimal dependency footprint (no transitive dependencies)

**Example Implementation:**
```typescript
import { Command } from 'commander';
import type { IncomingCommand, CommandResult } from './adapter_interface';
import { IntakeRouter } from '../core/intake_router';

export class CLIAdapter {
  private program: Command;
  
  constructor(private router: IntakeRouter) {
    this.program = new Command();
    this.setupCommands();
  }
  
  private setupCommands(): void {
    this.program
      .name('autonomous-dev-request')
      .description('CLI adapter for autonomous-dev request management');
      
    // Submit command
    this.program
      .command('submit <description>')
      .description('Submit a new development request')
      .option('--priority <level>', 'Request priority', 'normal')
      .option('--repo <owner/name>', 'Target repository')
      .option('--deadline <iso-date>', 'Deadline in ISO 8601 format')
      .option('--use-color <boolean>', 'Enable color output', 'true')
      .action(async (description, options) => {
        await this.handleSubmit(description, options);
      });
      
    // Status command
    this.program
      .command('status <request-id>')
      .description('Show request status and progress')
      .option('--use-color <boolean>', 'Enable color output', 'true')
      .action(async (requestId, options) => {
        await this.handleStatus(requestId, options);
      });
      
    // Additional commands follow same pattern...
  }
}
```

## 6. Claude App Command Stub Design

### 6.1 Command Discovery Mechanism

Claude Code discovers commands through `.md` files in the `commands/` directory. The existing infrastructure includes only `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/commands/observe.md`. The design adds 10 new command definition files with consistent frontmatter structure.

### 6.2 Frontmatter Schema

Each command stub follows the established frontmatter pattern:

```yaml
---
name: autonomous-dev-submit
description: Submit a new development request through the autonomous pipeline
arguments:
  - name: description
    description: Natural language description of the requested work
    required: true
  - name: priority
    description: Request priority level
    required: false
    default: "normal"
    choices: ["high", "normal", "low"]
  - name: repo
    description: Target repository in owner/name format
    required: false
  - name: deadline
    description: Deadline in ISO 8601 format
    required: false
allowed_tools:
  - Read
  - Write
  - Bash
---
```

### 6.3 Full Example: autonomous-dev-submit.md

```markdown
---
name: autonomous-dev-submit
description: Submit a new development request through the autonomous pipeline
arguments:
  - name: description
    description: Natural language description of the requested work
    required: true
  - name: priority
    description: Request priority level
    required: false
    default: "normal"
    choices: ["high", "normal", "low"]
  - name: repo
    description: Target repository in owner/name format
    required: false
  - name: deadline
    description: Deadline in ISO 8601 format
    required: false
allowed_tools:
  - Read
  - Write
  - Bash
---

Submit a new development request to the autonomous pipeline for processing.

## What this does

Creates a new request entry in the intake queue with the following processing pipeline:

1. **Input Validation** — Validates description length, priority values, and repository format
2. **NLP Processing** — Extracts title, technical constraints, and acceptance criteria using Claude API
3. **Duplicate Detection** — Checks against existing requests to prevent redundant work
4. **Authorization** — Verifies user permissions for the target repository
5. **Queue Insertion** — Adds to priority queue with estimated completion time
6. **State Persistence** — Creates SQLite record and filesystem state.json for daemon pickup

## Usage

Submit a basic request:
```
/autonomous-dev-submit description="Add pagination to the users API endpoint"
```

Submit with priority and target repository:
```
/autonomous-dev-submit description="Implement rate limiting middleware" priority=high repo=acme/backend-api
```

Submit with deadline:
```
/autonomous-dev-submit description="Fix user authentication bug" deadline=2026-05-01T17:00:00Z
```

## Arguments

- **description** (required): Natural language description of the work to be done. Should be 10-10,000 characters and include sufficient context for autonomous processing.

- **priority** (optional): Request priority affecting queue position. Defaults to "normal".
  - `high`: Critical issues, security vulnerabilities, production outages
  - `normal`: Feature requests, non-critical bug fixes, refactoring
  - `low`: Nice-to-have improvements, documentation updates

- **repo** (optional): Target repository in `owner/name` format. If omitted, defaults to the current repository context.

- **deadline** (optional): Target completion date in ISO 8601 format (e.g., `2026-05-01T17:00:00Z`). Used for prioritization but not guaranteed.

## Output

Returns a JSON response with:
- `requestId`: Unique identifier for tracking (format: REQ-NNNNNN)
- `queuePosition`: Current position in the processing queue
- `estimatedWait`: Estimated time until processing begins (in minutes)
- `targetRepo`: Resolved target repository
- `priority`: Assigned priority level

Example success response:
```json
{
  "success": true,
  "data": {
    "requestId": "REQ-000042",
    "queuePosition": 3,
    "estimatedWait": 45,
    "targetRepo": "acme/backend-api",
    "priority": "normal"
  }
}
```

## Error Handling

- **Validation errors**: Description too short/long, invalid priority, malformed repository
- **Authorization errors**: No access to target repository, rate limit exceeded
- **System errors**: Queue full, duplicate request detected, internal processing failure

## Bridge Execution

This command executes through the Claude Command Bridge mechanism:

```bash
#!/usr/bin/env node

// Proxy execution to TypeScript intake router
const { spawn } = require('child_process');
const path = require('path');

const bridgePath = path.join(__dirname, '..', 'intake', 'adapters', 'claude_command_bridge.js');
const args = process.argv.slice(2);

const child = spawn('node', [bridgePath, 'submit', ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CLAUDE_COMMAND_SOURCE: 'claude-app',
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID || 'unknown'
  }
});

child.on('exit', (code) => {
  process.exit(code);
});

child.on('error', (err) => {
  console.error('Bridge execution failed:', err.message);
  console.error('Ensure the intake layer is built: npm run build');
  process.exit(2);
});
```
```

### 6.4 Bridge Proxy Mechanism

The command bridge at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/claude_command_bridge.ts` handles proxy execution:

```typescript
export class ClaudeCommandBridge {
  async executeCommand(
    commandName: string,
    args: string[],
    sessionId?: string
  ): Promise<string> {
    try {
      // Parse arguments using existing argument parser
      const { args: parsedArgs, flags } = parseCommandArgs(args);
      
      // Construct IncomingCommand
      const command: IncomingCommand = {
        commandName,
        args: parsedArgs,
        flags,
        rawText: args.join(' '),
        source: {
          channelType: 'claude_app',
          userId: sessionId || 'unknown',
          timestamp: new Date(),
        },
      };
      
      // Validate using adapter validators
      const validator = this.validators[commandName];
      if (validator) {
        validator(parsedArgs, flags);
      }
      
      // Resolve user identity
      const userId = await this.identityResolver.resolveUserId(command.source);
      
      // Route through intake router
      const result = await this.router.route(command, userId);
      
      // Format for CLI output
      return this.formatter.formatResult(result);
      
    } catch (error) {
      if (error instanceof ValidationError) {
        return this.formatter.formatError(error, 'VALIDATION_ERROR');
      }
      throw error;
    }
  }
}
```

### 6.5 Error Handling for Missing Bridge

The command stubs handle cases where the TypeScript bridge is not built or dependencies are missing:

```bash
if [[ ! -f "${bridge_path}" ]]; then
    echo "ERROR: Intake layer not built. Run the following to install:" >&2
    echo "  cd ${PLUGIN_DIR}" >&2
    echo "  npm install" >&2
    echo "  npm run build" >&2
    exit 2
fi
```

## 7. Discord Bot Service Design

### 7.1 Main Service Architecture

The Discord bot service provides a production-ready entry point at `intake/adapters/discord/main.ts` that initializes the Discord client, registers slash commands, and manages the complete service lifecycle.

### 7.2 Configuration Schema

The Discord service reads configuration from the shared intake configuration schema:

```typescript
interface DiscordConfig {
  token: string;              // Bot token from Discord Developer Portal
  applicationId: string;      // Application ID for slash command registration
  guildId?: string;          // Guild ID for guild-specific commands (optional)
  enabled: boolean;          // Feature flag for channel enablement
  rateLimits: {
    perUser: number;         // Requests per hour per Discord user ID
    perGuild: number;        // Requests per hour per guild
  };
  reconnect: {
    maxAttempts: number;     // Maximum reconnection attempts
    baseDelayMs: number;     // Base delay for exponential backoff
    maxDelayMs: number;      // Maximum delay between attempts
  };
}
```

Configuration validation ensures required fields are present and tokens have the correct format (BOT token prefix for bot tokens).

### 7.3 Service Implementation

```typescript
/**
 * Discord Bot Main Service
 * 
 * Production entry point for the Discord intake adapter.
 * Manages client lifecycle, slash command registration, and graceful shutdown.
 */

import { Client, GatewayIntentBits, ApplicationCommandData } from 'discord.js';
import type { IntakeRouter } from '../../core/intake_router';
import { DiscordAdapter } from './discord_adapter';
import { loadConfig, validateConfig } from '../../config/config_loader';
import { createLogger } from '../../utils/logger';

interface DiscordServiceDeps {
  router: IntakeRouter;
  config: DiscordConfig;
  logger: Logger;
}

export class DiscordService {
  private client: Client;
  private adapter: DiscordAdapter;
  private shutdownPromise?: Promise<void>;
  private isShuttingDown = false;

  constructor(private deps: DiscordServiceDeps) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.adapter = new DiscordAdapter(this.client, this.deps.router, this.deps.config);
    this.setupEventHandlers();
    this.setupSignalHandlers();
  }

  /**
   * Start the Discord service.
   * 1. Login to Discord
   * 2. Register slash commands 
   * 3. Start interaction handler
   */
  async start(): Promise<void> {
    this.deps.logger.info('Starting Discord service...', {
      guildId: this.deps.config.guildId,
      applicationId: this.deps.config.applicationId,
    });

    try {
      // Login to Discord Gateway
      await this.client.login(this.deps.config.token);
      this.deps.logger.info('Discord client logged in successfully');

      // Wait for client ready event
      await this.waitForReady();

      // Register slash commands
      await this.registerSlashCommands();
      this.deps.logger.info('Slash commands registered successfully');

      // Start adapter
      await this.adapter.start();
      this.deps.logger.info('Discord service started successfully');

    } catch (error) {
      this.deps.logger.error('Failed to start Discord service', { error });
      throw error;
    }
  }

  /**
   * Gracefully shutdown the Discord service.
   * Completes in-flight interactions within 5 seconds.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return this.shutdownPromise!;
    }

    this.isShuttingDown = true;
    this.shutdownPromise = this._performShutdown();
    return this.shutdownPromise;
  }

  private async _performShutdown(): Promise<void> {
    this.deps.logger.info('Shutting down Discord service...');

    const shutdownTimeout = 5000; // 5 seconds
    const shutdownPromise = Promise.race([
      this._gracefulShutdown(),
      this._forceShutdown(shutdownTimeout),
    ]);

    await shutdownPromise;
    this.deps.logger.info('Discord service shutdown complete');
  }

  private async _gracefulShutdown(): Promise<void> {
    // Stop accepting new interactions
    this.client.removeAllListeners('interactionCreate');

    // Gracefully stop adapter (completes in-flight requests)
    if (this.adapter) {
      await this.adapter.shutdown();
    }

    // Disconnect from Discord Gateway
    if (this.client) {
      this.client.destroy();
    }
  }

  private async _forceShutdown(timeoutMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    this.deps.logger.warn('Force shutdown after timeout', { timeoutMs });
    
    if (this.client) {
      this.client.destroy();
    }
  }

  private async waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord client ready timeout after 30 seconds'));
      }, 30000);

      this.client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private async registerSlashCommands(): Promise<void> {
    const commands: ApplicationCommandData[] = [
      {
        name: 'submit',
        description: 'Submit a new development request',
        options: [
          {
            name: 'description',
            type: 3, // STRING
            description: 'Natural language description of the work',
            required: true,
          },
          {
            name: 'priority',
            type: 3, // STRING
            description: 'Request priority level',
            required: false,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ],
          },
          {
            name: 'repo',
            type: 3, // STRING
            description: 'Target repository (owner/name format)',
            required: false,
          },
        ],
      },
      {
        name: 'status',
        description: 'Check request status',
        options: [
          {
            name: 'request-id',
            type: 3, // STRING
            description: 'Request ID (REQ-NNNNNN format)',
            required: true,
          },
        ],
      },
      {
        name: 'list',
        description: 'List requests',
        options: [
          {
            name: 'status',
            type: 3, // STRING
            description: 'Filter by request status',
            required: false,
            choices: [
              { name: 'Queued', value: 'queued' },
              { name: 'Active', value: 'active' },
              { name: 'Paused', value: 'paused' },
              { name: 'Completed', value: 'done' },
              { name: 'Failed', value: 'failed' },
            ],
          },
        ],
      },
      {
        name: 'cancel',
        description: 'Cancel a request',
        options: [
          {
            name: 'request-id',
            type: 3, // STRING
            description: 'Request ID to cancel',
            required: true,
          },
        ],
      },
      {
        name: 'pause',
        description: 'Pause a request',
        options: [
          {
            name: 'request-id',
            type: 3, // STRING
            description: 'Request ID to pause',
            required: true,
          },
        ],
      },
      {
        name: 'resume',
        description: 'Resume a paused request',
        options: [
          {
            name: 'request-id',
            type: 3, // STRING
            description: 'Request ID to resume',
            required: true,
          },
        ],
      },
      {
        name: 'priority',
        description: 'Change request priority',
        options: [
          {
            name: 'request-id',
            type: 3, // STRING
            description: 'Request ID to modify',
            required: true,
          },
          {
            name: 'new-priority',
            type: 3, // STRING
            description: 'New priority level',
            required: true,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ],
          },
        ],
      },
      {
        name: 'logs',
        description: 'View request logs',
        options: [
          {
            name: 'request-id',
            type: 3, // STRING
            description: 'Request ID to view logs for',
            required: true,
          },
          {
            name: 'lines',
            type: 4, // INTEGER
            description: 'Number of log lines to show',
            required: false,
          },
        ],
      },
      {
        name: 'feedback',
        description: 'Provide feedback on a request',
        options: [
          {
            name: 'request-id',
            type: 3, // STRING
            description: 'Request ID to provide feedback for',
            required: true,
          },
          {
            name: 'message',
            type: 3, // STRING
            description: 'Feedback message',
            required: true,
          },
        ],
      },
      {
        name: 'kill',
        description: 'Emergency stop all processing',
        options: [
          {
            name: 'force',
            type: 5, // BOOLEAN
            description: 'Force immediate shutdown',
            required: false,
          },
        ],
      },
    ];

    if (this.deps.config.guildId) {
      // Register guild-specific commands (instant)
      const guild = await this.client.guilds.fetch(this.deps.config.guildId);
      await guild.commands.set(commands);
      this.deps.logger.info('Registered guild-specific slash commands', {
        guildId: this.deps.config.guildId,
        commandCount: commands.length,
      });
    } else {
      // Register global commands (may take up to 1 hour to propagate)
      await this.client.application!.commands.set(commands);
      this.deps.logger.info('Registered global slash commands', {
        commandCount: commands.length,
      });
    }
  }

  private setupEventHandlers(): void {
    this.client.on('ready', () => {
      this.deps.logger.info('Discord client ready', {
        tag: this.client.user?.tag,
        guilds: this.client.guilds.cache.size,
      });
    });

    this.client.on('error', (error) => {
      this.deps.logger.error('Discord client error', { error });
    });

    this.client.on('warn', (warning) => {
      this.deps.logger.warn('Discord client warning', { warning });
    });

    // Connection state logging
    this.client.on('disconnect', () => {
      this.deps.logger.warn('Discord client disconnected');
    });

    this.client.on('reconnecting', () => {
      this.deps.logger.info('Discord client reconnecting...');
    });
  }

  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    
    signals.forEach((signal) => {
      process.on(signal, async () => {
        this.deps.logger.info(`Received ${signal}, initiating graceful shutdown...`);
        
        try {
          await this.shutdown();
          process.exit(0);
        } catch (error) {
          this.deps.logger.error('Error during graceful shutdown', { error });
          process.exit(1);
        }
      });
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.deps.logger.error('Unhandled promise rejection', {
        reason,
        promise: promise.toString(),
      });
    });
  }

  /**
   * Connection recovery with exponential backoff.
   * Implements reconnection logic when gateway connection fails.
   */
  private async reconnectWithBackoff(): Promise<void> {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.deps.config.reconnect;
    let attempts = 0;

    while (attempts < maxAttempts && !this.isShuttingDown) {
      attempts++;
      
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempts - 1),
        maxDelayMs
      );

      this.deps.logger.info('Attempting to reconnect to Discord', {
        attempt: attempts,
        maxAttempts,
        delayMs: delay,
      });

      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        await this.client.login(this.deps.config.token);
        this.deps.logger.info('Successfully reconnected to Discord');
        return;
      } catch (error) {
        this.deps.logger.warn('Reconnection attempt failed', {
          attempt: attempts,
          error,
        });
      }
    }

    if (!this.isShuttingDown) {
      this.deps.logger.error('Failed to reconnect to Discord after maximum attempts', {
        attempts: maxAttempts,
      });
      throw new Error(`Discord reconnection failed after ${maxAttempts} attempts`);
    }
  }
}

// Service entry point
export async function startDiscordService(config: DiscordConfig, router: IntakeRouter): Promise<DiscordService> {
  const logger = createLogger('discord');
  
  const service = new DiscordService({
    router,
    config,
    logger,
  });

  await service.start();
  return service;
}
```

### 7.4 Lifecycle Management

The Discord service implements comprehensive lifecycle management:

**Startup Sequence:**
1. Client initialization with required Gateway intents
2. Authentication with Discord using bot token
3. Ready event wait with 30-second timeout
4. Slash command registration (guild-specific or global)
5. Interaction handler registration via existing DiscordAdapter
6. Health check logging with connection state

**Graceful Shutdown:**
1. Stop accepting new interactions (remove event listeners)
2. Complete in-flight interactions within 5-second budget
3. Gracefully shutdown adapter and close connections
4. Destroy Discord client connection
5. Log shutdown completion

**Connection Recovery:**
- Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (max)
- Maximum 10 reconnection attempts before failure
- Graceful degradation during connection loss
- Structured logging for debugging connection issues

## 8. Slack App Service Design

### 8.1 Service Architecture

The Slack app service at `intake/adapters/slack/main.ts` provides dual-mode support for both HTTP receiver and Socket Mode, enabling flexible deployment scenarios.

### 8.2 Configuration Schema

```typescript
interface SlackConfig {
  token: string;              // Bot token (xoxb-) from Slack App
  signingSecret: string;      // Signing secret for request verification
  socketMode: boolean;        // true = Socket Mode, false = HTTP receiver
  port?: number;              // HTTP port (required for HTTP mode)
  enabled: boolean;           // Feature flag for channel enablement
  rateLimits: {
    perUser: number;          // Requests per hour per Slack user ID
    perWorkspace: number;     // Requests per hour per workspace
  };
  verification: {
    timestampToleranceMs: number;  // Request timestamp tolerance (300000 = 5 min)
    enableReplayProtection: boolean; // Enable replay attack protection
  };
}
```

### 8.3 Service Implementation

```typescript
/**
 * Slack App Main Service
 * 
 * Production entry point supporting both HTTP receiver and Socket Mode.
 * Manages request verification, graceful shutdown, and service lifecycle.
 */

import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import express from 'express';
import type { Server } from 'http';
import type { IntakeRouter } from '../../core/intake_router';
import { SlackAdapter } from './slack_adapter';
import { SlackVerifier } from './slack_verifier';
import { SlackSocketMode } from './slack_socket_mode';
import { SlackServer } from './slack_server';
import { loadConfig, validateConfig } from '../../config/config_loader';
import { createLogger } from '../../utils/logger';

interface SlackServiceDeps {
  router: IntakeRouter;
  config: SlackConfig;
  logger: Logger;
}

export class SlackService {
  private webClient: WebClient;
  private adapter: SlackAdapter;
  private socketClient?: SocketModeClient;
  private httpServer?: Server;
  private app?: express.Application;
  private shutdownPromise?: Promise<void>;
  private isShuttingDown = false;

  constructor(private deps: SlackServiceDeps) {
    this.webClient = new WebClient(this.deps.config.token);
    this.adapter = new SlackAdapter(
      this.webClient,
      this.deps.router,
      this.deps.config
    );
    this.setupSignalHandlers();
  }

  /**
   * Start the Slack service in either HTTP or Socket Mode.
   */
  async start(): Promise<void> {
    this.deps.logger.info('Starting Slack service...', {
      mode: this.deps.config.socketMode ? 'Socket Mode' : 'HTTP Receiver',
      port: this.deps.config.port,
    });

    try {
      if (this.deps.config.socketMode) {
        await this.startSocketMode();
      } else {
        await this.startHttpMode();
      }

      // Start adapter
      await this.adapter.start();
      this.deps.logger.info('Slack service started successfully');

    } catch (error) {
      this.deps.logger.error('Failed to start Slack service', { error });
      throw error;
    }
  }

  /**
   * Gracefully shutdown the Slack service.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return this.shutdownPromise!;
    }

    this.isShuttingDown = true;
    this.shutdownPromise = this._performShutdown();
    return this.shutdownPromise;
  }

  private async _performShutdown(): Promise<void> {
    this.deps.logger.info('Shutting down Slack service...');

    const shutdownTimeout = 10000; // 10 seconds for Slack
    const shutdownPromise = Promise.race([
      this._gracefulShutdown(),
      this._forceShutdown(shutdownTimeout),
    ]);

    await shutdownPromise;
    this.deps.logger.info('Slack service shutdown complete');
  }

  private async _gracefulShutdown(): Promise<void> {
    // Stop adapter first (completes in-flight requests)
    if (this.adapter) {
      await this.adapter.shutdown();
    }

    // Stop Socket Mode client
    if (this.socketClient) {
      await this.socketClient.disconnect();
    }

    // Stop HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }

  private async _forceShutdown(timeoutMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    this.deps.logger.warn('Force shutdown after timeout', { timeoutMs });
    
    // Force close connections
    if (this.socketClient) {
      this.socketClient.disconnect();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
  }

  /**
   * Initialize Socket Mode client for real-time events.
   */
  private async startSocketMode(): Promise<void> {
    if (!process.env.SLACK_APP_TOKEN) {
      throw new Error('SLACK_APP_TOKEN environment variable required for Socket Mode');
    }

    this.socketClient = new SocketModeClient({
      appToken: process.env.SLACK_APP_TOKEN,
      logger: {
        debug: (msg: string) => this.deps.logger.debug('Slack Socket Mode', { message: msg }),
        info: (msg: string) => this.deps.logger.info('Slack Socket Mode', { message: msg }),
        warn: (msg: string) => this.deps.logger.warn('Slack Socket Mode', { message: msg }),
        error: (msg: string) => this.deps.logger.error('Slack Socket Mode', { message: msg }),
      },
    });

    // Set up Socket Mode handlers via SlackSocketMode helper
    const socketHandler = new SlackSocketMode(
      this.socketClient,
      this.adapter,
      this.deps.logger
    );
    socketHandler.registerHandlers();

    // Connect to Slack
    await this.socketClient.start();
    this.deps.logger.info('Slack Socket Mode client connected');
  }

  /**
   * Initialize HTTP receiver for webhook-based events.
   */
  private async startHttpMode(): Promise<void> {
    if (!this.deps.config.port) {
      throw new Error('Port configuration required for HTTP receiver mode');
    }

    this.app = express();

    // Trust proxy headers if behind load balancer
    this.app.set('trust proxy', true);

    // Request body parsing for JSON payloads
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Request verification middleware
    const verifier = new SlackVerifier(this.deps.config);
    this.app.use('/slack/events', (req, res, next) => {
      try {
        verifier.verifyRequest(req);
        next();
      } catch (error) {
        this.deps.logger.warn('Request verification failed', {
          error: error.message,
          path: req.path,
          sourceIP: req.ip,
        });
        res.status(401).json({ error: 'Unauthorized' });
      }
    });

    // Set up HTTP handlers via SlackServer helper
    const slackServer = new SlackServer(this.adapter, this.deps.logger);
    slackServer.registerRoutes(this.app);

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Start HTTP server
    this.httpServer = this.app.listen(this.deps.config.port, () => {
      this.deps.logger.info('Slack HTTP receiver started', {
        port: this.deps.config.port,
      });
    });

    // Handle server errors
    this.httpServer.on('error', (error) => {
      this.deps.logger.error('HTTP server error', { error });
    });
  }

  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    
    signals.forEach((signal) => {
      process.on(signal, async () => {
        this.deps.logger.info(`Received ${signal}, initiating graceful shutdown...`);
        
        try {
          await this.shutdown();
          process.exit(0);
        } catch (error) {
          this.deps.logger.error('Error during graceful shutdown', { error });
          process.exit(1);
        }
      });
    });
  }
}

// Service entry point
export async function startSlackService(config: SlackConfig, router: IntakeRouter): Promise<SlackService> {
  const logger = createLogger('slack');
  
  // Validate configuration
  if (config.socketMode && !process.env.SLACK_APP_TOKEN) {
    throw new Error('Socket Mode requires SLACK_APP_TOKEN environment variable');
  }
  if (!config.socketMode && !config.port) {
    throw new Error('HTTP receiver mode requires port configuration');
  }

  const service = new SlackService({
    router,
    config,
    logger,
  });

  await service.start();
  return service;
}
```

### 8.4 Request Signature Verification

The Slack service implements comprehensive signature verification to prevent webhook forgery:

```typescript
export class SlackVerifier {
  constructor(private config: SlackConfig) {}

  /**
   * Verify Slack request signature using HMAC-SHA256.
   * Implements timing-safe comparison and timestamp validation.
   */
  verifyRequest(req: express.Request): void {
    const signature = req.headers['x-slack-signature'] as string;
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const body = JSON.stringify(req.body);

    if (!signature || !timestamp) {
      throw new Error('Missing required Slack headers');
    }

    // Verify timestamp within tolerance window
    const requestTime = parseInt(timestamp, 10) * 1000;
    const currentTime = Date.now();
    const tolerance = this.config.verification.timestampToleranceMs;

    if (Math.abs(currentTime - requestTime) > tolerance) {
      throw new Error('Request timestamp outside tolerance window');
    }

    // Compute expected signature
    const sigBaseString = `v0:${timestamp}:${body}`;
    const expectedSignature = 'v0=' + crypto
      .createHmac('sha256', this.config.signingSecret)
      .update(sigBaseString)
      .digest('hex');

    // Timing-safe comparison
    if (!crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )) {
      throw new Error('Invalid request signature');
    }
  }
}
```

### 8.5 Response Budget Management

Slack requires responses within 3 seconds to avoid interaction timeouts. The service implements request budgeting:

```typescript
export class SlackResponseManager {
  private static readonly RESPONSE_BUDGET_MS = 3000;

  async handleInteraction(interaction: SlackInteraction): Promise<void> {
    const startTime = Date.now();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Response budget exceeded')), 
                 SlackResponseManager.RESPONSE_BUDGET_MS);
    });

    try {
      const processingPromise = this.processInteraction(interaction);
      const result = await Promise.race([processingPromise, timeoutPromise]);
      
      const elapsed = Date.now() - startTime;
      this.deps.logger.info('Slack interaction processed', {
        interactionId: interaction.trigger_id,
        elapsedMs: elapsed,
        budgetMs: SlackResponseManager.RESPONSE_BUDGET_MS,
      });

      return result;
    } catch (error) {
      if (error.message === 'Response budget exceeded') {
        this.deps.logger.warn('Slack response budget exceeded', {
          interactionId: interaction.trigger_id,
        });
        // Send timeout response to Slack
        await this.sendTimeoutResponse(interaction);
      }
      throw error;
    }
  }
}
```

## 9. Shared IntakeRouter Integration

### 9.1 Enhanced Command Support

The existing IntakeRouter at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/core/intake_router.ts` requires minimal modification to support the new adapters:

**Current Command Set:**
- `submit`, `status`, `list`, `cancel`, `pause`, `resume`, `priority`, `logs`, `feedback`, `kill`

**New Gate-Action Commands:**
- `approve` — Approve a request pending review gate
- `request-changes` — Request changes during review gate
- `reject` — Reject a request at review gate

These gate-action commands support PRD-009's future portal functionality and manual approval workflows.

### 9.2 Source Metadata Contract

The router's `IncomingCommand` interface gains source validation logic:

```typescript
export interface IncomingCommand {
  commandName: string;
  args: string[];
  flags: Record<string, string | boolean>;
  rawText: string;
  source: CommandSource;  // Enhanced with authenticity validation
}

export interface CommandSource {
  channelType: 'cli' | 'claude_app' | 'discord' | 'slack';
  userId: string;
  platformChannelId?: string;
  threadId?: string;
  timestamp: Date;
  // New metadata fields
  sessionId?: string;      // Claude Code session ID
  guildId?: string;        // Discord guild ID
  workspaceId?: string;    // Slack workspace ID  
  processId?: number;      // CLI process PID
  workingDirectory?: string; // CLI working directory
}
```

### 9.3 Server-Side Source Assertion

The router validates that the declared source matches the adapter's registered identity (FR-823a):

```typescript
export class IntakeRouter {
  private registeredAdapters = new Map<string, ChannelType>();

  registerAdapter(adapterId: string, channelType: ChannelType): void {
    this.registeredAdapters.set(adapterId, channelType);
  }

  async route(command: IncomingCommand, userId: string, adapterId: string): Promise<CommandResult> {
    // Server-side source validation
    const expectedChannelType = this.registeredAdapters.get(adapterId);
    if (!expectedChannelType) {
      return {
        success: false,
        error: 'Unregistered adapter attempted command execution',
        errorCode: 'INTERNAL_ERROR',
      };
    }

    if (command.source.channelType !== expectedChannelType) {
      this.deps.authz.logSecurityEvent('source_spoofing_attempt', {
        declaredSource: command.source.channelType,
        actualSource: expectedChannelType,
        adapterId,
        userId,
      });
      
      return {
        success: false,
        error: 'Source channel mismatch detected',
        errorCode: 'AUTHZ_DENIED',
      };
    }

    // Continue with normal processing...
    return this.executeCommand(command, userId);
  }
}
```

### 9.4 CommandResult Standardization

The router returns standardized `CommandResult` objects that each adapter formats for its channel's UI conventions:

```typescript
export interface CommandResult {
  success: boolean;
  data?: {
    // Standardized data structure
    requestId?: string;
    status?: RequestStatus;
    queuePosition?: number;
    estimatedWait?: number;
    items?: Array<{
      id: string;
      title: string;
      status: RequestStatus;
      priority: Priority;
      createdAt: string;
      updatedAt: string;
    }>;
    logs?: Array<{
      timestamp: string;
      level: 'info' | 'warn' | 'error';
      message: string;
      phase?: string;
    }>;
  };
  error?: string;
  errorCode?: string;
  retryAfterMs?: number;
}
```

Adapters transform this standardized data into channel-specific rich content:
- **CLI**: ANSI color formatting and table layout
- **Claude App**: JSON response with syntax highlighting
- **Discord**: Rich embeds with progress bars and status indicators
- **Slack**: Block Kit layouts with interactive buttons

## 10. Configuration Schema Additions

### 10.1 Channel Configuration Structure

The intake configuration requires extensions to support multi-channel configuration:

```json
{
  "intake": {
    "channels": {
      "cli": {
        "enabled": true,
        "rateLimits": {
          "enabled": false
        }
      },
      "claude_app": {
        "enabled": true,
        "rateLimits": {
          "perSession": 5,
          "windowHours": 1
        }
      },
      "discord": {
        "enabled": true,
        "token": "${DISCORD_BOT_TOKEN}",
        "applicationId": "${DISCORD_APPLICATION_ID}",
        "guildId": "${DISCORD_GUILD_ID}",
        "rateLimits": {
          "perUser": 3,
          "perGuild": 20,
          "windowHours": 1
        },
        "reconnect": {
          "maxAttempts": 10,
          "baseDelayMs": 1000,
          "maxDelayMs": 60000
        }
      },
      "slack": {
        "enabled": false,
        "token": "${SLACK_BOT_TOKEN}",
        "signingSecret": "${SLACK_SIGNING_SECRET}",
        "socketMode": true,
        "port": 3000,
        "rateLimits": {
          "perUser": 5,
          "perWorkspace": 50,
          "windowHours": 1
        },
        "verification": {
          "timestampToleranceMs": 300000,
          "enableReplayProtection": true
        }
      }
    },
    "database": {
      "path": ".autonomous-dev/intake.db",
      "walMode": true,
      "backupIntervalHours": 24
    },
    "handoff": {
      "stateJsonPath": ".autonomous-dev/requests",
      "enableTwoPhaseCommit": true,
      "fsyncAfterWrite": true
    }
  }
}
```

### 10.2 Environment Variable References

Configuration supports environment variable substitution with validation:

```typescript
interface ConfigResolver {
  resolveEnvironmentReferences(config: object): object;
  validateRequiredVariables(config: object): string[];
  redactSecretsInShow(config: object): object;
}
```

**Redaction in config show:**
- `token` fields → `***REDACTED***`
- `signingSecret` fields → `***REDACTED***`
- `apiKey` fields → `***REDACTED***`
- All other fields displayed normally

### 10.3 Per-Channel Feature Flags

Each channel includes an `enabled` boolean flag allowing operators to disable problematic channels:

```bash
# Disable Discord channel while preserving configuration
autonomous-dev config set intake.channels.discord.enabled false

# Re-enable when issues resolved
autonomous-dev config set intake.channels.discord.enabled true
```

This enables surgical channel control without losing configuration state or affecting other channels.

## 11. Dependencies

### 11.1 Package.json Additions

The package.json requires additional dependencies for full functionality:

```json
{
  "dependencies": {
    "@slack/web-api": "^7.0.0",
    "@slack/socket-mode": "^2.0.0", 
    "express": "^4.21.0",
    "discord.js": "^14.14.1",
    "better-sqlite3": "^9.4.0",
    "commander": "^11.1.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.0",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.0",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.0",
    "typescript": "^5.6.0",
    "yaml": "^2.6.0"
  }
}
```

### 11.2 Version Pinning Strategy

**Major Dependencies:**
- `discord.js@^14.14.1` — Latest stable v14 with TypeScript support
- `better-sqlite3@^9.4.0` — Native SQLite driver with WAL mode support
- `commander@^11.1.0` — CLI argument parsing and validation
- `express@^4.21.0` — HTTP server for Slack webhook receiver

**Version Compatibility:**
- All dependencies are compatible with Node.js 18+ LTS
- TypeScript 5.6+ required for proper type inference
- No conflicting peer dependencies with existing codebase

### 11.3 Runtime Dependencies

**Node.js Requirements:**
- Version: 18.0.0+ (LTS)
- Features: ES2022 support, native fetch API, crypto.timingSafeEqual

**System Dependencies:**
- SQLite 3.38+ (provided by better-sqlite3)
- OpenSSL 1.1+ (for HMAC signature verification)

**Optional Dependencies:**
- `@types/better-sqlite3` for TypeScript support (already included in devDependencies)

### 11.4 Build Integration

The TypeScript build process requires updates to include new adapter entry points:

```json
{
  "scripts": {
    "build": "tsc --build",
    "build:adapters": "tsc intake/adapters/*/main.ts --outDir dist/adapters",
    "postbuild": "chmod +x dist/adapters/*/main.js"
  },
  "files": [
    "dist/**/*",
    "commands/**/*.md",
    "bin/**/*.sh"
  ]
}
```

## 12. Test Strategy

### 12.1 Unit Test Coverage

**Per-Adapter Unit Tests:**
- CLI adapter argument parsing and validation
- Discord service lifecycle and reconnection logic  
- Slack signature verification and request handling
- Claude command bridge proxy execution

**Mock Dependencies:**
- IntakeRouter with mock CommandResult responses
- Discord Client with simulated gateway events
- Express application with request/response mocks
- SQLite database with in-memory test instances

### 12.2 Integration Tests

**Cross-Adapter Integration:**
```typescript
describe('Multi-Channel Integration', () => {
  test('CLI submit → SQLite → state.json → daemon pickup', async () => {
    // 1. Submit via CLI adapter
    const cliResult = await cliAdapter.submit('Test request', {
      priority: 'normal',
      repo: 'test/repo',
    });
    
    // 2. Verify SQLite record
    const dbRecord = await repository.findById(cliResult.requestId);
    expect(dbRecord.source).toBe('cli');
    
    // 3. Verify state.json file exists
    const statePath = path.join(
      '.autonomous-dev/requests',
      cliResult.requestId,
      'state.json'
    );
    expect(fs.existsSync(statePath)).toBe(true);
    
    // 4. Verify daemon can read state
    const stateContent = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(stateContent.id).toBe(cliResult.requestId);
    expect(stateContent.source).toBe('cli');
  });

  test('Discord interaction → router → response formatting', async () => {
    // Mock Discord interaction
    const interaction = createMockInteraction('submit', {
      description: 'Test Discord request',
      priority: 'high',
    });
    
    // Process through adapter
    const result = await discordAdapter.handleInteraction(interaction);
    
    // Verify response format
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].title).toContain('Request Submitted');
    expect(result.embeds[0].fields).toContainEqual({
      name: 'Request ID',
      value: expect.stringMatching(/^REQ-\d{6}$/),
    });
  });
});
```

### 12.3 End-to-End Testing

**Full Pipeline E2E:**
```typescript
describe('Complete Submission Pipeline', () => {
  test('Submit → Queue → Daemon Pickup → Status Updates', async () => {
    // Start test daemon instance
    const daemon = await startTestDaemon();
    
    // Submit request via Claude App
    const submitResult = await claudeCommandBridge.execute('submit', [
      'Build authentication middleware',
      '--priority=high',
    ]);
    
    // Wait for daemon pickup
    await waitForDaemonPickup(submitResult.requestId);
    
    // Verify status progression
    const statusResult = await claudeCommandBridge.execute('status', [
      submitResult.requestId,
    ]);
    expect(statusResult.data.status).toBe('active');
    
    // Cleanup
    await daemon.stop();
  });
});
```

### 12.4 Graceful Shutdown Testing

**Service Lifecycle Tests:**
```typescript
describe('Service Lifecycle', () => {
  test('Discord service graceful shutdown under load', async () => {
    const service = await startDiscordService(testConfig, mockRouter);
    
    // Simulate concurrent interactions
    const interactions = Array.from({ length: 10 }, (_, i) => 
      simulateSlashCommand(`/submit description="Request ${i}"`)
    );
    
    // Start shutdown during processing
    setTimeout(() => service.shutdown(), 100);
    
    // Wait for all to complete or timeout
    const results = await Promise.allSettled(interactions);
    
    // Verify graceful handling
    const completed = results.filter(r => r.status === 'fulfilled').length;
    expect(completed).toBeGreaterThan(0); // Some should complete
    
    // Verify clean shutdown
    expect(service.isShutDown).toBe(true);
  }, 10000);
});
```

### 12.5 Security Testing

**Source Validation Tests:**
```typescript
describe('Source Authentication', () => {
  test('Rejects spoofed source channel', async () => {
    const command: IncomingCommand = {
      commandName: 'submit',
      args: ['malicious request'],
      flags: {},
      rawText: 'submit malicious request',
      source: {
        channelType: 'discord', // Claimed Discord source
        userId: 'fake-user',
        timestamp: new Date(),
      },
    };
    
    // Attempt routing through CLI adapter (mismatch)
    const result = await router.route(command, 'fake-user', 'cli-adapter');
    
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('AUTHZ_DENIED');
    expect(result.error).toContain('Source channel mismatch');
  });
});
```

## 13. Migration & Feature Flags

### 13.1 Rollout Strategy

The multi-channel adapters support phased rollout through per-channel feature flags:

**Phase 1: CLI Only (Week 1)**
```json
{
  "intake": {
    "channels": {
      "cli": { "enabled": true },
      "claude_app": { "enabled": false },
      "discord": { "enabled": false },
      "slack": { "enabled": false }
    }
  }
}
```

**Phase 2: CLI + Claude App (Week 2)**
```json
{
  "intake": {
    "channels": {
      "cli": { "enabled": true },
      "claude_app": { "enabled": true },
      "discord": { "enabled": false },
      "slack": { "enabled": false }
    }
  }
}
```

**Phase 3: Full Rollout (Week 3)**
```json
{
  "intake": {
    "channels": {
      "cli": { "enabled": true },
      "claude_app": { "enabled": true },
      "discord": { "enabled": true },
      "slack": { "enabled": true }
    }
  }
}
```

### 13.2 Configuration Migration

**Existing Configuration Preservation:**
- Current intake settings remain unchanged
- New channel configuration added alongside existing structure
- No breaking changes to existing API contracts

**Migration Script:**
```bash
#!/usr/bin/env bash
# migrate-config.sh - Update configuration for multi-channel support

set -euo pipefail

CONFIG_FILE="${HOME}/.autonomous-dev/config.json"

# Backup existing configuration
cp "${CONFIG_FILE}" "${CONFIG_FILE}.backup.$(date +%Y%m%d-%H%M%S)"

# Add channel configuration if not present
if ! jq -e '.intake.channels' "${CONFIG_FILE}" >/dev/null 2>&1; then
    jq '.intake.channels = {
      "cli": {"enabled": true, "rateLimits": {"enabled": false}},
      "claude_app": {"enabled": true, "rateLimits": {"perSession": 5, "windowHours": 1}},
      "discord": {"enabled": false, "rateLimits": {"perUser": 3, "perGuild": 20, "windowHours": 1}},
      "slack": {"enabled": false, "rateLimits": {"perUser": 5, "perWorkspace": 50, "windowHours": 1}}
    }' "${CONFIG_FILE}" > "${CONFIG_FILE}.tmp"
    
    mv "${CONFIG_FILE}.tmp" "${CONFIG_FILE}"
    echo "Configuration migrated successfully"
else
    echo "Channel configuration already present"
fi
```

### 13.3 Backward Compatibility

**Existing Command Compatibility:**
- All existing daemon commands (`install-daemon`, `daemon start`, etc.) unchanged
- New `request` subcommands additive, not replacing existing functionality
- Claude App commands discoverable alongside existing plugins

**API Compatibility:**
- IntakeRouter interface backwards compatible
- Existing adapters continue functioning without modification
- SQLite schema additions only (no breaking changes)

**State File Compatibility:**
- New state.json fields additive only
- Daemon continues reading existing state files
- Source metadata fields optional for backward compatibility

### 13.4 Monitoring and Rollback

**Health Checks:**
```bash
# Per-channel health verification
autonomous-dev request submit "Health check CLI" --priority=low
claude-command autonomous-dev-submit description="Health check Claude App" priority=low
# Discord: /submit Health check Discord
# Slack: /submit Health check Slack

# Verify all create valid state.json files
autonomous-dev config validate
```

**Rollback Plan:**
1. Disable problematic channel via feature flag
2. Revert package.json dependencies if needed
3. Restore configuration backup
4. Restart daemon to clear in-memory state

**Monitoring Metrics:**
- Request submission rate per channel
- Error rate per channel adapter
- State.json write success rate
- Daemon pickup latency

## 14. Open Questions

### 14.1 State.json Two-Phase Commit Implementation

**Question:** Should the two-phase commit implementation use filesystem locks or rely on atomic rename operations?

**Context:** FR-824a specifies two-phase commit with temp file creation, SQLite transaction, and atomic rename. The current design uses atomic rename for consistency, but high-concurrency scenarios might benefit from explicit file locking.

**Options:**
1. **Atomic rename only** — Simple, POSIX-compliant, but potential race conditions
2. **flock() + atomic rename** — More robust but platform-specific
3. **Application-level lock table** — Cross-platform but adds complexity

**Recommendation:** Start with atomic rename (Option 1) and add explicit locking if race conditions emerge during testing.

### 14.2 Discord Guild vs Global Command Registration

**Question:** Should Discord slash commands be registered globally or guild-specific by default?

**Context:** Guild commands appear instantly but are limited to configured guilds. Global commands take up to 1 hour to propagate but work across all guilds.

**Implications:**
- **Guild-specific:** Fast deployment, testing friendly, requires guild ID configuration
- **Global:** Broader reach, slower deployment, no guild configuration needed

**Recommendation:** Default to guild-specific with global as a configuration option. Most deployments are single-organization.

### 14.3 Rate Limiting Enforcement Point

**Question:** Should rate limiting occur at the adapter level or router level?

**Context:** Current design implements rate limiting in the router after user resolution. This provides consistent limits but means adapters must handle rate limit errors.

**Options:**
1. **Router-level** — Consistent across channels but requires error propagation
2. **Adapter-level** — Channel-specific logic but potential inconsistencies  
3. **Hybrid** — Basic checks in adapters, precise enforcement in router

**Recommendation:** Keep router-level enforcement for consistency. Adapters handle error formatting appropriately for their channel.

### 14.4 Claude Code Session Identification

**Question:** How should Claude App commands identify sessions for rate limiting?

**Context:** Claude Code may not expose session IDs consistently across invocations. Rate limiting requires stable user identification.

**Options:**
1. **Environment variable** — Require CLAUDE_SESSION_ID in environment
2. **Process parent detection** — Infer from parent process information
3. **User-based only** — Skip session-level limits, rely on user identity

**Recommendation:** Use environment variable with fallback to user-based limiting if session ID unavailable.

### 14.5 Error Message Sanitization

**Question:** Should error messages be sanitized differently for different channels?

**Context:** CLI and Claude App can show detailed errors including file paths. Discord and Slack should not leak internal system information.

**Security Implication:** Untrusted channels (Discord/Slack) should receive generic error messages while trusted channels (CLI/Claude App) can receive detailed diagnostics.

**Recommendation:** Implement error message sanitization based on channel trust level, with detailed errors for trusted channels and generic messages for public channels.

## 15. References

### Technical Design Documents
- **TDD-001: Daemon Engine** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-001-daemon-engine.md`
- **TDD-008: Intake & Communication Layer** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-008-intake-layer.md`

### Product Requirements Documents  
- **PRD-008: Unified Request Submission Packaging** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-008-unified-request-submission.md`

### Implementation Files
- **Adapter Interface** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/adapter_interface.ts`
- **IntakeRouter** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/core/intake_router.ts`
- **Claude Adapter** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/claude_adapter.ts`
- **Discord Adapter** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/discord/discord_adapter.ts`
- **Slack Adapter** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/adapters/slack/slack_adapter.ts`
- **CLI Dispatcher** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/bin/autonomous-dev.sh`
- **Submit Handler** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/intake/handlers/submit_handler.ts`

### External Dependencies
- **discord.js Documentation** — https://discord.js.org/docs/
- **Slack Bolt Framework** — https://slack.dev/bolt-js/
- **Commander.js** — https://github.com/tj/commander.js
- **better-sqlite3** — https://github.com/WiseLibs/better-sqlite3
- **no-color.org Standard** — https://no-color.org/

### Standards and Specifications
- **RFC 3339 (ISO 8601)** — Date/time format specification
- **POSIX.1-2017** — File system atomicity guarantees
- **Discord API Documentation** — https://discord.com/developers/docs/
- **Slack API Documentation** — https://api.slack.com/

---

## 16. Cross-TDD Contract: Handoff API (Aligns with TDD-012)

The architecture review identified an interface mismatch between this TDD's `IncomingCommand` shape and TDD-012's handoff API. This section pins the canonical contract.

### 16.1 IncomingCommand → SubmitRequest Adapter

The intake router (this TDD's responsibility) accepts `IncomingCommand` from each adapter:

```typescript
interface IncomingCommand {
  commandName: string;          // 'submit', 'status', etc.
  args: string[];
  flags: Record<string, string | boolean>;
  rawText: string;
  source: CommandSource;        // see §9
}
```

For `commandName === 'submit'`, the router converts `IncomingCommand` to `SubmitRequest` (the shape TDD-012's `submitRequestWithHandoff()` expects):

```typescript
function buildSubmitRequest(cmd: IncomingCommand): SubmitRequest {
  return {
    description: cmd.args[0],
    priority: (cmd.flags['priority'] as Priority) ?? 'normal',
    targetRepo: resolveRepoPath(cmd.flags['repo'] as string ?? cmd.source.cwd),
    deadline: cmd.flags['deadline'] as string | undefined,
    source: cmd.source.source,                     // 'cli' | 'claude-app' | 'discord' | 'slack' | 'portal'
    adapterMetadata: extractAdapterMetadata(cmd.source),
  };
}
```

The conversion happens inside the submit handler (`intake/handlers/submit_handler.ts`), not the adapter. Adapters only construct `IncomingCommand`.

### 16.2 Source Metadata Schema (Canonical)

The `source` and `adapter_metadata` fields are specified jointly across TDD-011, TDD-012, TDD-014, and TDD-015. The canonical schema is owned by TDD-012 §7. This TDD's adapters populate it; the portal (TDD-014/015) reads it; TDD-012 persists it.

### 16.3 Gate-Action Commands

This TDD's adapters do NOT submit gate-action commands (`approve`, `request-changes`, `reject`). Those are exclusively portal-originated (PRD-009 FR-915, TDD-015) and arrive at the intake router via the portal's HTTP client. The router's command vocabulary supports them, but adapter implementations from this TDD reject them as out-of-scope.

---
