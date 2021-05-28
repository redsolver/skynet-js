import axios, { AxiosResponse } from "axios";
import type { Method } from "axios";

import {
  uploadFile,
  uploadLargeFile,
  uploadDirectory,
  uploadDirectoryRequest,
  uploadFileRequest,
  uploadLargeFileRequest,
} from "./upload";
import {
  downloadFile,
  downloadFileHns,
  getSkylinkUrl,
  getHnsUrl,
  getHnsresUrl,
  getMetadata,
  getFileContent,
  getFileContentHns,
  getFileContentRequest,
  openFile,
  openFileHns,
  resolveHns,
} from "./download";
import { getEntryLink as fileGetEntryLink, getJSON as fileGetJSON } from "./file";
import { deleteJSON, getJSON, setJSON, setDataLink } from "./skydb";
import { getEntry, getEntryUrl, getEntryLink, setEntry, postSignedEntry } from "./registry";
import { addUrlQuery, defaultPortalUrl, makeUrl } from "./utils/url";
import { loadMySky } from "./mysky";
import { extractDomain, getFullDomainUrl } from "./mysky/utils";
import { trimSuffix } from "./utils/string";

/**
 * Custom client options.
 *
 * @property [APIKey] - Authentication password to use.
 * @property [customUserAgent] - Custom user agent header to set.
 * @property [customCookie] - Custom cookie header to set.
 * @property [onUploadProgress] - Optional callback to track upload progress.
 */
export type CustomClientOptions = {
  APIKey?: string;
  customUserAgent?: string;
  customCookie?: string;
  onUploadProgress?: (progress: number, event: ProgressEvent) => void;
};

/**
 * Config options for a single request.
 *
 * @property endpointPath - The endpoint to contact.
 * @property [data] - The data for a POST request.
 * @property [url] - The full url to contact. Will be computed from the portalUrl and endpointPath if not provided.
 * @property [method] - The request method.
 * @property [query] - Query parameters.
 * @property [extraPath] - An additional path to append to the URL, e.g. a 46-character skylink.
 * @property [headers] - Any request headers to set.
 * @property [transformRequest] - A function that allows manually transforming the request.
 * @property [transformResponse] - A function that allows manually transforming the response.
 */
export type RequestConfig = CustomClientOptions & {
  endpointPath: string;
  data?: FormData | Record<string, unknown>;
  url?: string;
  method?: Method;
  headers?: Headers;
  query?: Record<string, unknown>;
  extraPath?: string;
  transformRequest?: (data: unknown) => string;
  transformResponse?: (data: string) => Record<string, unknown>;
};

/**
 * The Skynet Client which can be used to access Skynet.
 */
export class SkynetClient {
  customOptions: CustomClientOptions;

  // The initial portal URL, either given to `new SkynetClient()` or if not, the value of `defaultPortalUrl()`.
  protected initialPortalUrl: string;
  // The resolved API portal URL. The request won't be made until needed, or `initPortalUrl()` is called. The request is only made once, for all Skynet Clients.
  protected static resolvedPortalUrl?: Promise<string>;
  // The given portal URL, if one was passed in to `new SkynetClient()`.
  protected givenPortalUrl?: string;

  // Set methods (defined in other files).

  // Upload

  uploadFile = uploadFile;
  protected uploadFileRequest = uploadFileRequest;
  uploadLargeFile = uploadLargeFile;
  protected uploadLargeFileRequest = uploadLargeFileRequest;
  uploadDirectory = uploadDirectory;
  protected uploadDirectoryRequest = uploadDirectoryRequest;

  // Download

  downloadFile = downloadFile;
  downloadFileHns = downloadFileHns;
  getSkylinkUrl = getSkylinkUrl;
  getHnsUrl = getHnsUrl;
  getHnsresUrl = getHnsresUrl;
  getMetadata = getMetadata;
  getFileContent = getFileContent;
  getFileContentHns = getFileContentHns;
  protected getFileContentRequest = getFileContentRequest;
  openFile = openFile;
  openFileHns = openFileHns;
  resolveHns = resolveHns;

  // MySky

  extractDomain = extractDomain;
  getFullDomainUrl = getFullDomainUrl;
  loadMySky = loadMySky;

  // File API

  file = {
    getJSON: fileGetJSON.bind(this),
    getEntryLink: fileGetEntryLink.bind(this),
  };

  // SkyDB

  db = {
    deleteJSON: deleteJSON.bind(this),
    getJSON: getJSON.bind(this),
    setJSON: setJSON.bind(this),
    setDataLink: setDataLink.bind(this),
  };

  // SkyDB helpers

  registry = {
    getEntry: getEntry.bind(this),
    getEntryUrl: getEntryUrl.bind(this),
    getEntryLink: getEntryLink.bind(this),
    setEntry: setEntry.bind(this),

    postSignedEntry: postSignedEntry.bind(this),
  };

  /**
   * The Skynet Client which can be used to access Skynet.
   *
   * @class
   * @param [initialPortalUrl] The initial portal URL to use to access Skynet, if specified. A request will be made to this URL to get the actual portal URL. To use the default portal while passing custom options, pass "".
   * @param [customOptions] Configuration for the client.
   */
  constructor(initialPortalUrl = "", customOptions: CustomClientOptions = {}) {
    if (initialPortalUrl === "") {
      // Portal was not given, use the default portal URL. We'll still make a request for the resolved portal URL.
      initialPortalUrl = defaultPortalUrl();
    } else {
      // Portal was given, don't make the request for the resolved portal URL.
      this.givenPortalUrl = initialPortalUrl;
    }
    this.initialPortalUrl = initialPortalUrl;
    this.customOptions = customOptions;
  }

  /**
   * Make the request for the API portal URL.
   *
   * @returns - A promise that resolves when the request is complete.
   */
  /* istanbul ignore next */
  async initPortalUrl(): Promise<void> {
    if (!SkynetClient.resolvedPortalUrl) {
      SkynetClient.resolvedPortalUrl = new Promise((resolve, reject) => {
        this.executeRequest({
          ...this.customOptions,
          method: "head",
          url: this.initialPortalUrl,
          endpointPath: "/",
        }).then((response) => {
          if (typeof response.headers === "undefined") {
            reject(
              new Error(
                "Did not get 'headers' in response despite a successful request. Please try again and report this issue to the devs if it persists."
              )
            );
          }
          const portalUrl = response.headers["skynet-portal-api"];
          if (!portalUrl) {
            reject(new Error("Could not get portal URL for the given portal"));
          }
          resolve(trimSuffix(portalUrl, "/"));
        });
      });
    }

    await SkynetClient.resolvedPortalUrl;
    return;
  }

  /**
   * Returns the API portal URL. Makes the request to get it if not done so already.
   *
   * @returns - the portal URL.
   */
  /* istanbul ignore next */
  async portalUrl(): Promise<string> {
    if (this.givenPortalUrl) {
      return this.givenPortalUrl;
    }

    // Make the request if needed and not done so.
    this.initPortalUrl();

    return await SkynetClient.resolvedPortalUrl!; // eslint-disable-line
  }

  /**
   * Creates and executes a request.
   *
   * @param config - Configuration for the request.
   * @returns - The response from axios.
   */
  protected async executeRequest(config: RequestConfig): Promise<AxiosResponse> {
    const url = await buildRequestUrl(this, config.endpointPath, config.url, config.extraPath, config.query);

    const headers = { ...config.headers, ...buildRequestHeaders(config.customUserAgent, config.customCookie) };

    const auth = config.APIKey ? { username: "", password: config.APIKey } : undefined;

    /* istanbul ignore next */
    const onUploadProgress =
      config.onUploadProgress &&
      function (event: ProgressEvent) {
        const progress = event.loaded / event.total;

        // Need the if-statement or TS complains.
        if (config.onUploadProgress) config.onUploadProgress(progress, event);
      };

    return axios({
      url,
      method: config.method,
      data: config.data,
      headers,
      auth,
      onUploadProgress,
      transformRequest: config.transformRequest,
      transformResponse: config.transformResponse,

      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      // Allow cross-site cookies.
      withCredentials: true,
    });
  }
}

export async function buildRequestUrl(
  client: SkynetClient,
  endpointPath: string,
  url?: string,
  extraPath?: string,
  query?: Record<string, unknown>
): Promise<string> {
  // Build the URL.
  if (!url) {
    const portalUrl = await client.portalUrl();
    url = makeUrl(portalUrl, endpointPath, extraPath ?? "");
  }
  if (query) {
    url = addUrlQuery(url, query);
  }

  return url;
}

type Headers = { [key: string]: string };

export function buildRequestHeaders(customUserAgent?: string, customCookie?: string): Headers {
  const headers: Headers = {};
  if (customUserAgent) {
    headers["User-Agent"] = customUserAgent;
  }
  if (customCookie) {
    headers["Cookie"] = customCookie;
  }
  return headers;
}
