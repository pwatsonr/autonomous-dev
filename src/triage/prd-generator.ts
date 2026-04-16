/**
 * Observation-to-PRD promotion pipeline (SPEC-007-4-3, Task 7).
 *
 * Reads a promoted observation report, extracts structured data, generates
 * a PRD using Claude (or a pluggable LLM function), writes the PRD file,
 * and updates the observation with a linked_prd field.
 *
 * Flow:
 *   1. Read observation report
 *   2. Parse frontmatter and extract structured data
 *   3. Generate PRD sections via LLM
 *   4. Build PRD from template
 *   5. Write PRD to `.autonomous-dev/prd/PRD-OBS-<id>.md`
 *   6. Update observation report with `linked_prd` field
 *
 * Integrates with the existing triage processor (SPEC-007-4-2):
 *   - Uses `readFrontmatter` and `updateFrontmatter` from `frontmatter-io.ts`
 *   - Accepts the `TriageDecision` type from `types.ts`
 *   - Designed to be injected into `executePromote` via
 *     `GeneratePrdFromObservationFn`
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { validateOnRead, updateFrontmatter } from './frontmatter-io';
import type { TriageDecision } from './types';
import {
  type ObservationData,
  type LlmPrdContent,
  buildPrdContent,
  buildPrdPrompt,
} from './prd-template';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a successful PRD generation.
 */
export interface PrdGenerationResult {
  /** Generated PRD document ID */
  prd_id: string;
  /** Absolute file path where the PRD was written */
  file_path: string;
  /** Observation ID that was promoted */
  observation_id: string;
}

/**
 * Function signature for LLM-based PRD content generation.
 * Injected as a dependency for testability.
 *
 * Receives the interpolated prompt and returns the structured LLM response.
 */
export type GeneratePrdViaLlmFn = (
  prompt: string,
) => Promise<LlmPrdContent>;

/**
 * Function signature for retrieving previous observation summaries.
 * Injected as a dependency for testability.
 */
export type GetPreviousObservationsFn = (
  service: string,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Body extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the text content of a named Markdown section (## heading).
 *
 * Returns all text between the matching `## heading` line and the next
 * `##` heading (or end of document), trimmed.
 */
export function extractSection(body: string, heading: string): string {
  const lines = body.split('\n');
  let capturing = false;
  const captured: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === `## ${heading.toLowerCase()}` ||
        trimmed.toLowerCase().startsWith(`## ${heading.toLowerCase()}`)) {
      capturing = true;
      continue;
    }
    if (capturing && /^##\s/.test(trimmed)) {
      break;
    }
    if (capturing) {
      captured.push(line);
    }
  }

  return captured.join('\n').trim();
}

/**
 * Extracts evidence text from the observation body.
 * Looks for an "Evidence" section; falls back to the first paragraph.
 */
export function extractEvidenceFromBody(body: string): string {
  const evidence = extractSection(body, 'Evidence');
  if (evidence) return evidence;

  // Fallback: first non-empty paragraph
  const paragraphs = body.split(/\n\n+/);
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return '';
}

/**
 * Extracts metric values from the observation body.
 * Returns an object with targetMetric, currentValue, and baselineValue.
 *
 * Looks for patterns like "error_rate: 12.3% (baseline: 0.4%)" or
 * a Metrics/Success Criteria section with a Markdown table.
 */
export function extractMetricsFromBody(
  body: string,
): { targetMetric: string; currentValue: string; baselineValue: string } {
  const defaults = { targetMetric: 'unknown', currentValue: 'unknown', baselineValue: 'unknown' };

  // Try to find metric patterns in the body
  // Pattern: "metric_name: <value> (baseline: <value>)"
  const metricPattern = /(\w[\w_]*)\s*:\s*([\d.]+%?)\s*\(baseline:\s*([\d.]+%?)\)/i;
  const match = body.match(metricPattern);
  if (match) {
    return {
      targetMetric: match[1],
      currentValue: match[2],
      baselineValue: match[3],
    };
  }

  // Try: look for a Metrics or Success Criteria section with a table
  const metricsSection = extractSection(body, 'Metrics') || extractSection(body, 'Success Criteria');
  if (metricsSection) {
    // Parse table rows: | metric | current | target | ...
    const tableRows = metricsSection.split('\n').filter((l) => l.includes('|') && !l.includes('---'));
    for (const row of tableRows) {
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 3 && cells[0] !== 'Metric') {
        return {
          targetMetric: cells[0],
          currentValue: cells[1],
          baselineValue: cells[2],
        };
      }
    }
  }

  return defaults;
}

// ---------------------------------------------------------------------------
// PRD Generator
// ---------------------------------------------------------------------------

/**
 * Generates a pipeline-compatible PRD from a promoted observation.
 *
 * Steps:
 *   1. Read the promoted observation report
 *   2. Parse frontmatter and extract structured data
 *   3. Build LLM prompt with observation context
 *   4. Generate PRD content via LLM
 *   5. Build PRD using template
 *   6. Write PRD file to `.autonomous-dev/prd/PRD-OBS-<id>.md`
 *   7. Update observation report with `linked_prd` field
 *
 * @param observationFilePath Absolute path to the observation report
 * @param decision            The triage decision from the processor
 * @param rootDir             Project root directory
 * @param generateViaLlm      LLM generation function (injected for testability)
 * @param getPreviousObs      Function to retrieve previous observation summaries
 * @returns PrdGenerationResult with prd_id, file_path, and observation_id
 */
export async function generatePrdFromObservation(
  observationFilePath: string,
  decision: TriageDecision,
  rootDir: string,
  generateViaLlm: GeneratePrdViaLlmFn,
  getPreviousObs?: GetPreviousObservationsFn,
): Promise<PrdGenerationResult> {
  // Step 1: Read and validate the observation report
  const validation = await validateOnRead(observationFilePath);
  if (!validation.valid || !validation.frontmatter) {
    throw new Error(
      `Invalid observation file ${observationFilePath}: ${validation.errors.join('; ')}`,
    );
  }

  const obsFm = validation.frontmatter;
  const obsBody = validation.body;
  const obsContent = validation.rawContent;

  // Step 2: Extract structured data
  const observationId = obsFm.id;
  const service = obsFm.service;
  const repo = (obsFm['repo'] as string) ?? 'unknown';
  const severity = (obsFm['severity'] as string) ?? 'unknown';
  const confidence = parseFloat(String(obsFm['confidence'] ?? '0'));
  const fingerprint = obsFm.fingerprint || '';

  const evidence = extractEvidenceFromBody(obsBody);
  const metrics = extractMetricsFromBody(obsBody);

  const observationData: ObservationData = {
    id: observationId,
    service,
    repo,
    severity,
    confidence,
    fingerprint,
    evidence,
    targetMetric: metrics.targetMetric,
    currentValue: metrics.currentValue,
    baselineValue: metrics.baselineValue,
  };

  // Step 3: Build LLM prompt
  const previousSummary = getPreviousObs
    ? await getPreviousObs(service)
    : 'None';

  const prompt = buildPrdPrompt(
    obsContent,
    service,
    repo,
    severity,
    previousSummary,
  );

  // Step 4: Generate PRD content via LLM
  const llmContent = await generateViaLlm(prompt);

  // Step 5: Build PRD ID and content
  const prdId = `PRD-OBS-${observationId.replace('OBS-', '')}`;
  const prdContent = buildPrdContent(prdId, observationData, llmContent);

  // Step 6: Write PRD file
  const prdPath = path.join(rootDir, '.autonomous-dev', 'prd', `${prdId}.md`);
  await fs.mkdir(path.dirname(prdPath), { recursive: true });
  await fs.writeFile(prdPath, prdContent, 'utf-8');

  // Step 7: Update observation report with linked_prd
  await updateFrontmatter(observationFilePath, {
    linked_prd: prdId,
  });

  return {
    prd_id: prdId,
    file_path: prdPath,
    observation_id: observationId,
  };
}

// ---------------------------------------------------------------------------
// Factory for triage processor integration
// ---------------------------------------------------------------------------

/**
 * Creates a `GeneratePrdFromObservationFn` compatible with the triage
 * processor's `executePromote` action (SPEC-007-4-2).
 *
 * This factory wraps `generatePrdFromObservation` to match the
 * `(filePath, decision) => Promise<string>` signature expected by
 * `actions/promote.ts`.
 *
 * @param rootDir         Project root directory
 * @param generateViaLlm  LLM generation function
 * @param getPreviousObs  Optional function for previous observation summaries
 * @returns Function matching GeneratePrdFromObservationFn from actions/promote.ts
 */
export function createPrdGenerator(
  rootDir: string,
  generateViaLlm: GeneratePrdViaLlmFn,
  getPreviousObs?: GetPreviousObservationsFn,
): (observationFilePath: string, decision: TriageDecision) => Promise<string> {
  return async (observationFilePath, decision) => {
    const result = await generatePrdFromObservation(
      observationFilePath,
      decision,
      rootDir,
      generateViaLlm,
      getPreviousObs,
    );
    return result.prd_id;
  };
}
