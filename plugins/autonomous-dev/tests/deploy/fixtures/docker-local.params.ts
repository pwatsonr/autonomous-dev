import type { DeployParameters } from '../../../intake/deploy/types';

export const dockerLocalValidParams: DeployParameters = {
  image_name: 'demo-app',
  dockerfile_path: 'Dockerfile',
  host_port: 8080,
  container_port: 80,
  health_path: '/health',
  health_timeout_seconds: 1,
};
