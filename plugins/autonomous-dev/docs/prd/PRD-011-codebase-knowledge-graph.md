# PRD-011: Codebase Knowledge Graph & Understanding

| Field | Value |
|---|---|
| Title | PRD-011: Codebase Knowledge Graph & Understanding |
| ID | PRD-011 |
| Version | v0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Product | autonomous-dev |

---

## 1. Problem Statement

Agents rediscover the codebase every session via ad-hoc Grep/Glob/Read, spending 60–80% of their context window on orientation. Aider's benchmarks show 54–70% token utilization for raw agentic retrieval versus 4.3–6.5% with a repo-map. There is no symbol graph, no semantic index, and no canonical onboarding artifact (`AGENTS.md`). Phases re-discover the codebase from scratch each run. Without a pre-index security gate, secrets can leak into any future embedding system.

Key gaps:

| Gap | Impact |
|---|---|
| No symbol graph | Agents trace call chains manually via repeated Grep |
| No semantic index | Retrieval is keyword-only; misses renamed or paraphrased symbols |
| No `AGENTS.md` | Every agent session re-orients via directory traversal |
| No `.aiignore` / secret gate | Credentials, tokens, and keys could enter vector store |
| No monorepo awareness | Package-scoped queries degrade to whole-repo scans |

---

## 2. Goals

| ID | Goal |
|---|---|
| G-1 | Hybrid retrieval combining tree-sitter AST, BM25, dense vector search, and PageRank symbol graph |
| G-2 | Canonical `AGENTS.md` generated per project, with `CLAUDE.md` as a symlink |
| G-3 | Aider-style repo map personalized on currently-open files |
| G-4 | Anthropic Contextual Retrieval applied to chunks (+49% / +67% recall improvement) |
| G-5 | Merkle-diff freshness tracking with inotify, git hooks, and nightly safety-net rebuild |
| G-6 | `.aiignore` enforcement plus Secretlint pre-index gate (fail-closed on secret match) |
| G-7 | Monorepo-aware indexing for Nx, Turbo, Bazel, pnpm workspaces, Cargo workspaces, and go.work |
| G-8 | Pluggable embedding provider and vector store with no vendor lock-in |
| G-9 | Evaluation harness on SWE-bench Pro and RepoQA (not SWE-bench Verified, which is contaminated) |
| G-10 | MCP server exposing the graph to Claude Code and any MCP-compatible client |

---

## 3. Non-Goals

| ID | Non-Goal |
|---|---|
| NG-1 | Not a general code-search product for end users |
| NG-2 | Not replacing Language Server Protocols (LSPs) or IDE integrations |
| NG-3 | Not cloud-only — local-first stack is mandatory for air-gapped environments |
| NG-4 | Not a documentation generator (see PRD-025) |
| NG-5 | Not duplicating UX ingestion logic (see PRD-012) |

---

## 4. User Personas

| Persona | Description |
|---|---|
| Agent | Pipeline phases (prd-author, code-executor, reviewer, etc.) consuming the retrieval API |
| System Operator | Runs index CLI, monitors freshness, manages provider configuration |
| Repository Owner | Sets `.aiignore` rules, reviews `AGENTS.md` content, owns build commands |
| Security Reviewer | Audits indexed chunks and validates Secretlint gate effectiveness |
| Monorepo Maintainer | Adds packages, adjusts workspace config, relies on per-package indexes |

---

## 5. User Stories

| ID | Story |
|---|---|
| US-01 | As an agent, I ask "what are the existing auth patterns in this repo?" and receive a targeted answer citing file paths, without consuming >25% of my context window. |
| US-02 | As a system operator, I run `autonomous-dev index build` and get a fully populated local index within 10 minutes for a 1M-LOC TypeScript monorepo. |
| US-03 | As a repository owner, I add a file path to `.aiignore` and that file SHALL never appear in any retrieval result or embedding store. |
| US-04 | As a system operator, I swap the embedding provider from Ollama to Voyage via `autonomous-dev index config set embedding.provider voyage` without rebuilding manually. |
| US-05 | As a developer, I switch branches and the index increments to reflect only changed files within 5 seconds per file. |
| US-06 | As a monorepo maintainer, I add a new package; the indexer detects the new workspace entry and auto-includes it on next build. |
| US-07 | As a security reviewer, I run `autonomous-dev index audit` and receive a complete list of indexed file paths, providers, and model versions used. |
| US-08 | As an agent, at session start, I receive a freshly regenerated `AGENTS.md` summarizing the project, key paths, and commands. |
| US-09 | As a security reviewer, I plant a test secret in a non-`.aiignore` file; Secretlint SHALL block the indexing run and emit an error with the offending file path. |
| US-10 | As a system operator, I choose between pgvector and SQLite-VSS backends via config with no code changes. |
| US-11 | As a repository owner operating in an air-gapped environment, the full index build and query cycle SHALL complete with zero outbound network calls. |
| US-12 | As a system operator, I cap Haiku contextual retrieval cost by setting a token budget; the system SHOULD cache all previously generated contexts and batch remaining calls. |
| US-13 | As a PRD author agent, I query the graph during discovery to understand which services are affected by a proposed change. |
| US-14 | As an architecture reviewer, I receive symbol-level file paths via graph queries to support precise code citations. |
| US-15 | As a monorepo maintainer, each package SHALL have its own `AGENTS.md` scoped to that package's public API, dependencies, and conventions. |
| US-16 | As a system operator, after upgrading the embedding model version, the system SHALL detect the version mismatch and trigger a full reindex automatically. |

---

## 6. Functional Requirements

Priority legend: **P0** = must ship at launch, **P1** = required before GA, **P2** = post-GA enhancement.

### 6.1 Index Structure (FR-100s)

| ID | Priority | Requirement |
|---|---|---|
| FR-100 | P0 | The system SHALL parse tree-sitter grammars for TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby, PHP, Bash, Markdown, YAML, SQL, and HCL. |
| FR-101 | P0 | The system SHALL produce a symbol table containing definitions and references for all parsed languages. |
| FR-102 | P0 | The system SHALL build an import graph representing inter-file dependencies. |
| FR-103 | P1 | The system SHALL build a call graph for dynamic analysis of function invocations. |
| FR-104 | P0 | The system SHALL chunk code using AST boundaries per the LlamaIndex CodeSplitter pattern, not arbitrary line windows. |
| FR-105 | P0 | Chunk size SHALL be a maximum of 1500 tokens and a minimum of 100 tokens; chunks outside this range SHALL be split or merged respectively. |

### 6.2 Embedding & Vector Store (FR-200s)

| ID | Priority | Requirement |
|---|---|---|
| FR-200 | P0 | The system SHALL define an `EmbeddingProvider` interface with methods `embed(chunks)`, `model_version`, and `dim`. |
| FR-201 | P0 | The system SHALL define a `VectorStore` interface with methods `upsert`, `query(k)`, `delete`, and `count`. |
| FR-202 | P1 | The default remote provider SHALL be Voyage code-3 with pgvector as the backing store. |
| FR-203 | P0 | The default local provider SHALL be nomic-embed-text via Ollama with SQLite-VSS as the backing store. |
| FR-204 | P2 | The system SHOULD support Matryoshka int8 quantization to reduce storage footprint. |
| FR-205 | P0 | The embedding model version SHALL be pinned in index metadata; a version mismatch SHALL trigger a full reindex. |
| FR-206 | P0 | The system SHALL never hardcode a specific vendor or model identifier outside of configuration files. |

### 6.3 Repo Map & Ranking (FR-300s)

| ID | Priority | Requirement |
|---|---|---|
| FR-300 | P0 | The system SHALL compute a NetworkX PageRank over the symbol graph, personalized on the set of currently-open files in the active agent context. |
| FR-301 | P0 | The repo map output SHALL enforce a per-phase token budget, truncating lower-ranked symbols to fit. |
| FR-302 | P0 | The repo map SHALL honor `.aiignore` and all known generated-output directories (e.g., `dist/`, `node_modules/`, `__pycache__/`). |
| FR-303 | P0 | The repo map SHALL return the top-N identifiers sorted by PageRank score in descending order. |

### 6.4 Contextual Retrieval (FR-400s)

| ID | Priority | Requirement |
|---|---|---|
| FR-400 | P1 | The system SHALL prepend a 50–100-token Haiku-generated context summary to each chunk before embedding, following Anthropic's Contextual Retrieval method. |
| FR-401 | P1 | Contextual summaries SHALL be cached by the content hash of the source chunk; cache hits SHALL never invoke the LLM. |
| FR-402 | P1 | Retrieval SHALL fuse BM25 lexical scores, dense vector similarity, and an optional reranker using Reciprocal Rank Fusion (RRF). |
| FR-403 | P2 | The reranker SHALL be pluggable; supported options SHALL include Cohere, Voyage, and a BM25+vector-only fallback requiring no additional API calls. |

### 6.5 AGENTS.md Generator (FR-500s)

| ID | Priority | Requirement |
|---|---|---|
| FR-500 | P0 | At each session start, the system SHALL generate a per-project `AGENTS.md` containing: project summary, key directory paths, build/test/lint commands, code conventions, and external service dependencies. |
| FR-501 | P0 | The system SHALL create `CLAUDE.md` as a symlink pointing to `AGENTS.md` in the same directory. |
| FR-502 | P1 | In monorepo layouts, the system SHALL generate a scoped `AGENTS.md` per package in addition to the root-level file. |

### 6.6 Freshness (FR-600s)

| ID | Priority | Requirement |
|---|---|---|
| FR-600 | P0 | The system SHALL maintain a Merkle tree of file and directory hashes to detect changes without full rescans. |
| FR-601 | P1 | The system SHALL register inotify (Linux) or fsevents (macOS) watchers for real-time change detection. |
| FR-602 | P1 | The system SHALL install git `post-commit`, `post-merge`, and `post-checkout` hooks to trigger incremental reindex on relevant events. |
| FR-603 | P1 | The system SHALL run a nightly full-rebuild safety-net to catch any changes missed by watchers or hooks. |
| FR-604 | P0 | Each chunk SHALL carry a content hash; unchanged chunks SHALL skip re-contextualization and re-embedding. |

### 6.7 Security & Privacy (FR-700s)

| ID | Priority | Requirement |
|---|---|---|
| FR-700 | P0 | The system SHALL enforce `.aiignore` using gitignore-compatible glob semantics; matching files SHALL never be read, chunked, or embedded. |
| FR-701 | P0 | The system SHALL run Secretlint on every file before indexing; any secret match SHALL abort indexing of that file and emit an error (fail-closed). |
| FR-702 | P2 | The vector store MAY support encryption-at-rest; when enabled, all vectors and metadata SHALL be encrypted before persistence. |
| FR-703 | P1 | The system SHALL maintain an audit log recording indexed file paths, embedding provider, model version, and timestamp for every index build. |

### 6.8 Monorepo Awareness (FR-800s)

| ID | Priority | Requirement |
|---|---|---|
| FR-800 | P1 | The system SHALL read workspace manifests: `nx.json`, `turbo.json`, `pnpm-workspace.yaml`, `BUILD.bazel`, `Cargo.toml` (workspace), and `go.work`. |
| FR-801 | P1 | Query scoping SHALL limit retrieval to the affected package set when a package context is provided. |
| FR-802 | P1 | The index SHALL maintain per-package partitions to support independent freshness tracking per package. |

### 6.9 MCP Server (FR-900s)

| ID | Priority | Requirement |
|---|---|---|
| FR-900 | P0 | The system SHALL expose the following MCP tools: `search_code(query, k)`, `get_symbol(name)`, `get_repo_map(files)`, `get_agents_md()`, and `explain_file(path)`. |
| FR-901 | P1 | The MCP server SHALL auto-register with Claude Code on startup without manual configuration. |

### 6.10 CLI (FR-1000s)

| ID | Priority | Requirement |
|---|---|---|
| FR-1000 | P0 | The system SHALL provide the CLI subcommand `autonomous-dev index` with actions: `build`, `status`, `rebuild`, `query`, and `verify`. |
| FR-1001 | P1 | The system SHALL provide `autonomous-dev index config set embedding.provider <voyage|openai|ollama|anthropic>` to switch providers without code changes. |
| FR-1002 | P1 | The system SHALL provide `autonomous-dev index audit` which outputs all indexed chunks with their source file, chunk hash, provider, and model version. |

---

## 7. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-01 | p95 query latency SHALL be under 500ms on a codebase of 2M LOC. |
| NFR-02 | Full rebuild SHALL complete in under 10 minutes for a 1M-LOC TypeScript monorepo on reference hardware (8-core, 16GB RAM). |
| NFR-03 | Single-file reindex SHALL complete in under 5 seconds end-to-end. |
| NFR-04 | Mean per-phase context utilization SHALL be reduced to ≤25% of the raw-grep baseline (~60–80%). |
| NFR-05 | Offline mode SHALL be fully functional using only the local stack (Ollama + SQLite-VSS); zero network calls required. |
| NFR-06 | Index storage SHALL not exceed 500MB for a 500k-LOC codebase using int8 quantization. |
| NFR-07 | Zero secrets SHALL appear in the index or vector store at any time; enforced by the Secretlint gate. |
| NFR-08 | The system SHALL be portable across macOS (arm64, x86-64) and Linux (x86-64, arm64). |
| NFR-09 | Embedding model version SHALL be pinned in index metadata and validated on every query startup. |
| NFR-10 | Every retrieved chunk SHALL carry a provenance tag (source file path, line range, chunk hash) for audit traceability. |

---

## 8. Architecture

### 8.1 Index Pipeline

```
File System
    │
    ▼
[Watcher: inotify / fsevents / git hooks]
    │  (file change events)
    ▼
[Merkle Diff Engine]  ──── unchanged? ──── skip ────►
    │  (changed file set)
    ▼
[Chunker: tree-sitter AST boundary splitter]
    │  (raw chunks, 100–1500 tokens)
    ▼
[Contextualizer: Haiku, cached by content hash]
    │  (chunks + 50–100 token context prefix)
    ▼
[Secretlint Gate]  ──── secret found? ──── ABORT + ERROR ────►
    │  (clean chunks)
    ▼
[Embedder: pluggable EmbeddingProvider]
    │  (float32 / int8 vectors)
    ▼
[VectorStore: pluggable (pgvector / SQLite-VSS)]
    │
    ├──► [BM25 Index: per-chunk lexical index]
    │
    └──► [Symbol Graph: NetworkX, PageRank-ready]

Query Path:
[Agent Query]
    │
    ▼
[Hybrid Retrieval: BM25 + vector + reranker + PageRank personalization]
    │
    ▼
[MCP Server]  ──►  Claude Code / any MCP client
```

### 8.2 Incremental Update Flow

```
[File Change Detected]
    │
    ▼
[Merkle Diff] ──► compute changed file hashes
    │
    ▼
[Invalidated Chunk Identification] ──► lookup chunks by file path
    │
    ▼
[Content Hash Check] ──── hash unchanged? ──── skip re-embed ────►
    │  (truly changed chunks)
    ▼
[Re-Contextualize] ──── cache hit? ──── reuse cached context ────►
    │  (new context prefix)
    ▼
[Re-Embed]
    │
    ▼
[Upsert into VectorStore + BM25 Index]
    │
    ▼
[Update Symbol Graph edges]
    │
    ▼
[Done — p95 < 5s per file]
```

---

## 9. Testing Strategy

| Layer | Approach |
|---|---|
| Unit | Per-component tests for each chunker grammar, each `EmbeddingProvider` adapter, each `VectorStore` adapter, and the Merkle diff engine. |
| Integration | Vendored 50k-LOC fixture repository (Apache-licensed) used as a deterministic test corpus; golden-file tests for symbol table and import graph outputs. |
| Benchmark | Harness measuring p50/p95/p99 query latency and full-rebuild time at 10k, 100k, and 1M LOC. |
| Eval: SWE-bench Pro | Agent task success rate measured with and without graph enabled; target +5pp. |
| Eval: RepoQA | Recall@5 and Recall@10 for function-level retrieval; target ≥85% Recall@5. |
| Security | Planted-secret test: a synthetic secret (regex-matching Secretlint rule) is placed in a non-ignored file; the test asserts the build fails and the secret never reaches the vector store. |
| Cross-provider parity | Voyage and Ollama backends queried with identical prompts; top-5 result overlap SHALL be ≥70%. |

---

## 10. Migration & Rollout

### Phase 1 — Local Foundation (Weeks 1–4)

| Deliverable | Notes |
|---|---|
| tree-sitter chunker with 14 grammars | FR-100–FR-105 |
| SQLite-VSS + Ollama nomic-embed-text | FR-203, offline-first |
| Repo map + PageRank | FR-300–FR-303 |
| `AGENTS.md` generator | FR-500–FR-501 |
| MCP read-only tools | FR-900 |
| Integration with prd-author and code-executor | US-01, US-08 |

### Phase 2 — Remote Providers & Security (Weeks 5–8)

| Deliverable | Notes |
|---|---|
| Voyage / OpenAI / Anthropic remote providers | FR-200–FR-206 |
| Contextual Retrieval (Haiku) + caching | FR-400–FR-403 |
| pgvector backend | FR-202 |
| Monorepo workspace detection | FR-800–FR-802 |
| Secretlint pre-index gate + `.aiignore` | FR-700–FR-703 |

### Phase 3 — Evaluation & Hardening (Weeks 9–12)

| Deliverable | Notes |
|---|---|
| SWE-bench Pro + RepoQA eval harness | NFR eval coverage |
| Per-chunk content-hash caching | FR-604 |
| Nightly safety-net rebuild | FR-603 |
| Drift alerts and index-verify CLI | FR-1000 `verify` action |
| Per-package `AGENTS.md` in monorepos | FR-502 |

---

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Embedding model drift causes stale results | Medium | High | Pin `model_version` in metadata; auto-reindex on mismatch (FR-205, NFR-09) |
| R-2 | Secret leakage into vector store | Low | Critical | Fail-closed Secretlint gate; planted-secret test in CI (FR-701) |
| R-3 | Contextual Retrieval cost spikes | Medium | Medium | Cache by content hash; batch Haiku calls; cost-cap config (FR-401, US-12) |
| R-4 | Stale `AGENTS.md` misleads agents | Medium | Medium | Regenerate on session-start; validate commands against repo config (FR-500) |
| R-5 | Branch-switch causes full reindex cost | High | Medium | Per-branch Merkle views sharing a common chunk cache (FR-600) |
| R-6 | Monorepo workspace parse failures | Medium | Medium | Fall back to whole-repo scope; emit warning (FR-800) |
| R-7 | Remote provider outage | Low | High | Fallback chain: primary → secondary → local Ollama (FR-200, FR-203) |
| R-8 | Index corruption on crash | Low | High | Checksummed writes; `autonomous-dev index verify` command (FR-1000) |
| R-9 | SWE-bench Verified contamination in eval | High | High | Use SWE-bench Pro, SWE-bench Live, and RepoQA only (G-9) |
| R-10 | Over-indexed context crowding agent window | Medium | High | Strict per-phase token budget on repo map (FR-301, NFR-04) |
| R-11 | Proprietary-code licensing on remote provider | Medium | Medium | Force local-only mode via `embedding.provider ollama` config (NG-3) |

---

## 12. Success Metrics

| Metric | Baseline | Target |
|---|---|---|
| Mean per-phase context utilization | ~60–80% (raw Grep/Glob) | ≤25% |
| Find-function Recall@5 (RepoQA) | Not measured | ≥85% |
| Phase success rate | Current baseline | +10 percentage points |
| SWE-bench Pro score (graph enabled vs. disabled) | Disabled score | +5 percentage points |
| Secret-leak incidents in production (6-month window) | N/A | 0 |
| Single-file reindex latency p95 | Not measured | <5 seconds |
| Full rebuild (1M LOC TypeScript monorepo) | Not measured | <10 minutes |

---

## 13. Open Questions

| ID | Question | Owner | Target Resolution |
|---|---|---|---|
| OQ-1 | Should the index be per-user or shared across users on a multi-developer machine? | System Operator | Phase 1 planning |
| OQ-2 | Should the per-phase token budget be fixed (config-driven) or adaptive based on task complexity? | Agent Framework | Phase 2 |
| OQ-3 | Should call-graph construction cover all 14 parsed languages, or prioritize TypeScript, Python, and Go for Phase 1? | Engineering | Phase 1 kickoff |
| OQ-4 | Should `AGENTS.md` be checked into git, added to `.gitignore`, or stored in `.autonomous-dev/`? | Repository Owner | Phase 1 planning |
| OQ-5 | Which reranker should be the default: Cohere, Voyage, or BM25+vector-only for zero-dependency local mode? | System Operator | Phase 2 |
| OQ-6 | What generated-directory patterns should be auto-ignored by default (beyond `node_modules/`, `dist/`, `__pycache__/`)? | Repository Owner | Phase 1 |

---

## 14. References

### Related PRDs

| PRD | Topic |
|---|---|
| PRD-001 | Daemon architecture |
| PRD-002 | Document pipeline discovery |
| PRD-003 | Agent factory |
| PRD-007 | Escalation audit |
| PRD-012 | UX ingestion (non-goal boundary) |
| PRD-013 | Scaffolding |
| PRD-018 | LLM provider abstraction |

### External References

| Resource | URL |
|---|---|
| Aider repo-map | https://aider.chat/2023/10/22/repomap.html |
| Anthropic Contextual Retrieval | https://www.anthropic.com/news/contextual-retrieval |
| Cursor secure codebase indexing | https://cursor.com/blog/secure-codebase-indexing |
| Voyage code-3 embedding model | https://blog.voyageai.com/2024/12/04/voyage-code-3/ |
| SWE-bench Pro leaderboard | https://labs.scale.com/leaderboard/swe_bench_pro_public |
| RepoQA benchmark | https://evalplus.github.io/repoqa.html |
| Serena (MCP symbol server) | https://github.com/oraios/serena |
| Model Context Protocol | https://modelcontextprotocol.io |
| LlamaIndex CodeSplitter | https://developers.llamaindex.ai/python/framework-api-reference/node_parsers/code/ |

---

**END PRD-011**
