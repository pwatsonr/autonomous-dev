# TDD: Customer Feedback Analytics Dashboard

## Metadata
- **Document ID**: TDD-SILVER-001
- **Version**: 1.0.0
- **Parent PRD**: PRD-SILVER-001
- **Author**: Senior Engineer
- **Status**: Draft
- **Created**: 2026-03-20
- **Last Updated**: 2026-03-25

## 1. Architecture Overview

The Feedback Analytics Dashboard uses a layered architecture with three main components:

1. **Data Ingestion Layer**: ETL pipelines that pull feedback from external sources on a scheduled basis and normalize it into a common format.
2. **Analysis Engine**: NLP processing pipeline for sentiment analysis, theme extraction, and trend detection.
3. **Presentation Layer**: React-based dashboard with real-time filtering and visualization.

### 1.1 Technology Stack

| Component | Technology | Justification |
|-----------|-----------|---------------|
| Backend API | Python + FastAPI | Async support; team expertise; rapid development |
| Data Pipeline | Apache Airflow | Scheduled ETL orchestration; monitoring built-in |
| NLP Engine | OpenAI GPT-4 API + spaCy | High accuracy sentiment analysis; spaCy for preprocessing |
| Database | PostgreSQL 16 | Relational queries for segmentation; JSONB for flexible feedback schemas |
| Search | Elasticsearch 8 | Full-text search with relevance ranking; faceted filtering |
| Frontend | React 18 + Recharts | Interactive dashboards; team expertise |
| Cache | Redis 7 | Session caching; query result caching |

## 2. Data Model

### 2.1 Core Entities

```sql
CREATE TABLE feedback_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          VARCHAR(50) NOT NULL,
    source_id       VARCHAR(255) NOT NULL,
    user_id         UUID,
    content         TEXT NOT NULL,
    sentiment_score DECIMAL(3,2),
    sentiment_label VARCHAR(20),
    themes          VARCHAR(100)[],
    metadata        JSONB DEFAULT '{}',
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_created_at TIMESTAMPTZ,
    UNIQUE(source, source_id)
);

CREATE TABLE segments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    created_by  UUID NOT NULL,
    filters     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE feedback_jira_links (
    feedback_id UUID REFERENCES feedback_items(id),
    jira_key    VARCHAR(50) NOT NULL,
    linked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (feedback_id, jira_key)
);
```

## 3. API Design

### 3.1 Search Feedback

```
GET /api/v1/feedback?q=search+term&sentiment=negative&source=zendesk&page=1&size=20

Response: 200 OK
{
  "items": [...],
  "total": 245,
  "page": 1,
  "pages": 13
}
```

### 3.2 Create Segment

```
POST /api/v1/segments
{
  "name": "Enterprise users - negative sentiment",
  "filters": {
    "plan_type": "enterprise",
    "sentiment_label": "negative",
    "date_range": { "from": "2026-01-01", "to": "2026-03-31" }
  }
}
```

## 4. Data Ingestion Pipeline

### 4.1 Source Adapters

Each source has a dedicated adapter that:
1. Connects to the source API with configured credentials
2. Fetches new feedback since last sync checkpoint
3. Normalizes into the common `feedback_items` schema
4. Handles rate limiting and retries

### 4.2 Schedule

| Source | Sync Frequency | Method |
|--------|---------------|--------|
| Zendesk | Every 30 minutes | REST API polling |
| Delighted | Every 1 hour | REST API polling |
| Twitter/X | Every 15 minutes | Streaming API with polling fallback |
| In-app surveys | Real-time | Webhook push |

## 5. Trade-off Decisions

### 5.1 GPT-4 vs Fine-tuned BERT for Sentiment

**Decision**: GPT-4 API

**Rationale**: GPT-4 achieves 90%+ accuracy on sentiment tasks out of the box, exceeding the 85% target. A fine-tuned BERT model could reduce per-request cost by ~10x but requires 6-8 weeks of training data collection and model development. Given the timeline pressure and accuracy requirements, GPT-4 is the pragmatic choice. We will monitor costs and revisit if monthly NLP costs exceed $5,000.

<!-- KNOWN ISSUE: tradeoff_rigor ~70. Missing quantitative cost analysis for GPT-4 vs BERT. Does not discuss latency tradeoffs or fallback strategy if GPT-4 API is unavailable. -->

### 5.2 Elasticsearch vs PostgreSQL Full-Text Search

**Decision**: Elasticsearch

**Rationale**: PostgreSQL's `tsvector` search handles basic queries well, but the dashboard requires faceted filtering, relevance scoring, and aggregations across 500K+ feedback items. Elasticsearch provides sub-200ms search latency at this scale with built-in faceting. The operational overhead of running Elasticsearch is justified by the search experience requirements.

## 6. Error Handling

### 6.1 Ingestion Errors

| Error | Handling |
|-------|---------|
| Source API unavailable | Retry with exponential backoff; alert after 3 failures; skip source until next cycle |
| Rate limit exceeded | Backoff per provider rate limit headers; reduce batch size |
| Duplicate feedback | Upsert based on (source, source_id); no error raised |
| Malformed response | Log and skip item; alert if > 5% of batch fails parsing |

<!-- KNOWN ISSUE: error_handling ~72. Missing error handling for NLP pipeline failures. What happens when GPT-4 API returns errors or times out during sentiment analysis? No retry/fallback strategy documented. -->

### 6.2 API Errors

| Error | Handling |
|-------|---------|
| Database timeout | Return 503; circuit breaker with 10s half-open |
| Elasticsearch unavailable | Fall back to PostgreSQL full-text search (degraded) |
| Invalid segment filter | Return 400 with validation details |

## 7. Security

- API authentication via OAuth 2.0 (Auth0)
- Row-level security for feedback visibility based on team membership
- PII fields encrypted at rest
- GDPR compliance: data anonymization pipeline runs nightly; deletion requests processed within 72 hours
- Audit log for segment creation and Jira linking

## 8. Testing Strategy

### 8.1 Unit Tests
- Source adapter normalization logic
- Sentiment analysis accuracy on labeled test set (target >= 85%)
- Segment filter SQL generation

### 8.2 Integration Tests
- End-to-end ingestion pipeline with sandbox API accounts
- Search query accuracy with Elasticsearch test index
- Jira bidirectional sync validation

### 8.3 Performance Tests
- Search latency under load: < 500ms p95 with 50 concurrent users
- Ingestion throughput: 10,000 items/hour per source
- Dashboard render time: < 3s with 500K items in DB
