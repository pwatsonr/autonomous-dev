/**
 * Valid Azure `DeployParameters` fixture (SPEC-024-1-05).
 *
 * Shape matches `@autonomous-dev/deploy-azure/backend` `PARAM_SCHEMA`.
 * Used by `tests/deploy/cloud-conformance.test.ts`.
 */

import type { DeployParameters } from '../../../intake/deploy/types';

export const azureValidParams: DeployParameters = {
  subscription_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  resource_group: 'web-rg',
  location: 'eastus',
  acr_name: 'myacr',
  container_app_name: 'web-app',
  image_repo: 'web',
  cpu: '0.5',
  memory_gib: '1.0',
  front_door_endpoint: 'https://app.azurefd.net',
  health_path: '/health',
  health_timeout_seconds: 30,
};

export default azureValidParams;
