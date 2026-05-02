/**
 * ECR build + push helper (SPEC-024-1-02 §"AWSBackend.build").
 *
 * Authenticates against ECR via `getAuthorizationToken`, then drives
 * `dockerode` (a typed wrapper around the Docker Engine HTTP API) to
 * build and push the image. NEVER shells out to `docker` — the
 * acceptance criteria explicitly forbid `child_process.execFile/spawn`
 * during build.
 *
 * Both the ECR client and the Docker client are accepted as duck-typed
 * structural interfaces so unit tests inject hand-rolled mocks and the
 * SDKs are not required at compile time.
 *
 * @module @autonomous-dev/deploy-aws/ecr-builder
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';
import { mapAwsError } from './error-mapper';

/** Subset of `@aws-sdk/client-ecr` `ECRClient.send`'s `GetAuthorizationToken` reply. */
export interface EcrAuthorizationData {
  authorizationToken?: string | null;
  proxyEndpoint?: string | null;
  expiresAt?: Date | string | null;
}

/** Structural subset of `ECRClient` (just `send`-like for the calls we make). */
export interface EcrLikeClient {
  send(command: { __op: 'GetAuthorizationToken' } | { __op: string; input: Record<string, unknown> }): Promise<{
    authorizationData?: ReadonlyArray<EcrAuthorizationData>;
  }>;
}

/** Structural subset of dockerode's `Image` instance returned by `getImage`. */
export interface DockerImage {
  push(opts: {
    authconfig: { username: string; password: string; serveraddress: string };
    tag?: string;
  }): Promise<NodeJS.ReadableStream>;
  inspect(): Promise<{
    Id?: string;
    Size?: number;
    RepoDigests?: ReadonlyArray<string>;
  }>;
}

/** Structural subset of dockerode's top-level client. */
export interface DockerLikeClient {
  buildImage(
    src: { context: string; src: ReadonlyArray<string> },
    opts: { t: string },
  ): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, output: ReadonlyArray<Record<string, unknown>>) => void,
    ): void;
  };
  getImage(name: string): DockerImage;
}

/** Options for `loginAndPush`. */
export interface LoginAndPushOptions {
  ecrClient: EcrLikeClient;
  docker: DockerLikeClient;
  /** Absolute path to repo (Docker build context). */
  repoPath: string;
  /** `<acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<sha>`. */
  imageUri: string;
  /** Test seam: replace stream-follower for deterministic tests. */
  followStream?: (stream: NodeJS.ReadableStream) => Promise<void>;
}

/** Result of `loginAndPush`. */
export interface LoginAndPushResult {
  imageUri: string;
  digest: string;
  sizeBytes: number;
}

/**
 * Authenticate against ECR, build the image, push it, and return the
 * pushed digest + size.
 */
export async function loginAndPush(
  opts: LoginAndPushOptions,
): Promise<LoginAndPushResult> {
  const { ecrClient, docker, repoPath, imageUri } = opts;
  const followStream = opts.followStream ?? defaultFollowStream(docker);

  // 1. ECR auth.
  let authData: EcrAuthorizationData;
  try {
    const resp = await ecrClient.send({ __op: 'GetAuthorizationToken' });
    if (!resp.authorizationData || resp.authorizationData.length === 0) {
      throw new CloudDeployError(
        'AUTH_FAILED',
        'aws',
        'ECR:GetAuthorizationToken',
        false,
        'ECR getAuthorizationToken returned empty authorizationData',
      );
    }
    authData = resp.authorizationData[0];
  } catch (err) {
    if (err instanceof CloudDeployError) throw err;
    throw mapAwsError(err, 'ECR:GetAuthorizationToken');
  }

  const auth = decodeEcrAuth(authData);

  // 2. Docker build.
  let buildStream: NodeJS.ReadableStream;
  try {
    buildStream = await docker.buildImage(
      { context: repoPath, src: ['Dockerfile'] },
      { t: imageUri },
    );
  } catch (err) {
    throw new CloudDeployError(
      'BUILD_FAILED',
      'aws',
      'Docker:Build',
      false,
      `docker build for ${imageUri} failed: ${(err as Error).message}`,
      err,
    );
  }
  await followStream(buildStream);

  // 3. Docker push.
  const image = docker.getImage(imageUri);
  let pushStream: NodeJS.ReadableStream;
  try {
    pushStream = await image.push({
      authconfig: {
        username: auth.username,
        password: auth.password,
        serveraddress: auth.serveraddress,
      },
    });
  } catch (err) {
    throw new CloudDeployError(
      'BUILD_FAILED',
      'aws',
      'ECR:PutImage',
      false,
      `docker push for ${imageUri} failed: ${(err as Error).message}`,
      err,
    );
  }
  await followStream(pushStream);

  // 4. Inspect for digest + size.
  const inspect = await image.inspect();
  const digest = pickDigest(inspect, imageUri);
  if (!digest) {
    throw new CloudDeployError(
      'BUILD_FAILED',
      'aws',
      'ECR:PutImage',
      false,
      `pushed image ${imageUri} had no digest after inspect()`,
    );
  }
  return {
    imageUri,
    digest,
    sizeBytes: typeof inspect.Size === 'number' ? inspect.Size : 0,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface EcrCreds {
  username: string;
  password: string;
  serveraddress: string;
}

function decodeEcrAuth(data: EcrAuthorizationData): EcrCreds {
  if (!data.authorizationToken) {
    throw new CloudDeployError(
      'AUTH_FAILED',
      'aws',
      'ECR:GetAuthorizationToken',
      false,
      'ECR authorizationToken is empty',
    );
  }
  const decoded = Buffer.from(data.authorizationToken, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) {
    throw new CloudDeployError(
      'AUTH_FAILED',
      'aws',
      'ECR:GetAuthorizationToken',
      false,
      'ECR authorizationToken did not contain a ":" separator',
    );
  }
  return {
    username: decoded.slice(0, idx),
    password: decoded.slice(idx + 1),
    serveraddress: data.proxyEndpoint ?? '',
  };
}

function defaultFollowStream(docker: DockerLikeClient): (s: NodeJS.ReadableStream) => Promise<void> {
  return (stream) =>
    new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
}

function pickDigest(
  inspect: { Id?: string; RepoDigests?: ReadonlyArray<string> },
  imageUri: string,
): string | null {
  // Prefer the RepoDigest matching our repo (lifeblood of immutability).
  if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
    const repoBase = imageUri.split(':')[0];
    const match = inspect.RepoDigests.find((d) => d.startsWith(`${repoBase}@`));
    if (match) {
      const at = match.indexOf('@');
      return match.slice(at + 1);
    }
  }
  if (inspect.Id) {
    return inspect.Id.replace(/^sha256:/, '');
  }
  return null;
}
