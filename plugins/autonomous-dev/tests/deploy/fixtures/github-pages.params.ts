import type { DeployParameters } from '../../../intake/deploy/types';

export const githubPagesValidParams: DeployParameters = {
  build_command: 'echo skip',
  build_dir: 'dist',
  pages_branch: 'gh-pages',
  allow_force_rollback: false,
};
