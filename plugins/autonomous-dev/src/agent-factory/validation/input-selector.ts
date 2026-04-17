/**
 * Historical Input Selector (SPEC-005-4-1, Task 1).
 *
 * Selects 3-5 historical production invocations for A/B validation.
 * The selection algorithm ensures coverage across quality strata and
 * weakness-relevant domains to produce a representative sample.
 *
 * Selection strategy:
 *   1. Query production-only invocations.
 *   2. Enforce minimum of 3 historical invocations.
 *   3. Compute median quality score.
 *   4. Select at least 1 below-median, 1 above-median, 1 weakness-domain.
 *   5. Fill remaining slots (up to 5) for domain diversity.
 *   6. Deduplicate -- never select the same invocation twice.
 *
 * Exports: `InputSelector`
 */

import * as crypto from 'crypto';
import type { IMetricsEngine, InvocationMetric } from '../metrics/types';
import type { WeaknessReport } from '../improvement/types';
import type { SelectedInput, InputSelectionResult } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_INPUTS = 3;
const MAX_INPUTS = 5;

// ---------------------------------------------------------------------------
// InputSelector
// ---------------------------------------------------------------------------

export class InputSelector {
  private readonly metricsEngine: IMetricsEngine;
  /**
   * Optional resolver that retrieves the original input text for an invocation.
   * If not provided, the selector uses the input_hash as a placeholder.
   */
  private readonly inputResolver?: (invocation: InvocationMetric) => string;

  constructor(
    metricsEngine: IMetricsEngine,
    inputResolver?: (invocation: InvocationMetric) => string,
  ) {
    this.metricsEngine = metricsEngine;
    this.inputResolver = inputResolver;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Select 3-5 historical production inputs for A/B validation.
   *
   * @param agentName  The agent whose invocations to sample.
   * @param report     The weakness report driving this validation cycle.
   * @returns          An InputSelectionResult with the selected inputs or an error.
   */
  selectInputs(agentName: string, report: WeaknessReport): InputSelectionResult {
    // Step 1: Query production invocations only
    const invocations = this.metricsEngine.getInvocations(agentName, {
      environment: 'production',
    });

    // Step 2: Minimum enforcement
    if (invocations.length < MIN_INPUTS) {
      return {
        success: false,
        inputs: [],
        error: `Insufficient historical inputs for A/B validation (found ${invocations.length}, minimum ${MIN_INPUTS} required)`,
      };
    }

    // Step 3: Compute median quality score
    const median = computeMedian(invocations.map((inv) => inv.output_quality_score));

    // Step 4: Select inputs
    const selected = new Map<string, { invocation: InvocationMetric; reason: string }>();

    // 4a: Below-median -- invocation with quality score furthest below median
    const belowMedian = invocations
      .filter((inv) => inv.output_quality_score <= median)
      .sort((a, b) => a.output_quality_score - b.output_quality_score);

    if (belowMedian.length > 0) {
      const pick = belowMedian[0];
      selected.set(pick.invocation_id, { invocation: pick, reason: 'below-median' });
    }

    // 4b: Above-median -- invocation with quality score furthest above median
    const aboveMedian = invocations
      .filter((inv) => inv.output_quality_score >= median && !selected.has(inv.invocation_id))
      .sort((a, b) => b.output_quality_score - a.output_quality_score);

    if (aboveMedian.length > 0) {
      const pick = aboveMedian[0];
      selected.set(pick.invocation_id, { invocation: pick, reason: 'above-median' });
    } else {
      // If all scores are the same (equal to median), pick any remaining
      const remaining = invocations.filter((inv) => !selected.has(inv.invocation_id));
      if (remaining.length > 0) {
        selected.set(remaining[0].invocation_id, {
          invocation: remaining[0],
          reason: 'above-median',
        });
      }
    }

    // 4c: Weakness-domain -- invocation from an affected domain
    const affectedDomains = this.extractAffectedDomains(report);
    let weaknessDomainPicked = false;

    if (affectedDomains.length > 0) {
      for (const domain of affectedDomains) {
        const domainInvocations = invocations.filter(
          (inv) => inv.input_domain === domain && !selected.has(inv.invocation_id),
        );
        if (domainInvocations.length > 0) {
          // Pick the one with lowest quality in this domain (most likely to show improvement)
          domainInvocations.sort((a, b) => a.output_quality_score - b.output_quality_score);
          const pick = domainInvocations[0];
          selected.set(pick.invocation_id, { invocation: pick, reason: 'weakness-domain' });
          weaknessDomainPicked = true;
          break;
        }
      }
    }

    // Fallback: if no domain-specific invocation found, select another below-median
    if (!weaknessDomainPicked) {
      const fallback = belowMedian.filter((inv) => !selected.has(inv.invocation_id));
      if (fallback.length > 0) {
        selected.set(fallback[0].invocation_id, {
          invocation: fallback[0],
          reason: 'weakness-domain',
        });
      }
    }

    // 4d: Fill remaining slots for domain diversity (up to MAX_INPUTS total)
    if (selected.size < MAX_INPUTS) {
      const remainingInvocations = invocations.filter(
        (inv) => !selected.has(inv.invocation_id),
      );

      // Group remaining by domain
      const domainGroups = new Map<string, InvocationMetric[]>();
      for (const inv of remainingInvocations) {
        const group = domainGroups.get(inv.input_domain) ?? [];
        group.push(inv);
        domainGroups.set(inv.input_domain, group);
      }

      // Collect domains already selected
      const selectedDomains = new Set<string>();
      for (const entry of selected.values()) {
        selectedDomains.add(entry.invocation.input_domain);
      }

      // Prefer invocations from un-represented domains
      const unseenDomains = [...domainGroups.entries()].filter(
        ([domain]) => !selectedDomains.has(domain),
      );
      const seenDomains = [...domainGroups.entries()].filter(
        ([domain]) => selectedDomains.has(domain),
      );

      // Fill from unseen domains first, then seen domains
      for (const [, invs] of [...unseenDomains, ...seenDomains]) {
        if (selected.size >= MAX_INPUTS) break;
        // Pick the invocation closest to median for diversity
        invs.sort(
          (a, b) =>
            Math.abs(a.output_quality_score - median) -
            Math.abs(b.output_quality_score - median),
        );
        for (const inv of invs) {
          if (selected.size >= MAX_INPUTS) break;
          if (!selected.has(inv.invocation_id)) {
            selected.set(inv.invocation_id, { invocation: inv, reason: 'domain-diversity' });
          }
        }
      }
    }

    // Step 5: Build SelectedInput records (deduplication ensured by Map)
    const inputs: SelectedInput[] = [];
    for (const entry of selected.values()) {
      inputs.push(this.toSelectedInput(entry.invocation, entry.reason));
    }

    return { success: true, inputs };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Extract the set of affected domains from the weakness report.
   */
  private extractAffectedDomains(report: WeaknessReport): string[] {
    const domains = new Set<string>();
    for (const weakness of report.weaknesses) {
      for (const domain of weakness.affected_domains) {
        domains.add(domain);
      }
    }
    return [...domains];
  }

  /**
   * Convert an InvocationMetric to a SelectedInput.
   */
  private toSelectedInput(invocation: InvocationMetric, reason: string): SelectedInput {
    const inputContent = this.inputResolver
      ? this.inputResolver(invocation)
      : invocation.input_hash; // fallback: hash as placeholder

    return {
      input_id: crypto.randomUUID(),
      original_invocation_id: invocation.invocation_id,
      input_content: inputContent,
      input_hash: invocation.input_hash,
      input_domain: invocation.input_domain,
      original_quality_score: invocation.output_quality_score,
      selection_reason: reason,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Compute the median of a numeric array.
 * For even-length arrays, returns the average of the two middle values.
 */
function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}
