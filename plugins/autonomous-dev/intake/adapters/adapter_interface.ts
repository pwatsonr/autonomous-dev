/**
 * Shared TypeScript interfaces for the Intake Layer.
 *
 * Defines all adapter-to-core contracts: channel primitives, messaging,
 * command dispatch, NLP parsing, authorization, notification, and error types.
 *
 * @module adapter_interface
 */

// ---------------------------------------------------------------------------
// Channel and adapter primitives
// ---------------------------------------------------------------------------

/** Supported intake channel types. */
export type ChannelType = 'claude_app' | 'discord' | 'slack' | 'cli';

/**
 * Core adapter interface that every channel adapter must implement.
 * Provides lifecycle management (start/shutdown) and bidirectional messaging.
 */
export interface IntakeAdapter {
  /** The channel type this adapter serves. */
  readonly channelType: ChannelType;

  /** Start the adapter and return a handle for disposal. */
  start(): Promise<AdapterHandle>;

  /** Send a formatted message to the specified target. */
  sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt>;

  /**
   * Prompt the user with a structured question and await their response.
   * Returns either the user's response or a timeout indicator.
   */
  promptUser(target: MessageTarget, prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired>;

  /** Gracefully shut down the adapter, releasing all resources. */
  shutdown(): Promise<void>;
}

/** Handle returned by adapter start; used for cleanup/disposal. */
export interface AdapterHandle {
  /** Dispose of the adapter resources. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Messaging types
// ---------------------------------------------------------------------------

/**
 * Identifies the destination for a message: channel, user, thread.
 */
export interface MessageTarget {
  /** The channel type to deliver through. */
  channelType: ChannelType;
  /** Platform-specific user identifier. */
  userId?: string;
  /** Platform-specific channel identifier. */
  platformChannelId?: string;
  /** Thread identifier for threaded replies. */
  threadId?: string;
  /** Whether this is a direct message. */
  isDM?: boolean;
}

/**
 * A message formatted for a specific channel, with a fallback for
 * channels that do not support rich content.
 */
export interface FormattedMessage {
  /** The channel type this message is formatted for. */
  channelType: ChannelType;
  /** Channel-specific payload (e.g., Embed, Block[], or plain string). */
  payload: unknown;
  /** Plain text fallback for channels without rich formatting. */
  fallbackText: string;
}

/**
 * A structured prompt sent to a user, expecting a response within a timeout.
 */
export interface StructuredPrompt {
  /** The kind of prompt being sent. */
  promptType: 'clarifying_question' | 'approval_request' | 'escalation';
  /** The request this prompt is associated with. */
  requestId: string;
  /** The prompt content displayed to the user. */
  content: string;
  /** Optional selectable options presented to the user. */
  options?: PromptOption[];
  /** How long (in seconds) to wait for a response before timing out. */
  timeoutSeconds: number;
}

/** A selectable option within a structured prompt. */
export interface PromptOption {
  /** Display label for the option. */
  label: string;
  /** Machine-readable value returned when selected. */
  value: string;
  /** Visual style hint for the option button. */
  style?: 'primary' | 'secondary' | 'danger';
}

/**
 * A user's response to a structured prompt.
 */
export interface UserResponse {
  /** The platform user ID of the responder. */
  responderId: string;
  /** Free-text content of the response. */
  content: string;
  /** The value of the selected option, if an option was chosen. */
  selectedOption?: string;
  /** When the response was received. */
  timestamp: Date;
}

/**
 * Indicates that a prompt timed out without a user response.
 */
export interface TimeoutExpired {
  /** Discriminant for type narrowing. */
  kind: 'timeout';
  /** The request ID that timed out. */
  requestId: string;
  /** When the prompt was originally sent. */
  promptedAt: Date;
  /** When the timeout expired. */
  expiredAt: Date;
}

/**
 * Receipt confirming the outcome of a message delivery attempt.
 */
export interface DeliveryReceipt {
  /** Whether the delivery succeeded. */
  success: boolean;
  /** Platform-assigned message ID on success. */
  platformMessageId?: string;
  /** Error description on failure. */
  error?: string;
  /** Whether a failed delivery can be retried. */
  retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Command dispatch types
// ---------------------------------------------------------------------------

/**
 * A parsed incoming command from any channel.
 */
export interface IncomingCommand {
  /** The command name (e.g., 'submit', 'status', 'cancel'). */
  commandName: string;
  /** Positional arguments. */
  args: string[];
  /** Named flags (boolean flags or key=value pairs). */
  flags: Record<string, string | boolean>;
  /** The original raw text of the command. */
  rawText: string;
  /** Where this command originated. */
  source: CommandSource;
}

/**
 * Metadata about the source of a command.
 */
export interface CommandSource {
  /** Which channel the command came from. */
  channelType: ChannelType;
  /** Platform user ID of the command sender. */
  userId: string;
  /** Platform channel where the command was issued. */
  platformChannelId?: string;
  /** Thread ID if the command was in a thread. */
  threadId?: string;
  /** When the command was received. */
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// NLP / parsing types
// ---------------------------------------------------------------------------

/**
 * The result of NLP parsing of a natural-language request.
 */
export interface ParsedRequest {
  /** Short summary title extracted from the request. */
  title: string;
  /** Detailed description of what is being requested. */
  description: string;
  /** Inferred priority level. */
  priority: 'high' | 'normal' | 'low';
  /** Target repository, or null if not specified. */
  target_repo: string | null;
  /** Deadline string (ISO 8601), or null if not specified. */
  deadline: string | null;
  /** Related Jira/issue ticket identifiers. */
  related_tickets: string[];
  /** Technical constraints mentioned in the request. */
  technical_constraints: string | null;
  /** Acceptance criteria extracted from the request. */
  acceptance_criteria: string | null;
  /** NLP confidence score (0.0 to 1.0). */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Standardized error response returned by the intake layer.
 */
export interface ErrorResponse {
  /** Always false for error responses. */
  success: false;
  /** Human-readable error message. */
  error: string;
  /** Machine-readable error code. */
  errorCode: string;
  /** Milliseconds to wait before retrying (for rate-limited errors). */
  retryAfterMs?: number;
  /** Additional error context. */
  details?: Record<string, unknown>;
}

/** Enumeration of all possible error codes in the intake layer. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHZ_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'QUEUE_FULL'
  | 'DUPLICATE_DETECTED'
  | 'INJECTION_BLOCKED'
  | 'INJECTION_FLAGGED'
  | 'INTERNAL_ERROR'
  | 'PLATFORM_ERROR';

// ---------------------------------------------------------------------------
// Command handler types
// ---------------------------------------------------------------------------

/**
 * Interface for command handlers that process specific intake commands.
 */
export interface CommandHandler {
  /** Execute the command for the given user and return the result. */
  execute(command: IncomingCommand, userId: string): Promise<CommandResult>;

  /** Build the authorization context needed to check permissions. */
  buildAuthzContext(command: IncomingCommand): AuthzContext;

  /** Whether this handler is read-only (queries do not mutate state). */
  isQueryCommand(): boolean;
}

/**
 * The result of executing a command.
 */
export interface CommandResult {
  /** Whether the command executed successfully. */
  success: boolean;
  /** Result data on success. */
  data?: unknown;
  /** Error description on failure. */
  error?: string;
  /** Machine-readable error code on failure. */
  errorCode?: string;
  /** Milliseconds to wait before retrying (for rate-limited commands). */
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Notification types
// ---------------------------------------------------------------------------

/** Controls how much detail is included in notifications. */
export type VerbosityLevel = 'silent' | 'summary' | 'verbose' | 'debug';

/**
 * Configuration for how and where notifications are delivered.
 */
export interface NotificationConfig {
  /** The verbosity level for notifications. */
  verbosity: VerbosityLevel;
  /** Routing rules for where to send notifications. */
  routes: NotificationRoute[];
}

/**
 * A single notification routing rule.
 */
export interface NotificationRoute {
  /** Which channel type to route notifications to. */
  channelType: ChannelType;
  /** Platform channel to deliver to. */
  platformChannelId?: string;
  /** Thread to deliver within. */
  threadId?: string;
  /** Event names to filter on; if omitted, all events match. */
  events?: string[];
}

// ---------------------------------------------------------------------------
// Authz types
// ---------------------------------------------------------------------------

/** Actions that can be authorized in the intake layer. */
export type AuthzAction =
  | 'submit' | 'status' | 'list' | 'cancel' | 'pause'
  | 'resume' | 'priority' | 'logs' | 'feedback' | 'kill'
  | 'approve_review' | 'config_change';

/**
 * Context provided to the authorization system for access decisions.
 */
export interface AuthzContext {
  /** The request being acted upon. */
  requestId?: string;
  /** The target repository, if applicable. */
  targetRepo?: string;
  /** The review gate, if applicable. */
  gate?: string;
}

/**
 * The result of an authorization check.
 */
export interface AuthzDecision {
  /** Whether access was granted. */
  granted: boolean;
  /** The user whose access was checked. */
  userId: string;
  /** The action that was checked. */
  action: AuthzAction;
  /** Human-readable explanation for the decision. */
  reason: string;
  /** When the decision was made. */
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Shared enums / aliases
// ---------------------------------------------------------------------------

/** Request priority levels. */
export type Priority = 'high' | 'normal' | 'low';

/** Lifecycle states a request can be in. */
export type RequestStatus = 'queued' | 'active' | 'paused' | 'cancelled' | 'done' | 'failed';
