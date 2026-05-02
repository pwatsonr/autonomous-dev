import type { DeployParameters } from '../../../intake/deploy/types';

export const staticValidParams = (target: string): DeployParameters => ({
  build_command: 'echo skip',
  build_dir: 'dist',
  target,
});
