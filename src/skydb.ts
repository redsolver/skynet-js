import { pki } from "node-forge";
import { SkynetClient } from "./client";
import { HashRegistryEntry, PublicKey, SecretKey } from "./crypto";
import { RegistryEntry, SignedRegistryEntry } from "./registry";
import { parseSkylink, promiseTimeout, trimUriPrefix, uriSkynetPrefix } from "./utils";

export async function getJSON(
  this: SkynetClient,
  publicKey: PublicKey,
  dataKey: string
): Promise<Record<string, unknown> | null> {
  // lookup the registry entry
  const entry: SignedRegistryEntry = await this.registry.getEntry(publicKey, dataKey);
  if (entry === null) {
    return null;
  }

  // Download the data in that Skylink
  // TODO: Replace with download request method.
  const skylink = parseSkylink(entry.entry.data);

  const response = await this.executeRequest({
    ...this.customOptions,
    method: "get",
    url: this.getSkylinkUrl(skylink),
  });

  return response.data;
}

export async function setJSON(
  this: SkynetClient,
  privateKey: SecretKey,
  dataKey: string,
  json: Record<string, unknown>,
  revision?: number
) {
  // Upload the data to acquire its skylink
  // TODO: Replace with upload request method.
  const file = new File([JSON.stringify(json)], dataKey, { type: "application/json" });
  const { skylink } = await this.uploadFileRequest(file, this.customOptions);

  const publicKey = pki.ed25519.publicKeyFromPrivateKey({ privateKey });
  if (!revision) {
    // fetch the current value to find out the revision.
    const entry = await this.registry.getEntry(publicKey, dataKey);

    if (entry) {
      // verify here
      if (
        !pki.ed25519.verify({
          message: HashRegistryEntry(entry.entry),
          signature: entry.signature,
          publicKey,
        })
      ) {
        throw new Error("could not verify signature");
      }

      revision = entry.revision + 1;
    } else {
      revision = 0;
    }
  }

  // build the registry value
  const entry: RegistryEntry = {
    datakey: dataKey,
    data: trimUriPrefix(skylink, uriSkynetPrefix),
    revision,
  };

  // sign it
  const signature = pki.ed25519.sign({
    message: HashRegistryEntry(entry),
    privateKey,
  });

  // update the registry
  await this.registry.setEntry(publicKey, dataKey, entry, signature);
}
