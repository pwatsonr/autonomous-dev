// SPEC-013-4-01 §Asset URL Helper.
//
// Template-side wrapper around the `AssetManifest` singleton. JSX views
// call `assetUrl('portal.css')` and receive `/static/portal-<hash>.css`
// in production or `/static/portal.css` in development.
//
// Keeping this as a separate module (rather than inlining the singleton
// call into templates) means the prefix and the manifest lookup are
// changed in exactly one place if the layout changes (e.g. a CDN host
// is introduced).

import { getAssetManifest } from "../lib/asset-manifest";

const STATIC_PREFIX = "/static";

/**
 * Returns the URL for a logical asset name. Throws `MissingAssetError`
 * in production when the name is absent from the manifest.
 *
 * @example
 *   <link rel="stylesheet" href={assetUrl('portal.css')} />
 *   <script src={assetUrl('htmx.min.js')} defer />
 */
export function assetUrl(logicalName: string): string {
    const resolved = getAssetManifest().resolve(logicalName);
    return `${STATIC_PREFIX}/${resolved}`;
}
