import { AxiosResponse } from "axios";
import { SkynetClient } from "./client";

import { BaseCustomOptions, defaultBaseOptions } from "./utils/options";
import { convertSkylinkToBase32, formatSkylink } from "./skylink/format";
import { parseSkylink } from "./skylink/parse";
import { trimUriPrefix } from "./utils/string";
import { addSubdomain, addUrlQuery, makeUrl, uriHandshakePrefix, uriHandshakeResolverPrefix } from "./utils/url";
import { throwValidationError, validateObject, validateOptionalObject, validateString } from "./utils/validation";
import { JsonData } from "./skydb";

/**
 * Custom download options.
 *
 * @property [endpointDownload] - The relative URL path of the portal endpoint to contact.
 * @property [download=false] - Indicates to `getSkylinkUrl` whether the file should be downloaded (true) or opened in the browser (false). `downloadFile` and `openFile` override this value.
 * @property [noResponseMetadata=false] - Download without metadata in the response.
 * @property [path=""] - A path to append to the skylink, e.g. `dir1/dir2/file`. A Unix-style path is expected. Each path component will be URL-encoded.
 * @property [query={}] - A query object to convert to a query parameter string and append to the URL.
 * @property [subdomain=false] - Whether to return the final skylink in subdomain format.
 */
export type CustomDownloadOptions = BaseCustomOptions & {
  endpointDownload?: string;
  download?: boolean;
  noResponseMetadata?: boolean;
  path?: string;
  query?: Record<string, unknown>;
  subdomain?: boolean;
};

/**
 * Custom HNS download options.
 *
 * @property [endpointDownloadHns] - The relative URL path of the portal endpoint to contact.
 * @property [hnsSubdomain="hns"] - The name of the hns subdomain on the portal.
 */
export type CustomHnsDownloadOptions = CustomDownloadOptions & {
  endpointDownloadHns?: string;
  hnsSubdomain?: string;
};

/**
 * The response for a get file content request.
 *
 * @property data - The returned file content. Its type is stored in contentType.
 * @property contentType - The type of the content.
 * @property metadata - The metadata in JSON format.
 * @property portalUrl - The URL of the portal.
 * @property skylink - 46-character skylink.
 */
export type GetFileContentResponse<T = unknown> = {
  data: T;
  contentType: string;
  metadata: Record<string, unknown>;
  portalUrl: string;
  skylink: string;
};

/**
 * The response for a get metadata request.
 *
 * @property contentType - The type of the content.
 * @property metadata - The metadata in JSON format.
 * @property portalUrl - The URL of the portal.
 * @property skylink - 46-character skylink.
 */
export type GetMetadataResponse = {
  contentType: string;
  metadata: Record<string, unknown>;
  portalUrl: string;
  skylink: string;
};

/**
 * The response for a resolve HNS request.
 *
 * @property skylink - 46-character skylink.
 */
export type ResolveHnsResponse = {
  data: JsonData,
  skylink: string;
};

export const defaultDownloadOptions = {
  ...defaultBaseOptions,
  endpointDownload: "/",
  download: false,
  noResponseMetadata: false,
  path: undefined,
  query: undefined,
  subdomain: false,
};
const defaultDownloadHnsOptions = {
  ...defaultDownloadOptions,
  endpointDownloadHns: "hns",
  hnsSubdomain: "hns",
};
const defaultResolveHnsOptions = {
  ...defaultBaseOptions,
  endpointDownloadHnsres: "hnsres",
};

/**
 * Initiates a download of the content of the skylink within the browser.
 *
 * @param this - SkynetClient
 * @param skylinkUrl - 46-character skylink, or a valid skylink URL. Can be followed by a path. Note that the skylink will not be encoded, so if your path might contain special characters, consider using `customOptions.path`.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/"] - The relative URL path of the portal endpoint to contact.
 * @returns - The full URL that was used.
 * @throws - Will throw if the skylinkUrl does not contain a skylink or if the path option is not a string.
 */
export async function downloadFile(
  this: SkynetClient,
  skylinkUrl: string,
  customOptions?: CustomDownloadOptions
): Promise<string> {
  // Validation is done in `getSkylinkUrl`.

  const opts = { ...defaultDownloadOptions, ...this.customOptions, ...customOptions, download: true };

  const url = await this.getSkylinkUrl(skylinkUrl, opts);

  // Download the url.
  window.location.assign(url);

  return url;
}

/**
 * Initiates a download of the content of the skylink at the Handshake domain.
 *
 * @param this - SkynetClient
 * @param domain - Handshake domain.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/hns"] - The relative URL path of the portal endpoint to contact.
 * @returns - The full URL that was used.
 * @throws - Will throw if the input domain is not a string.
 */
export async function downloadFileHns(
  this: SkynetClient,
  domain: string,
  customOptions?: CustomDownloadOptions
): Promise<string> {
  // Validation is done in `getHnsUrl`.

  const opts = { ...defaultDownloadHnsOptions, ...this.customOptions, ...customOptions, download: true };

  const url = await this.getHnsUrl(domain, opts);

  // Download the url.
  window.location.assign(url);

  return url;
}

/**
 * Constructs the full URL for the given skylink.
 *
 * @param this - SkynetClient
 * @param skylinkUrl - Skylink string. See `downloadFile`.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/"] - The relative URL path of the portal endpoint to contact.
 * @returns - The full URL for the skylink.
 * @throws - Will throw if the skylinkUrl does not contain a skylink or if the path option is not a string.
 */
export async function getSkylinkUrl(
  this: SkynetClient,
  skylinkUrl: string,
  customOptions?: CustomDownloadOptions
): Promise<string> {
  // Validation is done in `getSkylinkUrlForPortal`.

  const opts = { ...defaultDownloadOptions, ...this.customOptions, ...customOptions };

  const portalUrl = await this.portalUrl();

  return getSkylinkUrlForPortal(portalUrl, skylinkUrl, opts);
}

/**
 * Gets the skylink URL without an initialized client.
 *
 * @param portalUrl - The portal URL.
 * @param skylinkUrl - Skylink string. See `downloadFile`.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @returns - The full URL for the skylink.
 * @throws - Will throw if the skylinkUrl does not contain a skylink or if the path option is not a string.
 */
export function getSkylinkUrlForPortal(
  portalUrl: string,
  skylinkUrl: string,
  customOptions?: CustomDownloadOptions
): string {
  validateString("portalUrl", portalUrl, "parameter");
  validateString("skylinkUrl", skylinkUrl, "parameter");
  validateOptionalObject("customOptions", customOptions, "parameter", defaultDownloadOptions);

  const opts = { ...defaultDownloadOptions, ...customOptions };

  const query = opts.query ?? {};
  if (opts.download) {
    // Set the "attachment" parameter.
    query.attachment = true;
  }
  if (opts.noResponseMetadata) {
    // Set the "no-response-metadata" parameter.
    query["no-response-metadata"] = true;
  }

  // URL-encode the path.
  let path = "";
  if (opts.path) {
    if (typeof opts.path !== "string") {
      throw new Error(`opts.path has to be a string, ${typeof opts.path} provided`);
    }

    // Encode each element of the path separately and join them.
    //
    // Don't use encodeURI because it does not encode characters such as '?'
    // etc. These are allowed as filenames on Skynet and should be encoded so
    // they are not treated as URL separators.
    path = opts.path
      .split("/")
      .map((element: string) => encodeURIComponent(element))
      .join("/");
  }

  let url;
  if (opts.subdomain) {
    // Get the path from the skylink. Use the empty string if not found.
    const skylinkPath = parseSkylink(skylinkUrl, { onlyPath: true }) ?? "";
    // Get just the skylink.
    let skylink = parseSkylink(skylinkUrl);
    if (skylink === null) {
      throw new Error(`Could not get skylink out of input '${skylinkUrl}'`);
    }
    // Convert the skylink (without the path) to base32.
    skylink = convertSkylinkToBase32(skylink);
    url = addSubdomain(portalUrl, skylink);
    url = makeUrl(url, skylinkPath, path);
  } else {
    // Get the skylink including the path.
    const skylink = parseSkylink(skylinkUrl, { includePath: true });
    if (skylink === null) {
      throw new Error(`Could not get skylink with path out of input '${skylinkUrl}'`);
    }
    // Add additional path if passed in.
    url = makeUrl(portalUrl, opts.endpointDownload, skylink, path);
  }
  return addUrlQuery(url, query);
}

/**
 * Constructs the full URL for the given HNS domain.
 *
 * @param this - SkynetClient
 * @param domain - Handshake domain.
 * @param [customOptions={}] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/hns"] - The relative URL path of the portal endpoint to contact.
 * @returns - The full URL for the HNS domain.
 * @throws - Will throw if the input domain is not a string.
 */
export async function getHnsUrl(
  this: SkynetClient,
  domain: string,
  customOptions?: CustomHnsDownloadOptions
): Promise<string> {
  validateString("domain", domain, "parameter");
  validateOptionalObject("customOptions", customOptions, "parameter", defaultDownloadHnsOptions);

  const opts = { ...defaultDownloadHnsOptions, ...this.customOptions, ...customOptions };

  const query = opts.query ?? {};
  if (opts.download) {
    query.attachment = true;
  }
  if (opts.noResponseMetadata) {
    query["no-response-metadata"] = true;
  }

  domain = trimUriPrefix(domain, uriHandshakePrefix);
  const portalUrl = await this.portalUrl();
  const url = opts.subdomain
    ? addSubdomain(addSubdomain(portalUrl, opts.hnsSubdomain), domain)
    : makeUrl(portalUrl, opts.endpointDownloadHns, domain);

  return addUrlQuery(url, query);
}

/**
 * Constructs the full URL for the resolver for the given HNS domain.
 *
 * @param this - SkynetClient
 * @param domain - Handshake domain.
 * @param [customOptions={}] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/hnsres"] - The relative URL path of the portal endpoint to contact.
 * @returns - The full URL for the resolver for the HNS domain.
 * @throws - Will throw if the input domain is not a string.
 */
export async function getHnsresUrl(
  this: SkynetClient,
  domain: string,
  customOptions?: BaseCustomOptions
): Promise<string> {
  validateString("domain", domain, "parameter");
  validateOptionalObject("customOptions", customOptions, "parameter", defaultResolveHnsOptions);

  const opts = { ...defaultResolveHnsOptions, ...this.customOptions, ...customOptions };

  domain = trimUriPrefix(domain, uriHandshakeResolverPrefix);
  const portalUrl = await this.portalUrl();

  return makeUrl(portalUrl, opts.endpointDownloadHnsres, domain);
}

/**
 * Gets only the metadata for the given skylink without the contents.
 *
 * @param this - SkynetClient
 * @param skylinkUrl - Skylink string. See `downloadFile`.
 * @param [customOptions] - Additional settings that can optionally be set. See `downloadFile` for the full list.
 * @param [customOptions.endpointPath="/"] - The relative URL path of the portal endpoint to contact.
 * @returns - The metadata in JSON format. Empty if no metadata was found.
 * @throws - Will throw if the skylinkUrl does not contain a skylink or if the path option is not a string.
 */
export async function getMetadata(
  this: SkynetClient,
  skylinkUrl: string,
  customOptions?: CustomDownloadOptions
): Promise<GetMetadataResponse> {
  // Validation is done in `getSkylinkUrl`.

  const opts = { ...defaultDownloadOptions, ...this.customOptions, ...customOptions };

  const url = await this.getSkylinkUrl(skylinkUrl, opts);

  const response = await this.executeRequest({
    ...opts,
    endpointPath: opts.endpointDownload,
    method: "head",
    url,
  });

  if (typeof response.headers === "undefined") {
    throw new Error(
      "Did not get 'headers' in response despite a successful request. Please try again and report this issue to the devs if it persists."
    );
  }

  const contentType = response.headers["content-type"] ?? "";
  const metadata = response.headers["skynet-file-metadata"] ? JSON.parse(response.headers["skynet-file-metadata"]) : {};
  const portalUrl = response.headers["skynet-portal-api"] ?? "";
  const skylink = response.headers["skynet-skylink"] ? formatSkylink(response.headers["skynet-skylink"]) : "";

  return { contentType, metadata, portalUrl, skylink };
}

/**
 * Gets the contents of the file at the given skylink.
 *
 * @param this - SkynetClient
 * @param skylinkUrl - Skylink string. See `downloadFile`.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/"] - The relative URL path of the portal endpoint to contact.
 * @returns - An object containing the data of the file, the content-type, metadata, and the file's skylink.
 * @throws - Will throw if the skylinkUrl does not contain a skylink or if the path option is not a string.
 */
export async function getFileContent<T = unknown>(
  this: SkynetClient,
  skylinkUrl: string,
  customOptions?: CustomDownloadOptions
): Promise<GetFileContentResponse<T>> {
  // Validation is done in `getSkylinkUrl`.

  const opts = { ...defaultDownloadOptions, ...this.customOptions, ...customOptions };

  const url = await this.getSkylinkUrl(skylinkUrl, opts);

  return this.getFileContentRequest<T>(url, opts);
}

/**
 * Gets the contents of the file at the given Handshake domain.
 *
 * @param this - SkynetClient
 * @param domain - Handshake domain.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/hns"] - The relative URL path of the portal endpoint to contact.
 * @returns - An object containing the data of the file, the content-type, metadata, and the file's skylink.
 * @throws - Will throw if the domain does not contain a skylink.
 */
export async function getFileContentHns<T = unknown>(
  this: SkynetClient,
  domain: string,
  customOptions?: CustomHnsDownloadOptions
): Promise<GetFileContentResponse<T>> {
  // Validation is done in `getHnsUrl`.

  const opts = { ...defaultDownloadHnsOptions, ...this.customOptions, ...customOptions };

  const url = await this.getHnsUrl(domain, opts);

  return this.getFileContentRequest<T>(url, opts);
}

/**
 * Does a GET request of the skylink, returning the data property of the response.
 *
 * @param this - SkynetClient
 * @param url - URL.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @returns - An object containing the data of the file, the content-type, metadata, and the file's skylink.
 * @throws - Will throw if the request does not succeed or the response is missing data.
 */
export async function getFileContentRequest<T = unknown>(
  this: SkynetClient,
  url: string,
  customOptions?: CustomDownloadOptions
): Promise<GetFileContentResponse<T>> {
  // Not publicly available, don't validate input.

  const opts = { ...defaultDownloadOptions, ...this.customOptions, ...customOptions };

  // GET request the data at the skylink.
  const response = await this.executeRequest({
    ...opts,
    endpointPath: opts.endpointDownload,
    method: "get",
    url,
  });

  if (typeof response.data === "undefined") {
    throw new Error(
      "Did not get 'data' in response despite a successful request. Please try again and report this issue to the devs if it persists."
    );
  }
  if (typeof response.headers === "undefined") {
    throw new Error(
      "Did not get 'headers' in response despite a successful request. Please try again and report this issue to the devs if it persists."
    );
  }

  const contentType = response.headers["content-type"] ?? "";
  const metadata = response.headers["skynet-file-metadata"] ? JSON.parse(response.headers["skynet-file-metadata"]) : {};
  const portalUrl = response.headers["skynet-portal-api"] ?? "";
  const skylink = response.headers["skynet-skylink"] ? formatSkylink(response.headers["skynet-skylink"]) : "";

  return { data: response.data, contentType, portalUrl, metadata, skylink };
}

/**
 * Opens the content of the skylink within the browser.
 *
 * @param this - SkynetClient
 * @param skylinkUrl - Skylink string. See `downloadFile`.
 * @param [customOptions] - Additional settings that can optionally be set. See `downloadFile` for the full list.
 * @param [customOptions.endpointPath="/"] - The relative URL path of the portal endpoint to contact.
 * @returns - The full URL that was used.
 * @throws - Will throw if the skylinkUrl does not contain a skylink or if the path option is not a string.
 */
export async function openFile(
  this: SkynetClient,
  skylinkUrl: string,
  customOptions?: CustomDownloadOptions
): Promise<string> {
  // Validation is done in `getSkylinkUrl`.

  const opts = { ...defaultDownloadOptions, ...this.customOptions, ...customOptions };

  const url = await this.getSkylinkUrl(skylinkUrl, opts);

  window.open(url, "_blank");

  return url;
}

/**
 * Opens the content of the skylink from the given Handshake domain within the browser.
 *
 * @param this - SkynetClient
 * @param domain - Handshake domain.
 * @param [customOptions] - Additional settings that can optionally be set. See `downloadFileHns` for the full list.
 * @param [customOptions.endpointPath="/hns"] - The relative URL path of the portal endpoint to contact.
 * @returns - The full URL that was used.
 * @throws - Will throw if the input domain is not a string.
 */
export async function openFileHns(
  this: SkynetClient,
  domain: string,
  customOptions?: CustomHnsDownloadOptions
): Promise<string> {
  // Validation is done in `getHnsUrl`.

  const opts = { ...defaultDownloadHnsOptions, ...this.customOptions, ...customOptions };

  const url = await this.getHnsUrl(domain, opts);

  // Open the url in a new tab.
  window.open(url, "_blank");

  return url;
}

/**
 * Resolves the given HNS domain to its skylink and returns it and the raw data.
 *
 * @param this - SkynetClient
 * @param domain - Handshake resolver domain.
 * @param [customOptions={}] - Additional settings that can optionally be set.
 * @param [customOptions.endpointPath="/hnsres"] - The relative URL path of the portal endpoint to contact.
 * @returns - The raw data and corresponding skylink.
 * @throws - Will throw if the input domain is not a string.
 */
export async function resolveHns(
  this: SkynetClient,
  domain: string,
  customOptions?: BaseCustomOptions
): Promise<ResolveHnsResponse> {
  // Validation is done in `getHnsresUrl`.

  const opts = { ...defaultResolveHnsOptions, ...this.customOptions, ...customOptions };

  const url = await this.getHnsresUrl(domain, opts);

  // Get the txt record from the hnsres domain on the portal.
  const response = await this.executeRequest({
    ...opts,
    endpointPath: opts.endpointDownloadHnsres,
    method: "get",
    url,
  });

  validateResolveHnsResponse(response);

  if (response.data.skylink) {
    return { data: response.data, skylink: response.data.skylink };
  } else {
    const skylink = await this.registry.getEntryLink(response.data.registry.publickey, response.data.registry.datakey, { hashedDataKeyHex: true });
    return { data: response.data, skylink };
  }
}

function validateResolveHnsResponse(response: AxiosResponse): void {
  try {
    if (!response.data) {
      throw new Error("response.data field missing");
    }

    if (response.data.skylink) {
      validateString("response.data.skylink", response.data.skylink, "resolveHns response field");
    } else if (response.data.registry) {
      validateObject("response.data.registry", response.data.registry, "resolveHns response field");
      validateString("response.data.registry.publickey", response.data.registry.publickey, "resolveHns response field");
      validateString("response.data.registry.datakey", response.data.registry.datakey, "resolveHns response field");
    } else {
      throwValidationError("response.data", response.data, "response data object", "object containing skylink or registry field");
    }
  } catch (err) {
    throw new Error(
      `Did not get a complete resolve HNS response despite a successful request. Please try again and report this issue to the devs if it persists. Error: ${err}`
    );
  }
}
