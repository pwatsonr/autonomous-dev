# TDD: Unified Notification Delivery Platform

## Metadata
- **Document ID**: TDD-GOLD-001
- **Version**: 1.0.0
- **Parent PRD**: PRD-GOLD-001
- **Author**: Staff Engineer
- **Status**: Draft
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-28

## 1. Architecture Overview

The Unified Notification Delivery Platform follows an event-driven microservices architecture with a central message bus (Apache Kafka) coordinating asynchronous notification processing. The system comprises five core services:

1. **Notification Gateway** (API layer): Accepts notification requests, validates payloads, and publishes to the processing pipeline.
2. **Router Service**: Consumes notification events, resolves channel preferences, and determines routing strategy (primary + fallback channels).
3. **Channel Adapters** (email, SMS, push, webhook): Stateless workers that execute delivery via provider SDKs and publish delivery status events.
4. **Delivery Tracker**: Consumes delivery status events, manages receipt confirmation, and triggers escalation timers.
5. **Analytics Service**: Aggregates delivery metrics into time-series storage for dashboards and reporting.

### 1.1 Architecture Diagram

```
[Client] --> [Notification Gateway (REST API)]
                |
                v
        [Kafka: notification-requests]
                |
                v
        [Router Service]
        |       |       |       |
        v       v       v       v
    [Email]  [SMS]  [Push]  [Webhook]  (Channel Adapters)
        |       |       |       |
        v       v       v       v
        [Kafka: delivery-status]
                |
                v
        [Delivery Tracker]
                |
        +-------+-------+
        |               |
        v               v
[Escalation]    [Analytics Service]
(PagerDuty)     (Time-series DB)
```

### 1.2 Technology Stack

| Component | Technology | Justification |
|-----------|-----------|---------------|
| API Gateway | Node.js + Fastify | Low-latency HTTP handling; team expertise; < 200ms p99 target achievable |
| Message Bus | Apache Kafka | Durable message ordering; proven at 10K+ msg/s; exactly-once semantics |
| Router Service | Go | High throughput goroutine-based processing; low memory footprint |
| Channel Adapters | Go | CPU-efficient for I/O-bound provider calls; consistent with Router |
| Delivery Tracker | Go | Event-driven state machine; low-latency escalation timer management |
| Analytics Service | Python + Apache Flink | Stream processing for real-time aggregation; Flink handles windowing natively |
| Primary DB | PostgreSQL 16 | ACID transactions for delivery records; JSONB for flexible metadata |
| Time-Series DB | TimescaleDB | Built on PostgreSQL; hypertable partitioning for metric queries |
| Cache | Redis 7 | Channel preference caching; pub/sub for real-time dashboard updates |
| Object Storage | AWS S3 | Cold archive for delivery records beyond 90-day retention |

## 2. Data Model

### 2.1 Core Entities

```sql
-- Notification request as received from the API
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id     VARCHAR(255) UNIQUE,
    type            VARCHAR(50) NOT NULL,       -- 'security', 'billing', 'operational', 'informational'
    criticality     VARCHAR(20) NOT NULL,       -- 'critical', 'high', 'medium', 'low'
    recipient_id    UUID NOT NULL REFERENCES users(id),
    payload         JSONB NOT NULL,
    channel_hints   VARCHAR(20)[] DEFAULT '{}', -- preferred channels from caller
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delivery attempt per channel
CREATE TABLE delivery_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL REFERENCES notifications(id),
    channel         VARCHAR(20) NOT NULL,       -- 'email', 'sms', 'push', 'webhook'
    provider        VARCHAR(50) NOT NULL,       -- 'sendgrid', 'twilio', 'firebase', etc.
    attempt_number  INT NOT NULL,
    status          VARCHAR(20) NOT NULL,       -- 'pending', 'sent', 'delivered', 'failed', 'bounced'
    provider_ref    VARCHAR(255),               -- provider-specific message ID
    error_code      VARCHAR(50),
    error_message   TEXT,
    sent_at         TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delivery receipt confirmation
CREATE TABLE delivery_receipts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_attempt_id UUID NOT NULL REFERENCES delivery_attempts(id),
    confirmation_method VARCHAR(50) NOT NULL,   -- 'provider_callback', 'read_receipt', 'probabilistic'
    confidence          DECIMAL(3,2) NOT NULL,  -- 0.00 to 1.00
    confirmed_at        TIMESTAMPTZ NOT NULL,
    metadata            JSONB DEFAULT '{}'
);

-- User channel preferences
CREATE TABLE channel_preferences (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    notification_type VARCHAR(50) NOT NULL,
    channel_ranking VARCHAR(20)[] NOT NULL,     -- ordered list: ['push', 'email', 'sms']
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, notification_type)
);

-- Escalation records
CREATE TABLE escalations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL REFERENCES notifications(id),
    reason          TEXT NOT NULL,
    escalated_to    VARCHAR(255) NOT NULL,      -- PagerDuty incident ID or operator email
    escalated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolution      TEXT
);
```

### 2.2 Indexes

```sql
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, created_at DESC);
CREATE INDEX idx_notifications_status ON notifications(status) WHERE status != 'delivered';
CREATE INDEX idx_delivery_attempts_notification ON delivery_attempts(notification_id, attempt_number);
CREATE INDEX idx_delivery_attempts_status ON delivery_attempts(status) WHERE status IN ('pending', 'sent');
CREATE INDEX idx_channel_preferences_user ON channel_preferences(user_id);
```

## 3. API Design

### 3.1 Send Notification

```
POST /api/v1/notifications
Content-Type: application/json
Authorization: Bearer <token>

{
  "type": "security",
  "criticality": "critical",
  "recipient_id": "uuid",
  "payload": {
    "subject": "Security Alert: Unauthorized Access Attempt",
    "body": "An unauthorized access attempt was detected...",
    "template_id": "security-alert-v2",
    "template_vars": { "ip": "192.168.1.100", "timestamp": "2026-03-28T10:30:00Z" }
  },
  "channel_hints": ["push", "email"],
  "idempotency_key": "unique-key-123"
}

Response: 202 Accepted
{
  "tracking_id": "uuid",
  "status": "accepted",
  "estimated_delivery": "2026-03-28T10:30:05Z"
}
```

### 3.2 Get Delivery Status

```
GET /api/v1/notifications/{tracking_id}/status

Response: 200 OK
{
  "tracking_id": "uuid",
  "status": "delivered",
  "channel": "push",
  "attempts": [
    { "channel": "push", "status": "delivered", "delivered_at": "2026-03-28T10:30:03Z" }
  ],
  "receipt": {
    "confirmed": true,
    "confidence": 0.99,
    "method": "provider_callback"
  }
}
```

### 3.3 Batch Send

```
POST /api/v1/notifications/batch
Content-Type: application/json

{
  "notifications": [ ... ],  // up to 10,000 items
  "batch_id": "unique-batch-id"
}

Response: 202 Accepted
{
  "batch_id": "unique-batch-id",
  "accepted": 9995,
  "rejected": 5,
  "tracking_url": "/api/v1/batches/unique-batch-id/status"
}
```

## 4. Routing Algorithm

### 4.1 Channel Selection

```
function selectChannels(notification, userPrefs, adminConfig):
    1. Determine candidate channels from notification type config
    2. Apply user preferences (reorder candidates by user ranking)
    3. Apply channel_hints from caller (boost hinted channels)
    4. For critical notifications: ensure >= 2 channels selected
    5. Return ordered list: [primary, fallback_1, fallback_2, ...]
```

### 4.2 Fallback Strategy

```
function executeDelivery(notification, channels):
    for channel in channels:
        attempt = sendViaChannel(channel, notification)
        if attempt.status == 'delivered':
            return SUCCESS
        if attempt.status == 'failed':
            wait(min(60s, remaining_sla_time))
            continue  // try next channel
    
    if notification.criticality in ['critical', 'high']:
        triggerEscalation(notification)
    
    return FAILED
```

## 5. Trade-off Decisions

### 5.1 Kafka vs RabbitMQ

**Decision**: Kafka

| Criterion | Kafka | RabbitMQ |
|-----------|-------|----------|
| Throughput | 100K+ msg/s per partition | ~20K msg/s per queue |
| Durability | Replicated log, configurable retention | Durable queues with disk persistence |
| Ordering | Per-partition ordering guaranteed | Per-queue FIFO |
| Consumer groups | Native support | Plugin-based |
| Replay capability | Full replay from any offset | No native replay |

**Rationale**: The 10K notifications/second throughput requirement (NFR3) with room for 10x growth makes Kafka the clear choice. Replay capability enables reprocessing after bug fixes without data loss. The tradeoff is higher operational complexity, mitigated by using managed Kafka (AWS MSK).

### 5.2 Synchronous vs Asynchronous API

**Decision**: Asynchronous (202 Accepted)

**Rationale**: Synchronous delivery would block the API caller for up to 60s (fallback timeout), violating the < 200ms p99 latency requirement (NFR1). Asynchronous acceptance with webhook callbacks provides fast API response while enabling complex multi-channel routing. The tradeoff is that callers must implement webhook handling or polling, addressed by providing an SDK with built-in webhook handler.

### 5.3 Single DB vs Separate Read/Write Stores

**Decision**: Single PostgreSQL with read replicas

**Rationale**: The write volume (~10K records/s for delivery attempts) is within PostgreSQL's capability with proper partitioning. Read replicas handle dashboard queries without impacting write performance. TimescaleDB is used specifically for time-series analytics, keeping the operational and analytical workloads separated. A full CQRS architecture was considered but rejected as premature given the projected load.

## 6. Error Handling

### 6.1 Provider Errors

| Error Type | Handling | Retry Strategy |
|-----------|---------|----------------|
| Rate limit (429) | Exponential backoff with jitter | 3 retries, 1s/2s/4s base delay |
| Server error (5xx) | Immediate retry, then fallback | 2 retries, 500ms delay, then next channel |
| Authentication error (401/403) | Alert ops, fallback to backup provider | No retry; switch provider immediately |
| Invalid recipient (400) | Mark notification as permanently failed | No retry; log for data quality review |
| Timeout (no response in 30s) | Treat as failure, try next channel | No retry on same channel; count toward fallback |

### 6.2 Internal Errors

| Error Type | Handling | Recovery |
|-----------|---------|----------|
| Kafka unavailable | Write to local WAL, retry on reconnect | WAL replayed in order on Kafka recovery |
| Database unavailable | Return 503 to API callers; queue in memory (bounded) | Circuit breaker with 30s half-open interval |
| Redis cache miss | Fall through to database for preferences | Cache rebuilt on next successful DB read |
| Channel adapter crash | Kubernetes restarts pod; Kafka rebalances consumer | At-least-once delivery via Kafka consumer offsets |

## 7. Security

### 7.1 Authentication & Authorization

- API authentication via OAuth 2.0 bearer tokens with JWT validation
- Service-to-service authentication via mutual TLS (mTLS)
- Role-based access: `notification:send`, `notification:read`, `notification:admin`
- Rate limiting: 1,000 requests/minute per API key; 100 requests/minute for batch endpoint

### 7.2 Data Protection

- All notification payloads encrypted at rest (AES-256-GCM) in PostgreSQL via pgcrypto
- TLS 1.3 for all inter-service communication
- PII fields (recipient email, phone) encrypted with separate key; key rotation every 90 days
- Delivery records pseudonymized after 90-day hot retention period
- Audit log for all preference changes and escalation actions

## 8. Observability

### 8.1 Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `notification_accepted_total` | Counter | type, criticality |
| `notification_delivered_total` | Counter | type, channel, provider |
| `notification_failed_total` | Counter | type, channel, error_type |
| `delivery_latency_seconds` | Histogram | channel, criticality |
| `escalation_triggered_total` | Counter | type, reason |
| `channel_fallback_total` | Counter | from_channel, to_channel |

### 8.2 Alerts

| Alert | Condition | Severity |
|-------|----------|----------|
| High failure rate | failure_rate > 5% over 5 minutes | P1 |
| Delivery latency spike | p99 > 30s over 5 minutes | P2 |
| Escalation surge | > 10 escalations in 15 minutes | P1 |
| Provider degradation | single provider failure_rate > 20% | P2 |
| Kafka consumer lag | consumer lag > 10,000 messages | P2 |

## 9. Testing Strategy

### 9.1 Unit Tests
- Channel selection algorithm with various preference combinations
- Fallback logic with simulated provider failures
- Escalation timer management
- Delivery receipt confidence scoring

### 9.2 Integration Tests
- End-to-end notification flow via test Kafka cluster
- Provider SDK integration with sandbox environments
- Database migration validation

### 9.3 Load Tests
- Sustained 10K notifications/s for 1 hour
- Burst to 50K notifications/s for 5 minutes
- Graceful degradation under 100K notifications/s

## 10. Migration Plan

### 10.1 Phase 1: Shadow Mode (2 weeks)
- Deploy new system alongside existing notification subsystems
- Mirror all notifications to new system without delivery (shadow traffic)
- Compare routing decisions and measure latency

### 10.2 Phase 2: Canary (2 weeks)
- Route 5% of non-critical notifications through new system
- Monitor delivery success rate and latency
- Gradually increase to 25%, 50%, 100% for non-critical

### 10.3 Phase 3: Full Migration (2 weeks)
- Route critical notifications through new system with old system as fallback
- Monitor escalation rates
- Decommission old subsystems after 2-week stability period
