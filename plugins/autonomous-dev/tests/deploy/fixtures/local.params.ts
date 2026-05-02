import type { DeployParameters } from '../../../intake/deploy/types';

export const localValidParams: DeployParameters = {
  pr_title: 'feat: deploy test',
  pr_body: 'Deploy test body — markdown ok here.',
  base_branch: 'main',
};
