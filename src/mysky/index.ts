/* istanbul ignore file: Much of this functionality is only testable from a browser */

export type { CustomConnectorOptions } from "./connector";
export { DacLibrary } from "./dac";

import { Connection, ParentHandshake, WindowMessenger } from "post-me";
import {
  CheckPermissionsResponse,
  dispatchedErrorEvent,
  errorWindowClosed,
  monitorWindowError,
  PermCategory,
  Permission,
  PermType,
} from "skynet-mysky-utils";

import { Connector, CustomConnectorOptions, DEFAULT_CONNECTOR_OPTIONS } from "./connector";
import { SkynetClient } from "../client";
import { DacLibrary } from "./dac";
import {
  CustomGetEntryOptions,
  DEFAULT_GET_ENTRY_OPTIONS,
  DEFAULT_SET_ENTRY_OPTIONS,
  getEntryLink,
  RegistryEntry,
} from "../registry";
import {
  DEFAULT_GET_JSON_OPTIONS,
  DEFAULT_SET_JSON_OPTIONS,
  CustomGetJSONOptions,
  CustomSetJSONOptions,
  getOrCreateSkyDBRegistryEntry,
  JSONResponse,
  validateEntryData,
  CustomSetEntryDataOptions,
  DEFAULT_SET_ENTRY_DATA_OPTIONS,
  DELETION_ENTRY_DATA,
  incrementRevision,
} from "../skydb";
import { Signature } from "../crypto";
import { deriveDiscoverableFileTweak } from "./tweak";
import { popupCenter } from "./utils";
import { extractOptions } from "../utils/options";
import { JsonData } from "../utils/types";
import {
  validateBoolean,
  validateObject,
  validateOptionalObject,
  validateSkylinkString,
  validateString,
  validateUint8Array,
} from "../utils/validation";
import { decodeSkylink } from "../skylink/sia";
import {
  decryptJSONFile,
  deriveEncryptedFileKeyEntropy,
  deriveEncryptedFileTweak,
  EncryptedJSONResponse,
  ENCRYPTED_JSON_RESPONSE_VERSION,
  encryptJSONFile,
} from "./encrypted_files";

/**
 * The domain for MySky.
 */
export const MYSKY_DOMAIN = "skynet-mysky.hns";

/**
 * @deprecated please use MYSKY_DOMAIN.
 */
export const mySkyDomain = MYSKY_DOMAIN;

/**
 * The domain for MySky dev.
 */
export const MYSKY_DEV_DOMAIN = "skynet-mysky-dev.hns";

/**
 * @deprecated please use MYSKY_DEV_DOMAIN.
 */
export const mySkyDevDomain = MYSKY_DEV_DOMAIN;

/**
 * The domain for MySky alpha. Intentionally not exported in index file.
 */
export const MYSKY_ALPHA_DOMAIN = "sandbridge.hns";

/**
 * The maximum length for entry data when setting entry data.
 */
export const MAX_ENTRY_LENGTH = 70;

const mySkyUiRelativeUrl = "ui.html";
const mySkyUiTitle = "MySky UI";
const [mySkyUiW, mySkyUiH] = [640, 750];

export type EntryData = {
  data: Uint8Array | null;
};

/**
 * Loads MySky. Note that this does not log in the user.
 *
 * @param this - The Skynet client.
 * @param skappDomain - The domain of the host skapp. For this domain permissions will be requested and, by default, automatically granted.
 * @param [customOptions] - Additional settings that can optionally be set.
 * @returns - Loaded (but not logged-in) MySky instance.
 */
export async function loadMySky(
  this: SkynetClient,
  skappDomain?: string,
  customOptions?: CustomConnectorOptions
): Promise<MySky> {
  const mySky = await MySky.New(this, skappDomain, customOptions);

  return mySky;
}

export class MySky {
  static instance: MySky | null = null;

  // Holds the loaded DACs.
  dacs: DacLibrary[] = [];

  // Holds the currently granted permissions.
  grantedPermissions: Permission[] = [];

  // Holds permissions that have not been granted.
  pendingPermissions: Permission[];

  // ============
  // Constructors
  // ============

  constructor(protected connector: Connector, permissions: Permission[], protected hostDomain: string) {
    this.pendingPermissions = permissions;
  }

  static async New(client: SkynetClient, skappDomain?: string, customOptions?: CustomConnectorOptions): Promise<MySky> {
    const opts = { ...DEFAULT_CONNECTOR_OPTIONS, ...customOptions };

    // Enforce singleton.
    if (MySky.instance) {
      return MySky.instance;
    }

    let domain = MYSKY_DOMAIN;
    if (opts.alpha) {
      domain = MYSKY_ALPHA_DOMAIN;
    } else if (opts.dev) {
      domain = MYSKY_DEV_DOMAIN;
    }
    const connector = await Connector.init(client, domain, customOptions);

    const hostDomain = await client.extractDomain(window.location.hostname);
    const permissions = [];
    if (skappDomain) {
      const perm1 = new Permission(hostDomain, skappDomain, PermCategory.Discoverable, PermType.Write);
      const perm2 = new Permission(hostDomain, skappDomain, PermCategory.Hidden, PermType.Read);
      const perm3 = new Permission(hostDomain, skappDomain, PermCategory.Hidden, PermType.Write);
      permissions.push(perm1, perm2, perm3);
    }

    MySky.instance = new MySky(connector, permissions, hostDomain);
    return MySky.instance;
  }

  // ==========
  // Public API
  // ==========

  /**
   * Checks if the current browser is supported by MySky.
   *
   * @returns - A promise with a boolean indicating whether the browser is supported and, if not, a string containing the user-friendly error message.
   */
  static async isBrowserSupported(): Promise<[boolean, string]> {
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      return [false, "MySky is currently not supported in Safari browsers."];
    }

    return [true, ""];
  }

  /**
   * Loads the given DACs.
   *
   * @param dacs - The DAC library instances to call `init` on.
   */
  async loadDacs(...dacs: DacLibrary[]): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const dac of dacs) {
      promises.push(this.loadDac(dac));
    }

    this.dacs.push(...dacs);

    await Promise.all(promises);
  }

  async addPermissions(...permissions: Permission[]): Promise<void> {
    this.pendingPermissions.push(...permissions);
  }

  async checkLogin(): Promise<boolean> {
    const [seedFound, permissionsResponse]: [boolean, CheckPermissionsResponse] = await this.connector.connection
      .remoteHandle()
      .call("checkLogin", this.pendingPermissions);

    // Save granted and failed permissions.
    const { grantedPermissions, failedPermissions } = permissionsResponse;
    this.grantedPermissions = grantedPermissions;
    this.pendingPermissions = failedPermissions;

    const loggedIn = seedFound && failedPermissions.length === 0;
    await this.handleLogin(loggedIn);
    return loggedIn;
  }

  /**
   * Destroys the mysky connection by:
   *
   * 1. Destroying the connected DACs.
   *
   * 2. Closing the connection.
   *
   * 3. Closing the child iframe.
   *
   * @throws - Will throw if there is an unexpected DOM error.
   */
  async destroy(): Promise<void> {
    // TODO: For all connected dacs, send a destroy call.

    // TODO: Delete all connected dacs.

    // Close the connection.
    this.connector.connection.close();

    // Close the child iframe.
    const frame = this.connector.childFrame;
    if (frame) {
      // The parent node should always exist. Sanity check + make TS happy.
      if (!frame.parentNode) {
        throw new Error("'childFrame.parentNode' was not set");
      }
      frame.parentNode.removeChild(frame);
    }
  }

  async logout(): Promise<void> {
    return await this.connector.connection.remoteHandle().call("logout");
  }

  async requestLoginAccess(): Promise<boolean> {
    let uiWindow: Window;
    let uiConnection: Connection;
    let seedFound = false;

    // Add error listener.
    const { promise: promiseError, controller: controllerError } = monitorWindowError();

    // eslint-disable-next-line no-async-promise-executor
    const promise: Promise<void> = new Promise(async (resolve, reject) => {
      // Make this promise run in the background and reject on window close or any errors.
      promiseError.catch((err: string) => {
        if (err === errorWindowClosed) {
          // Resolve without updating the pending permissions.
          resolve();
          return;
        }

        reject(err);
      });

      try {
        // Launch the UI.

        uiWindow = this.launchUI();
        uiConnection = await this.connectUi(uiWindow);

        // Send the UI the list of required permissions.

        // TODO: This should be a dual-promise that also calls ping() on an interval and rejects if no response was found in a given amount of time.
        const [seedFoundResponse, permissionsResponse]: [boolean, CheckPermissionsResponse] = await uiConnection
          .remoteHandle()
          .call("requestLoginAccess", this.pendingPermissions);
        seedFound = seedFoundResponse;

        // Save failed permissions.

        const { grantedPermissions, failedPermissions } = permissionsResponse;
        this.grantedPermissions = grantedPermissions;
        this.pendingPermissions = failedPermissions;

        resolve();
      } catch (err) {
        reject(err);
      }
    });

    await promise
      .catch((err) => {
        throw err;
      })
      .finally(() => {
        // Close the window.
        if (uiWindow) {
          uiWindow.close();
        }
        // Close the connection.
        if (uiConnection) {
          uiConnection.close();
        }
        // Clean up the event listeners and promises.
        controllerError.cleanup();
      });

    const loggedIn = seedFound && this.pendingPermissions.length === 0;
    await this.handleLogin(loggedIn);
    return loggedIn;
  }

  async userID(): Promise<string> {
    return await this.connector.connection.remoteHandle().call("userID");
  }

  // =============
  // SkyDB methods
  // =============

  /**
   * Gets Discoverable JSON at the given path through MySky, if the user has
   * given Discoverable Read permissions to do so.
   *
   * @param path - The data path.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - An object containing the json data as well as the skylink for the data.
   * @throws - Will throw if the user does not have Discoverable Read permission on the path.
   */
  async getJSON(path: string, customOptions?: CustomGetJSONOptions): Promise<JSONResponse> {
    validateString("path", path, "parameter");
    validateOptionalObject("customOptions", customOptions, "parameter", DEFAULT_GET_JSON_OPTIONS);

    const opts = {
      ...DEFAULT_GET_JSON_OPTIONS,
      ...this.connector.client.customOptions,
      ...customOptions,
    };

    const publicKey = await this.userID();
    const dataKey = deriveDiscoverableFileTweak(path);
    opts.hashedDataKeyHex = true; // Do not hash the tweak anymore.

    return await this.connector.client.db.getJSON(publicKey, dataKey, opts);
  }

  /**
   * Gets the entry link for the entry at the given path. This is a v2 skylink.
   * This link stays the same even if the content at the entry changes.
   *
   * @param path - The data path.
   * @returns - The entry link.
   */
  async getEntryLink(path: string): Promise<string> {
    validateString("path", path, "parameter");

    const publicKey = await this.userID();
    const dataKey = deriveDiscoverableFileTweak(path);
    // Do not hash the tweak anymore.
    const opts = { ...DEFAULT_GET_ENTRY_OPTIONS, hashedDataKeyHex: true };

    return getEntryLink(publicKey, dataKey, opts);
  }

  /**
   * Sets Discoverable JSON at the given path through MySky, if the user has
   * given Discoverable Write permissions to do so.
   *
   * @param path - The data path.
   * @param json - The json to set.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - An object containing the json data as well as the skylink for the data.
   * @throws - Will throw if the user does not have Discoverable Write permission on the path.
   */
  async setJSON(path: string, json: JsonData, customOptions?: CustomSetJSONOptions): Promise<JSONResponse> {
    validateString("path", path, "parameter");
    validateObject("json", json, "parameter");
    validateOptionalObject("customOptions", customOptions, "parameter", DEFAULT_SET_JSON_OPTIONS);

    const opts = {
      ...DEFAULT_SET_JSON_OPTIONS,
      ...this.connector.client.customOptions,
      ...customOptions,
    };

    const publicKey = await this.userID();
    const dataKey = deriveDiscoverableFileTweak(path);
    opts.hashedDataKeyHex = true; // Do not hash the tweak anymore.

    // Immediately fail if the mutex is not available.
    return await this.connector.client.db.revisionNumberCache.withCachedEntryLock(
      publicKey,
      dataKey,
      async (cachedRevisionEntry) => {
        // Get the cached revision number before doing anything else.
        const newRevision = incrementRevision(cachedRevisionEntry.revision);

        // Call SkyDB helper to create the registry entry. We can't call SkyDB's
        // setJSON here directly because we need MySky to sign the entry, instead of
        // signing it ourselves with a given private key.
        const [entry, dataLink] = await getOrCreateSkyDBRegistryEntry(
          this.connector.client,
          dataKey,
          json,
          newRevision,
          opts
        );

        const signature = await this.signRegistryEntry(entry, path);

        const setEntryOpts = extractOptions(opts, DEFAULT_SET_ENTRY_OPTIONS);
        await this.connector.client.registry.postSignedEntry(publicKey, entry, signature, setEntryOpts);

        return { data: json, dataLink };
      }
    );
  }

  /**
   * Deletes Discoverable JSON at the given path through MySky, if the user has
   * given Discoverable Write permissions to do so.
   *
   * @param path - The data path.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - An empty promise.
   * @throws - Will throw if the revision is already the maximum value.
   * @throws - Will throw if the user does not have Discoverable Write permission on the path.
   */
  async deleteJSON(path: string, customOptions?: CustomSetEntryDataOptions): Promise<void> {
    // Validation is done below in `setEntryData`.

    const opts = {
      ...DEFAULT_SET_ENTRY_DATA_OPTIONS,
      ...this.connector.client.customOptions,
      ...customOptions,
    };

    // We re-implement deleteJSON instead of calling SkyDB's deleteJSON so that
    // MySky can do the signing.
    await this.setEntryData(path, DELETION_ENTRY_DATA, { ...opts, allowDeletionEntryData: true });
  }

  // ==================
  // Entry Data Methods
  // ==================

  /**
   * Sets entry at the given path to point to the data link. Like setJSON, but it doesn't upload a file.
   *
   * @param path - The data path.
   * @param dataLink - The data link to set at the path.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - An empty promise.
   * @throws - Will throw if the user does not have Discoverable Write permission on the path.
   */
  async setDataLink(path: string, dataLink: string, customOptions?: CustomSetEntryDataOptions): Promise<void> {
    const parsedSkylink = validateSkylinkString("dataLink", dataLink, "parameter");
    // Rest of validation is done below in `setEntryData`.

    const data = decodeSkylink(parsedSkylink);

    await this.setEntryData(path, data, customOptions);
  }

  /**
   * Gets the raw registry entry data for the given path, if the user has given
   * Discoverable Read permissions.
   *
   * @param path - The data path.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - The entry data.
   * @throws - Will throw if the user does not have Discoverable Read permission on the path.
   */
  async getEntryData(path: string, customOptions?: CustomGetEntryOptions): Promise<EntryData> {
    validateString("path", path, "parameter");
    validateOptionalObject("customOptions", customOptions, "parameter", DEFAULT_GET_ENTRY_OPTIONS);

    const opts = {
      ...DEFAULT_GET_ENTRY_OPTIONS,
      ...this.connector.client.customOptions,
      ...customOptions,
    };

    const publicKey = await this.userID();
    const dataKey = deriveDiscoverableFileTweak(path);
    opts.hashedDataKeyHex = true; // Do not hash the tweak anymore.

    return await this.connector.client.db.getEntryData(publicKey, dataKey, opts);
  }

  /**
   * Sets the raw registry entry data at the given path, if the user has given Discoverable
   * Write permissions.
   *
   * @param path - The data path.
   * @param data - The raw entry data to set.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - The entry data.
   * @throws - Will throw if the length of the data is > 70 bytes.
   * @throws - Will throw if the user does not have Discoverable Write permission on the path.
   */
  async setEntryData(path: string, data: Uint8Array, customOptions?: CustomSetEntryDataOptions): Promise<EntryData> {
    validateString("path", path, "parameter");
    validateUint8Array("data", data, "parameter");
    validateOptionalObject("customOptions", customOptions, "parameter", DEFAULT_SET_ENTRY_DATA_OPTIONS);

    const opts = {
      ...DEFAULT_SET_ENTRY_DATA_OPTIONS,
      ...this.connector.client.customOptions,
      ...customOptions,
    };

    // We re-implement setEntryData instead of calling SkyDB's setEntryData so
    // that MySky can do the signing.

    validateEntryData(data, opts.allowDeletionEntryData);

    const publicKey = await this.userID();
    const dataKey = deriveDiscoverableFileTweak(path);
    opts.hashedDataKeyHex = true; // Do not hash the tweak anymore.

    // Immediately fail if the mutex is not available.
    return await this.connector.client.db.revisionNumberCache.withCachedEntryLock(
      publicKey,
      dataKey,
      async (cachedRevisionEntry) => {
        // Get the cached revision number before doing anything else.
        const newRevision = incrementRevision(cachedRevisionEntry.revision);

        const entry = { dataKey, data, revision: newRevision };

        const signature = await this.signRegistryEntry(entry, path);

        const setEntryOpts = extractOptions(opts, DEFAULT_SET_ENTRY_OPTIONS);
        await this.connector.client.registry.postSignedEntry(publicKey, entry, signature, setEntryOpts);

        return { data: entry.data };
      }
    );
  }

  /**
   * Deletes the entry data at the given path, if the user has given Discoverable
   * Write permissions.
   *
   * @param path - The data path.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - An empty promise.
   * @throws - Will throw if the user does not have Discoverable Write permission on the path.
   */
  async deleteEntryData(path: string, customOptions?: CustomSetEntryDataOptions): Promise<void> {
    // Validation is done in `setEntryData`.

    await this.setEntryData(path, DELETION_ENTRY_DATA, { ...customOptions, allowDeletionEntryData: true });
  }

  // ===============
  // Encrypted Files
  // ===============

  /**
   * Lets you get the share-able path seed, which can be passed to
   * file.getJSONEncrypted. Requires Hidden Read permission on the path.
   *
   * @param path - The given path.
   * @param isDirectory - Whether the path is a directory.
   * @returns - The seed for the path.
   * @throws - Will throw if the user does not have Hidden Read permission on the path.
   * @deprecated - This function has been deprecated in favor of `getEncryptedPathSeed`.
   */
  async getEncryptedFileSeed(path: string, isDirectory: boolean): Promise<string> {
    return await this.getEncryptedPathSeed(path, isDirectory);
  }

  /**
   * Lets you get the share-able path seed, which can be passed to
   * file.getJSONEncrypted. Requires Hidden Read permission on the path.
   *
   * @param path - The given path.
   * @param isDirectory - Whether the path is a directory.
   * @returns - The seed for the path.
   * @throws - Will throw if the user does not have Hidden Read permission on the path.
   */
  async getEncryptedPathSeed(path: string, isDirectory: boolean): Promise<string> {
    validateString("path", path, "parameter");
    validateBoolean("isDirectory", isDirectory, "parameter");

    return await this.connector.connection.remoteHandle().call("getEncryptedFileSeed", path, isDirectory);
  }

  /**
   * Gets Encrypted JSON at the given path through MySky, if the user has given
   * Hidden Read permissions to do so.
   *
   * @param path - The data path.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - An object containing the decrypted json data.
   * @throws - Will throw if the user does not have Hidden Read permission on the path.
   */
  async getJSONEncrypted(path: string, customOptions?: CustomGetJSONOptions): Promise<EncryptedJSONResponse> {
    validateString("path", path, "parameter");
    validateOptionalObject("customOptions", customOptions, "parameter", DEFAULT_GET_JSON_OPTIONS);

    const opts = {
      ...DEFAULT_GET_JSON_OPTIONS,
      ...this.connector.client.customOptions,
      ...customOptions,
      hashedDataKeyHex: true, // Do not hash the tweak anymore.
    };

    // Call MySky which checks for read permissions on the path.
    const [publicKey, pathSeed] = await Promise.all([this.userID(), this.getEncryptedPathSeed(path, false)]);

    // Fetch the raw encrypted JSON data.
    const dataKey = deriveEncryptedFileTweak(pathSeed);
    const { data } = await this.connector.client.db.getRawBytes(publicKey, dataKey, opts);
    if (data === null) {
      return { data: null };
    }

    const encryptionKey = deriveEncryptedFileKeyEntropy(pathSeed);
    const json = decryptJSONFile(data, encryptionKey);

    return { data: json };
  }

  /**
   * Sets Encrypted JSON at the given path through MySky, if the user has given
   * Hidden Write permissions to do so.
   *
   * @param path - The data path.
   * @param json - The json to encrypt and set.
   * @param [customOptions] - Additional settings that can optionally be set.
   * @returns - An object containing the original json data.
   * @throws - Will throw if the user does not have Hidden Write permission on the path.
   */
  async setJSONEncrypted(
    path: string,
    json: JsonData,
    customOptions?: CustomSetJSONOptions
  ): Promise<EncryptedJSONResponse> {
    validateString("path", path, "parameter");
    validateObject("json", json, "parameter");
    validateOptionalObject("customOptions", customOptions, "parameter", DEFAULT_SET_JSON_OPTIONS);

    const opts = {
      ...DEFAULT_SET_JSON_OPTIONS,
      ...this.connector.client.customOptions,
      ...customOptions,
    };

    // Call MySky which checks for read permissions on the path.
    const [publicKey, pathSeed] = await Promise.all([this.userID(), this.getEncryptedPathSeed(path, false)]);
    const dataKey = deriveEncryptedFileTweak(pathSeed);
    opts.hashedDataKeyHex = true; // Do not hash the tweak anymore.

    // Immediately fail if the mutex is not available.
    return await this.connector.client.db.revisionNumberCache.withCachedEntryLock(
      publicKey,
      dataKey,
      async (cachedRevisionEntry) => {
        // Get the cached revision number before doing anything else.
        const newRevision = incrementRevision(cachedRevisionEntry.revision);

        // Derive the key.
        const encryptionKey = deriveEncryptedFileKeyEntropy(pathSeed);

        // Pad and encrypt json file.
        const data = encryptJSONFile(json, { version: ENCRYPTED_JSON_RESPONSE_VERSION }, encryptionKey);

        const [entry] = await getOrCreateSkyDBRegistryEntry(this.connector.client, dataKey, data, newRevision, opts);

        // Call MySky which checks for write permissions on the path.
        const signature = await this.signEncryptedRegistryEntry(entry, path);

        const setEntryOpts = extractOptions(opts, DEFAULT_SET_ENTRY_OPTIONS);
        await this.connector.client.registry.postSignedEntry(publicKey, entry, signature, setEntryOpts);

        return { data: json };
      }
    );
  }

  /**
   * signMessage will sign the given data using the MySky user's private key,
   * this method can be used for MySky user verification as the signature may be
   * verified against the user's public key, which is the MySky user id.
   *
   * @param message - message to sign
   * @returns signature
   */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return await this.connector.connection.remoteHandle().call("signMessage", message);
  }

  /**
   * verifyMessageSignature verifies the signature for the message and given
   * public key and returns a boolean that indicates whether the verification
   * succeeded.
   *
   * @param message - the original message that was signed
   * @param signature - the signature
   * @param publicKey - the public key
   * @returns boolean that indicates whether the verification succeeded
   */
  async verifyMessageSignature(message: Uint8Array, signature: Uint8Array, publicKey: string): Promise<boolean> {
    return await this.connector.connection.remoteHandle().call("verifyMessageSignature", message, signature, publicKey);
  }

  // ================
  // Internal Methods
  // ================

  protected async catchError(errorMsg: string): Promise<void> {
    const event = new CustomEvent(dispatchedErrorEvent, { detail: errorMsg });
    window.dispatchEvent(event);
  }

  protected launchUI(): Window {
    const mySkyUrl = new URL(this.connector.url);
    mySkyUrl.pathname = mySkyUiRelativeUrl;
    const uiUrl = mySkyUrl.toString();

    // Open the window.

    const childWindow = popupCenter(uiUrl, mySkyUiTitle, mySkyUiW, mySkyUiH);
    if (!childWindow) {
      throw new Error(`Could not open window at '${uiUrl}'`);
    }

    return childWindow;
  }

  protected async connectUi(childWindow: Window): Promise<Connection> {
    const options = this.connector.options;

    // Complete handshake with UI window.

    const messenger = new WindowMessenger({
      localWindow: window,
      remoteWindow: childWindow,
      remoteOrigin: "*",
    });
    const methods = {
      catchError: this.catchError,
    };
    const connection = await ParentHandshake(
      messenger,
      methods,
      options.handshakeMaxAttempts,
      options.handshakeAttemptsInterval
    );

    return connection;
  }

  protected async loadDac(dac: DacLibrary): Promise<void> {
    // Initialize DAC.
    await dac.init(this.connector.client, this.connector.options);

    // Add DAC permissions.
    const perms = dac.getPermissions();
    await this.addPermissions(...perms);
  }

  protected async handleLogin(loggedIn: boolean): Promise<void> {
    if (loggedIn) {
      await Promise.all(
        this.dacs.map(async (dac) => {
          try {
            await dac.onUserLogin();
          } catch (error) {
            // Don't throw on error, just print a console warning.
            console.warn(error);
          }
        })
      );
    }
  }

  protected async signRegistryEntry(entry: RegistryEntry, path: string): Promise<Signature> {
    return await this.connector.connection.remoteHandle().call("signRegistryEntry", entry, path);
  }

  protected async signEncryptedRegistryEntry(entry: RegistryEntry, path: string): Promise<Signature> {
    return await this.connector.connection.remoteHandle().call("signEncryptedRegistryEntry", entry, path);
  }
}
