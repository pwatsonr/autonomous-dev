import { CooldownResult, GovernanceConfig, FixDeployment } from './types';

/**
 * Check whether a service+error class combination is in a cooldown window.
 *
 * A cooldown is active when a fix deployment for this combination exists
 * and was deployed fewer than `config.cooldown_days` ago.
 *
 * Observations generated during cooldown are still created (for audit)
 * but flagged with cooldown_active: true and triage_status: cooldown.
 * They are excluded from the triage queue.
 */
export function checkCooldown(
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  findRecentFixDeployment: (service: string, errorClass: string) => FixDeployment | null,
  now?: Date
): CooldownResult {
  const currentTime = now ?? new Date();
  const recentFix = findRecentFixDeployment(service, errorClass);

  if (recentFix === null) {
    return { active: false };
  }

  const deployDate = new Date(recentFix.deployed_at);
  const cooldownEnd = new Date(deployDate);
  cooldownEnd.setDate(cooldownEnd.getDate() + config.cooldown_days);

  if (currentTime < cooldownEnd) {
    return {
      active: true,
      reason: `Fix deployed on ${recentFix.deployed_at}, cooldown until ${cooldownEnd.toISOString()}`,
      linked_deployment: recentFix.id,
      cooldown_end: cooldownEnd.toISOString(),
      deploy_date: recentFix.deployed_at,
    };
  }

  return { active: false };
}
